// `cairn map [path] [--depth n]` (SPEC §CLI): a tree of folders with the
// symbols of each file, from the working-tree snapshot. No LLM involved;
// summaries are added in v0.2.
import { lsTree, type TreeEntry } from "../git/index.js";
import { extractSkeleton } from "./skeleton/extract.js";
import { folderSkeleton, type SkeletonDeps, type SkipReason, skeletonFor } from "./skeleton/index.js";
import { ParsePool } from "./skeleton/pool.js";
import { isSummarizable } from "./summarize/plan.js";
import { configuredSummaryGenerator } from "./summarize/prompts.js";
import { snapshot } from "./snapshot.js";
import type { SkeletonSymbol } from "./types.js";
import { mapLimit, PathOutsideRepoError, toRepoPath, type Workspace } from "./workspace.js";

export interface MapOptions {
  /** Path relative to the command's directory; default is that directory. */
  path?: string;
  /** Folder levels shown expanded, counting the root as 1. Default 2: the root and its subfolders. */
  depth?: number;
  /** Include non-exported symbols. */
  all?: boolean;
  /** Max symbols listed per file. */
  maxSymbols?: number;
  /** Reuse a snapshot already taken (and its blob listing) instead of taking a new one. */
  from?: SnapshotListing;
}

export interface SnapshotListing {
  tree: string;
  /** Every blob in the tree (ls-tree -r). */
  blobs: TreeEntry[];
  /** Tree hash of every folder, by repo-relative path. */
  trees: Map<string, string>;
}

/** Takes a snapshot and lists its blobs, for commands that need both. */
export async function snapshotListing(ws: Workspace): Promise<SnapshotListing & { head: string | null }> {
  const snap = await snapshot(ws.repo, { paths: ws.paths });
  const all = await lsTree(ws.repo, snap.tree, { recursive: true, includeTrees: true });
  const blobs = all.filter((e) => e.type === "blob");
  const trees = new Map(all.filter((e) => e.type === "tree").map((e) => [e.path, e.hash]));
  return { tree: snap.tree, head: snap.head, blobs, trees };
}

export interface MapFile {
  kind: "file";
  path: string;
  name: string;
  /** Estimated source tokens (bytes / 4). */
  tokens: number;
  lang: string | null;
  symbols: SkeletonSymbol[];
  /** Symbols left out by the --all filter or the per-file cap. */
  hiddenSymbols: number;
  /** Why a supported-looking file has no skeleton; unsupported languages are not flagged. */
  skipped: Exclude<SkipReason, "unsupported"> | null;
  summary: SummaryRef | null;
}

export interface MapFolder {
  kind: "folder";
  path: string;
  name: string;
  files: number;
  tokens: number;
  /** null when the folder is beyond --depth and shown collapsed. */
  children: MapNode[] | null;
  summary: SummaryRef | null;
}

export type MapNode = MapFile | MapFolder;

/** A cached summary, labelled with the git object hash it was built from (SPEC §Failure modes). */
export interface SummaryRef {
  text: string;
  /** Blob or tree hash of the content summarized. */
  hash: string;
}

export interface MapResult {
  root: MapNode;
  tree: string;
  depth: number;
  stats: { files: number; parsed: number; cached: number; skipped: number; ms: number };
  /** Summaries shown, and folders shown without one, when a summarizer is configured. */
  summaries: { generator: string; shown: number; foldersMissing: number } | null;
}

export class PathNotInSnapshotError extends Error {
  constructor(readonly path: string) {
    super(`${path || "."} is not in the snapshot: it doesn't exist, or git, .cairnignore or a built-in deny excludes it`);
    this.name = "PathNotInSnapshotError";
  }
}

export const DEFAULT_MAP_DEPTH = 2;
export const DEFAULT_MAX_SYMBOLS = 40;
/** Files shown at or above which parsing moves to worker threads. */
export const POOL_THRESHOLD = 300;
/** Cache misses parsed inline before the worker pool is started. */
export const INLINE_PARSES = 32;
/** Per-file summary reads allowed for folders that have no folder summary entry. */
export const MAX_FALLBACK_READS = 300;

