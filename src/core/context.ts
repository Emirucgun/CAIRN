// `cairn context` (SPEC §Algorithm 3): what changed since this agent last
// looked, plus a repo map. Records (step 6) arrive in v0.3. The cursor is
// advanced separately, by advanceCursor(), only after the output is delivered.
import { commitsBetween, type CommitInfo, countCommits, diffTree, diffTreePatch, objectAt, objectExists } from "../git/index.js";
import { checkIndexable, MAX_INDEXABLE_BYTES } from "./ignore.js";
import { buildMap, type MapResult, snapshotListing } from "./map.js";
import { type ResolvedAgent, readCursor, writeCursor } from "./sessions.js";
import { skeletonFor } from "./skeleton/index.js";
import type { SessionCursor, SkeletonSymbol } from "./types.js";
import type { Workspace } from "./workspace.js";

/** Files that get a full diff or skeleton; the rest are listed by name. */
export const MAX_DETAILED_FILES = 40;
/** Files listed by name after the detailed ones; beyond this only a count. */
export const MAX_LISTED_FILES = 200;
/** Folders whose symbols are added to the map because something in them changed. */
export const MAX_TOUCHED_FOLDERS = 10;
export const MAX_COMMITS = 20;

export type ChangeDetail =
  | { kind: "diff"; patch: string; added: number; removed: number }
  /** Diff over max_diff_lines: the new skeleton instead, and a pointer to read it. */
  | { kind: "skeleton"; symbols: SkeletonSymbol[]; diffLines: number }
  | { kind: "withheld"; reason: "secret" | "binary" | "too-large" }
  | { kind: "deleted" }
  | { kind: "listed" };

export interface ContextChange {
  status: "A" | "M" | "D" | "T";
  path: string;
  detail: ChangeDetail;
}

export type FirstReason = "new-agent" | "cursor-unreadable" | "snapshot-pruned";

export interface ContextResult {
  agent: ResolvedAgent;
  now: { tree: string; head: string | null };
  /** null on an agent's first session (or when the previous snapshot is gone). */
  since: { tree: string; head: string | null; seen: string; activeTask: string | null } | null;
  firstReason: FirstReason | null;
  commits: CommitInfo[];
  commitCount: number;
  /** The previous HEAD no longer exists (rebase + gc), so commits can't be listed. */
  historyRewritten: boolean;
  changes: ContextChange[];
  /** Changes beyond MAX_LISTED_FILES, counted only. */
  moreChanges: number;
  map: MapResult;
  /** Extra maps for folders with changes (empty on a first session). */
  touched: MapResult[];
  /** Session, task and decision records: v0.3. */
  records: [];
}

