// Bottom-up summary plan (SPEC §Algorithm 2): what is missing for a path, in
// leaves-first order, with ancestors added while their other children are
// already summarized. Only `cairn summarize` builds and runs a plan.
import type { TreeEntry } from "../../git/index.js";
import { cacheKey } from "../cache.js";
import { checkIndexable, MAX_INDEXABLE_BYTES } from "../ignore.js";
import type { SnapshotListing } from "../map.js";
import { scanForSecrets, SECRET_PATTERNS } from "../secrets.js";
import { isSupported } from "../skeleton/extract.js";
import { langForPath, skeletonFor } from "../skeleton/index.js";
import { estimateTokens } from "../tokens.js";
import type { SkeletonSymbol } from "../types.js";
import type { Workspace } from "../workspace.js";
import { filePrompt, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompts.js";

const README = /^readme(?:[._-][^/]*)?\.(?:md|markdown)$/i;

export type SkipReason = "too-large" | "binary" | "secret" | "no-content";

export interface FileNode {
  kind: "file";
  path: string;
  hash: string;
  key: string;
  lang: string;
  skeleton: SkeletonSymbol[] | null;
  prompt: string;
  sourceTokens: number;
}

export interface FolderNode {
  kind: "folder";
  path: string;
  hash: string;
  key: string;
  /** Direct children, in tree order, with what's needed to build the prompt. */
  children: { name: string; kind: "blob" | "tree"; hash: string; path: string; summarizable: boolean }[];
}

export type PlanNode = FileNode | FolderNode;

export interface Plan {
  generator: string;
  root: string;
  /** Nodes that need a call, leaves first: every child precedes its folder. */
  nodes: PlanNode[];
  /** Summaries already cached (files and folders), counted, not listed. */
  cached: number;
  skipped: { path: string; reason: SkipReason; pattern?: string }[];
  /** Set when climbing towards the root stopped, with the folder that blocked it. */
  stoppedAt: string | null;
  estimate: { calls: number; inputTokens: number; outputTokens: number };
}

/** Output tokens assumed per call for the estimate (summaries are 1-3 sentences). */
export const EST_OUTPUT_TOKENS = 150;
/** Input tokens assumed per folder child line (names + a short summary). */
const EST_TOKENS_PER_CHILD = 60;

export function isSummarizable(path: string): boolean {
  const lang = langForPath(path);
  if (lang && isSupported(lang)) return true;
  return README.test(path.slice(path.lastIndexOf("/") + 1));
}

export function fileSummaryKey(hash: string, generator: string): string {
  return cacheKey({ kind: "blob", hash, layer: "summary", generator });
}

export function folderSummaryKey(hash: string, generator: string): string {
  return cacheKey({ kind: "tree", hash, layer: "summary", generator });
}

interface Dir {
  path: string;
  hash: string;
  blobs: TreeEntry[];
  dirs: Dir[];
}

function buildDirs(listing: SnapshotListing): Map<string, Dir> {
  const dirs = new Map<string, Dir>([["", { path: "", hash: listing.tree, blobs: [], dirs: [] }]]);
  const ensure = (path: string): Dir => {
    let d = dirs.get(path);
    if (d) return d;
    const parent = ensure(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
    d = { path, hash: listing.trees.get(path) ?? "", blobs: [], dirs: [] };
    dirs.set(path, d);
    parent.dirs.push(d);
    return d;
  };
  for (const b of listing.blobs) ensure(b.path.includes("/") ? b.path.slice(0, b.path.lastIndexOf("/")) : "").blobs.push(b);
  return dirs;
}

export interface PlanOptions {
  /** Repo-relative folder or file ("" for the whole repo). */
  root: string;
  generator: string;
  sourceLines: number;
}

export async function buildPlan(ws: Workspace, listing: SnapshotListing, opts: PlanOptions): Promise<Plan> {
  const dirs = buildDirs(listing);
  const blobsByPath = new Map(listing.blobs.map((b) => [b.path, b]));
  const nodes: PlanNode[] = [];
  const skipped: Plan["skipped"] = [];
  let cached = 0;

  const hasCached = (key: string, kind: "blob" | "tree", hash: string) =>
    ws.cache.get({ kind, hash, layer: "summary", generator: opts.generator }).then((e) => e !== null && e.key === key);

  /** Plans one file; returns whether it will have a summary (cached or planned). */
  const planFile = async (b: TreeEntry): Promise<boolean> => {
    const key = fileSummaryKey(b.hash, opts.generator);
    if (await hasCached(key, "blob", b.hash)) {
      cached++;
      return true;
    }
    if (b.size !== null && b.size > MAX_INDEXABLE_BYTES) {
      skipped.push({ path: b.path, reason: "too-large" });
      return false;
    }
    const content = await ws.blobs.read(b.hash);
    const verdict = checkIndexable(content.length, content);
    if (!verdict.ok) {
      skipped.push({ path: b.path, reason: verdict.reason, ...(verdict.reason === "secret" ? { pattern: verdict.pattern } : {}) });
      return false;
    }
    const text = content.toString("utf8");
    const lines = text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    if (text.trim() === "") {
      skipped.push({ path: b.path, reason: "no-content" });
      return false;
    }
    const lang = langForPath(b.path);
    let skeleton: SkeletonSymbol[] | null = null;
    if (lang && isSupported(lang)) {
      const sk = await skeletonFor({ path: b.path, hash: b.hash, size: b.size }, ws.skeletonDeps);
      skeleton = sk.status === "ok" ? (sk.entry.skeleton ?? []) : [];
    }
    const prompt = filePrompt({
      path: b.path,
      lang: lang ?? "markdown",
      skeleton,
      head: lines.slice(0, opts.sourceLines).join("\n"),
      totalLines: lines.length,
      sourceLines: opts.sourceLines,
    });
    // SPEC §Security: scan exactly what would be sent. Checked again before the call.
    const [hit] = scanForSecrets(`${SYSTEM_PROMPT}\n${prompt}`, SECRET_PATTERNS);
    if (hit) {
      skipped.push({ path: b.path, reason: "secret", pattern: hit.pattern });
      return false;
    }
    nodes.push({ kind: "file", path: b.path, hash: b.hash, key, lang: lang ?? "markdown", skeleton, prompt, sourceTokens: estimateTokens(text) });
    return true;
  };

  /** Plans a folder and everything below it; returns whether it will have a summary. */
  const planDir = async (d: Dir): Promise<boolean> => {
    const key = folderSummaryKey(d.hash, opts.generator);
    if (await hasCached(key, "tree", d.hash)) {
      cached++;
      return true; // its children's summaries live inside the entry
    }
    const children: FolderNode["children"] = [];
    for (const sub of [...d.dirs].sort((a, b) => cmp(a.path, b.path))) {
      children.push({ name: base(sub.path), kind: "tree", hash: sub.hash, path: sub.path, summarizable: await planDir(sub) });
    }
    for (const b of [...d.blobs].sort((a, c) => cmp(a.path, c.path))) {
      children.push({ name: base(b.path), kind: "blob", hash: b.hash, path: b.path, summarizable: isSummarizable(b.path) && (await planFile(b)) });
    }
    if (!children.some((c) => c.summarizable)) return false;
    nodes.push({ kind: "folder", path: d.path, hash: d.hash, key, children });
    return true;
  };

  let stoppedAt: string | null = null;
  const single = blobsByPath.get(opts.root);
  const rootDir = dirs.get(opts.root);
  if (single) {
    if (isSummarizable(single.path)) await planFile(single);
  } else if (rootDir) {
    await planDir(rootDir);
  }

  // Climb to the repo root while every other child of each ancestor is summarized.
  let below = single ? single.path : opts.root;
  while (below !== "") {
    const parentPath = below.includes("/") ? below.slice(0, below.lastIndexOf("/")) : "";
    const parent = dirs.get(parentPath);
    if (!parent) break;
    const pkey = folderSummaryKey(parent.hash, opts.generator);
    if (await hasCached(pkey, "tree", parent.hash)) break;
    const children: FolderNode["children"] = [];
    let ready = true;
    for (const sub of [...parent.dirs].sort((a, b) => cmp(a.path, b.path))) {
      if (sub.path === below) {
        children.push({ name: base(sub.path), kind: "tree", hash: sub.hash, path: sub.path, summarizable: nodes.some((n) => n.path === sub.path) || (await hasCached(folderSummaryKey(sub.hash, opts.generator), "tree", sub.hash)) });
        continue;
      }
      const has = await hasCached(folderSummaryKey(sub.hash, opts.generator), "tree", sub.hash);
      if (!has && hasSummarizableDescendant(sub)) ready = false;
      children.push({ name: base(sub.path), kind: "tree", hash: sub.hash, path: sub.path, summarizable: has });
    }
    for (const b of [...parent.blobs].sort((a, c) => cmp(a.path, c.path))) {
      if (b.path === below) {
        children.push({ name: base(b.path), kind: "blob", hash: b.hash, path: b.path, summarizable: nodes.some((n) => n.path === b.path) || (await hasCached(fileSummaryKey(b.hash, opts.generator), "blob", b.hash)) });
        continue;
      }
      const has = isSummarizable(b.path) && (await hasCached(fileSummaryKey(b.hash, opts.generator), "blob", b.hash));
      if (!has && isSummarizable(b.path)) ready = false;
      children.push({ name: base(b.path), kind: "blob", hash: b.hash, path: b.path, summarizable: has });
    }
    if (!ready) {
      stoppedAt = parentPath;
      break;
    }
    if (children.some((c) => c.summarizable)) nodes.push({ kind: "folder", path: parentPath, hash: parent.hash, key: pkey, children });
    below = parentPath;
  }

  const inputTokens = nodes.reduce(
    (n, node) => n + estimateTokens(SYSTEM_PROMPT) + (node.kind === "file" ? estimateTokens(node.prompt) : 20 + node.children.length * EST_TOKENS_PER_CHILD),
    0,
  );
  return {
    generator: opts.generator,
    root: opts.root,
    nodes,
    cached,
    skipped,
    stoppedAt,
    estimate: { calls: nodes.length, inputTokens, outputTokens: nodes.length * EST_OUTPUT_TOKENS },
  };
}

function hasSummarizableDescendant(d: Dir): boolean {
  return d.blobs.some((b) => isSummarizable(b.path)) || d.dirs.some(hasSummarizableDescendant);
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export { PROMPT_VERSION };