interface Dir {
  path: string;
  dirs: Map<string, Dir>;
  files: TreeEntry[];
  fileCount: number;
  bytes: number;
}

export async function buildMap(ws: Workspace, opts: MapOptions = {}): Promise<MapResult> {
  const t0 = performance.now();
  const depth = Math.max(1, opts.depth ?? DEFAULT_MAP_DEPTH);
  const maxSymbols = opts.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const rootPath = toRepoPath(ws.repo, opts.path ?? ".", ws.cwdInRepo);
  if (rootPath === null) throw new PathOutsideRepoError(opts.path ?? ".");

  const listing = opts.from ?? (await snapshotListing(ws));
  const entries = listing.blobs;
  const tree = toDirTree(entries);

  // Locate the requested root: a folder, or a single file.
  const single = entries.find((e) => e.path === rootPath);
  const rootDir = single ? null : findDir(tree, rootPath);
  if (!single && !rootDir) throw new PathNotInSnapshotError(rootPath);

  // Folders shown expanded; their direct files get symbols (or the single file).
  const expanded = single ? [] : collectExpanded(rootDir as Dir, depth);
  const shownCount = single ? 1 : expanded.reduce((n, d) => n + d.files.length, 0);
  const stats = { files: shownCount, parsed: 0, cached: 0, skipped: 0, ms: 0 };
  const known = new Map<string, { lang: string | null; skeleton: SkeletonSymbol[] | null; skipped: MapFile["skipped"] }>();

  // Worker threads only pay off for big batches. The first INLINE_PARSES
  // parses happen inline, so an edit or two never pays for starting workers.
  const pool = shownCount >= POOL_THRESHOLD ? new ParsePool() : null;
  let parses = 0;
  const deps: SkeletonDeps = pool
    ? { ...ws.skeletonDeps, extract: (l, src) => (++parses <= INLINE_PARSES ? extractSkeleton(l, src) : pool.extract(l, src)) }
    : ws.skeletonDeps;
  try {
    if (single) {
      const r = await skeletonFor({ path: single.path, hash: single.hash, size: single.size }, deps);
      if (r.status === "ok") stats[r.cached ? "cached" : "parsed"]++;
      else if (r.reason !== "unsupported") stats.skipped++;
      known.set(single.path, {
        lang: r.status === "ok" ? r.entry.lang : null,
        skeleton: r.status === "ok" ? r.entry.skeleton : null,
        skipped: r.status === "skipped" && r.reason !== "unsupported" ? r.reason : null,
      });
    } else {
      await mapLimit(expanded, pool ? 16 : 8, async (d) => {
        const hash = d.path === "" ? listing.tree : listing.trees.get(d.path);
        if (!hash) return;
        const subtrees = [...d.dirs.values()].map((c) => ({ mode: "040000", type: "tree" as const, hash: listing.trees.get(c.path) ?? "", path: c.path, size: null }));
        const r = await folderSkeleton({ path: d.path, hash, entries: [...d.files, ...subtrees.filter((t) => t.hash)] }, deps);
        stats.parsed += r.parsed;
        stats.cached += r.cached ? (r.entry?.files?.length ?? 0) : r.reused;
        for (const f of r.entry?.files ?? []) {
          if (f.skipped) stats.skipped++;
          known.set(d.path === "" ? f.name : `${d.path}/${f.name}`, { lang: f.lang, skeleton: f.skeleton, skipped: f.skipped });
        }
      });
    }
  } finally {
    await pool?.close();
  }

  // Cached summaries only (SPEC §Algorithm 2 step 3): never a call. One read per
  // folder shown; an expanded folder's entry also carries its files' summaries.
  const generator = configuredSummaryGenerator(ws.config.summarizer);
  const summaries = new Map<string, SummaryRef>();
  let foldersMissing = 0;
  let fallbackReads = 0;
  if (generator) {
    const lookup = async (kind: "blob" | "tree", hash: string) => ws.cache.get({ kind, hash, layer: "summary", generator });
    if (single) {
      const e = await lookup("blob", single.hash);
      if (e?.summary) summaries.set(single.path, { text: e.summary, hash: single.hash });
    } else {
      const shownDirs = new Map<string, boolean>(); // path -> expanded
      for (const d of expanded) {
        shownDirs.set(d.path, true);
        for (const c of d.dirs.values()) if (!shownDirs.has(c.path)) shownDirs.set(c.path, false);
      }
      for (const [path, isExpanded] of shownDirs) {
        const hash = path === "" ? listing.tree : listing.trees.get(path);
        if (!hash) continue;
        const e = await lookup("tree", hash);
        if (!e?.summary) {
          if (!summaries.has(path)) foldersMissing++;
          // No current folder entry (e.g. right after an edit): unchanged files keep
          // their own entries. Bounded so a big, partly summarized map stays fast.
          const d = isExpanded ? expanded.find((x) => x.path === path) : undefined;
          for (const f of d?.files ?? []) {
            if (fallbackReads >= MAX_FALLBACK_READS || !isSummarizable(f.path)) continue;
            fallbackReads++;
            const fe = await lookup("blob", f.hash);
            if (fe?.summary) summaries.set(f.path, { text: fe.summary, hash: f.hash });
          }
          continue;
        }
        summaries.set(path, { text: e.summary, hash });
        if (isExpanded) {
          for (const c of e.children ?? []) {
            if (c.summary) summaries.set(path === "" ? c.name : `${path}/${c.name}`, { text: c.summary, hash: c.hash });
          }
        }
      }
    }
  }

  const fileNode = (e: TreeEntry): MapFile => {
    const k = known.get(e.path);
    const all = k?.skeleton ?? [];
    const visible = opts.all ? all : all.filter((s) => s.exported);
    const symbols = visible.slice(0, maxSymbols);
    return {
      kind: "file",
      path: e.path,
      name: e.path.slice(e.path.lastIndexOf("/") + 1),
      tokens: Math.ceil((e.size ?? 0) / 4),
      lang: k?.lang ?? null,
      symbols,
      hiddenSymbols: all.length - symbols.length,
      skipped: k?.skipped ?? null,
      summary: summaries.get(e.path) ?? null,
    };
  };

  const folderNode = (d: Dir, level: number): MapFolder => ({
    kind: "folder",
    path: d.path,
    name: d.path === "" ? "." : d.path.slice(d.path.lastIndexOf("/") + 1),
    files: d.fileCount,
    tokens: Math.ceil(d.bytes / 4),
    children:
      level < depth
        ? [
            ...[...d.dirs.values()].sort(byPath).map((c) => folderNode(c, level + 1)),
            ...d.files.sort(byPath).map(fileNode),
          ]
        : null,
    summary: summaries.get(d.path) ?? null,
  });

  const root = single ? fileNode(single) : folderNode(rootDir as Dir, 0);
  stats.ms = Math.round(performance.now() - t0);
  return { root, tree: listing.tree, depth, stats, summaries: generator ? { generator, shown: summaries.size, foldersMissing } : null };
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function toDirTree(entries: readonly TreeEntry[]): Dir {
  const root: Dir = { path: "", dirs: new Map(), files: [], fileCount: 0, bytes: 0 };
  for (const e of entries) {
    const parts = e.path.split("/");
    let d = root;
    d.fileCount++;
    d.bytes += e.size ?? 0;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i] as string;
      let child = d.dirs.get(name);
      if (!child) {
        child = { path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [], fileCount: 0, bytes: 0 };
        d.dirs.set(name, child);
      }
      d = child;
      d.fileCount++;
      d.bytes += e.size ?? 0;
    }
    d.files.push(e);
  }
  return root;
}

function findDir(root: Dir, path: string): Dir | null {
  if (path === "") return root;
  let d: Dir | undefined = root;
  for (const part of path.split("/")) {
    d = d.dirs.get(part);
    if (!d) return null;
  }
  return d;
}

/**
 * Folders shown expanded. The root is level 0 and always expanded; a folder
 * at level L is expanded when L < depth (the same rule folderNode uses).
 */
function collectExpanded(dir: Dir, depth: number): Dir[] {
  const out: Dir[] = [];
  const walk = (d: Dir, level: number) => {
    out.push(d);
    for (const c of d.dirs.values()) if (level + 1 < depth) walk(c, level + 1);
  };
  walk(dir, 0);
  return out;
}