export async function buildContext(ws: Workspace, agent: ResolvedAgent): Promise<ContextResult> {
  const listing = await snapshotListing(ws);
  const now = { tree: listing.tree, head: listing.head };
  const read = await readCursor(ws.paths.sessions, agent.id);

  let firstReason: FirstReason | null = null;
  let cursor: SessionCursor | null = null;
  if (read.status === "none") firstReason = "new-agent";
  else if (read.status === "unreadable") {
    firstReason = "cursor-unreadable";
    ws.warnings.push(`session cursor for ${agent.id} was unreadable (${read.detail}); starting fresh`);
  } else if (!(await objectExists(ws.repo, read.cursor.last_snapshot_tree))) {
    firstReason = "snapshot-pruned";
  } else {
    cursor = read.cursor;
  }

  const base = {
    agent,
    now,
    records: [] as [],
  };

  if (!cursor) {
    const map = await buildMap(ws, { path: ws.repo.root, from: listing });
    return { ...base, since: null, firstReason, commits: [], commitCount: 0, historyRewritten: false, changes: [], moreChanges: 0, map, touched: [] };
  }

  const since = { tree: cursor.last_snapshot_tree, head: cursor.last_head, seen: cursor.last_seen, activeTask: cursor.active_task };
  const headMoved = now.head !== null && now.head !== cursor.last_head;
  // last_head null means the repo had no commits then: every commit is new.
  const historyRewritten = headMoved && cursor.last_head !== null && !(await objectExists(ws.repo, cursor.last_head));
  const [commits, commitCount] =
    headMoved && !historyRewritten
      ? await Promise.all([
          commitsBetween(ws.repo, cursor.last_head, now.head as string, MAX_COMMITS),
          countCommits(ws.repo, cursor.last_head, now.head as string),
        ])
      : [[], 0];

  const raw = since.tree === now.tree ? [] : await diffTree(ws.repo, since.tree, now.tree);
  const sizes = new Map(listing.blobs.map((b) => [b.path, b]));
  const changes: ContextChange[] = [];
  let detailed = 0;
  for (const c of raw) {
    if (changes.length >= MAX_LISTED_FILES) break;
    const status = c.status === "R" || c.status === "C" ? "A" : c.status;
    if (status === "D") {
      changes.push({ status, path: c.path, detail: { kind: "deleted" } });
      continue;
    }
    if (detailed >= MAX_DETAILED_FILES) {
      changes.push({ status, path: c.path, detail: { kind: "listed" } });
      continue;
    }
    detailed++;
    changes.push({ status, path: c.path, detail: await describeChange(ws, since.tree, now.tree, c.path, status, sizes.get(c.path)) });
  }

  const map = await buildMap(ws, { path: ws.repo.root, depth: 1, from: listing });
  const touched: MapResult[] = [];
  const folders = [...new Set(changes.filter((c) => c.status !== "D").map((c) => c.path.slice(0, Math.max(0, c.path.lastIndexOf("/")))))]
    .filter((f) => f !== "")
    .slice(0, MAX_TOUCHED_FOLDERS);
  for (const folder of folders) touched.push(await buildMap(ws, { path: `${ws.repo.root}/${folder}`, depth: 1, from: listing }));

  return {
    ...base,
    since,
    firstReason: null,
    commits,
    commitCount,
    historyRewritten,
    changes,
    moreChanges: raw.length - changes.length,
    map,
    touched,
  };
}

async function describeChange(
  ws: Workspace,
  fromTree: string,
  toTree: string,
  path: string,
  status: "A" | "M" | "T",
  entry: { hash: string; size: number | null } | undefined,
): Promise<ChangeDetail> {
  if (!entry) return { kind: "listed" };
  if (entry.size !== null && entry.size > MAX_INDEXABLE_BYTES) return { kind: "withheld", reason: "too-large" };

  // A diff shows content, so both sides must pass the same checks as a read.
  const sides = [entry.hash];
  if (status !== "A") {
    const oldHash = await objectAt(ws.repo, fromTree, path);
    if (oldHash) sides.push(oldHash);
  }
  for (const hash of sides) {
    const content = await ws.blobs.read(hash);
    const verdict = checkIndexable(content.length, content);
    if (!verdict.ok && verdict.reason === "secret") {
      ws.warnings.push(`withheld the diff of ${path}: looks like it contains a secret (${verdict.pattern})`);
      return { kind: "withheld", reason: "secret" };
    }
    if (!verdict.ok) return { kind: "withheld", reason: verdict.reason };
  }

  const patch = await diffTreePatch(ws.repo, fromTree, toTree, [path]);
  const body = patch.split("\n").filter((l) => l !== "");
  const added = body.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removed = body.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  if (body.length <= ws.config.context.max_diff_lines) return { kind: "diff", patch, added, removed };

  const sk = await skeletonFor({ path, hash: entry.hash, size: entry.size }, ws.skeletonDeps);
  return { kind: "skeleton", symbols: sk.status === "ok" ? (sk.entry.skeleton ?? []) : [], diffLines: body.length };
}

/** SPEC §Algorithm 3 step 7: called only after the output has been delivered. */
export async function advanceCursor(ws: Workspace, result: ContextResult, now = new Date()): Promise<void> {
  await writeCursor(ws.paths.sessions, {
    schema: 1,
    agent: result.agent.id,
    last_snapshot_tree: result.now.tree,
    last_head: result.now.head,
    last_seen: now.toISOString(),
    active_task: result.since?.activeTask ?? null,
  });
}

