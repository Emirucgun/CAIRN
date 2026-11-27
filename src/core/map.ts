// `cairn map [path] [--depth n]` (SPEC §CLI): a tree of folders with the
// symbols of each file, from the working-tree snapshot. No LLM involved;
// summaries are added in v0.2.
import { lsTree, type TreeEntry } from "../git/index.js";
import { type SkeletonResult, type SkipReason, skeletonFor } from "./skeleton/index.js";
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
  summary: null;
}

export interface MapFolder {
  kind: "folder";
  path: string;
  name: string;
  files: number;
  tokens: number;
  /** null when the folder is beyond --depth and shown collapsed. */
  children: MapNode[] | null;
  summary: null;
}

export type MapNode = MapFile | MapFolder;

export interface MapResult {
  root: MapNode;
  tree: string;
  depth: number;
  stats: { files: number; parsed: number; cached: number; skipped: number; ms: number };
}

export class PathNotInSnapshotError extends Error {
  constructor(readonly path: string) {
    super(`${path || "."} is not in the snapshot: it doesn't exist, or git, .cairnignore or a built-in deny excludes it`);
    this.name = "PathNotInSnapshotError";
  }
}

export const DEFAULT_MAP_DEPTH = 2;
export const DEFAULT_MAX_SYMBOLS = 40;

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

  const snap = await snapshot(ws.repo, { paths: ws.paths });
  const entries = (await lsTree(ws.repo, snap.tree, { recursive: true })).filter((e) => e.type === "blob");
  const tree = toDirTree(entries);

  // Locate the requested root: a folder, or a single file.
  const single = entries.find((e) => e.path === rootPath);
  const rootDir = single ? null : findDir(tree, rootPath);
  if (!single && !rootDir) throw new PathNotInSnapshotError(rootPath);

  // Files whose symbols are shown: those within depth (or the single file).
  const shown = single ? [single] : collectShown(rootDir as Dir, depth);
  const stats = { files: shown.length, parsed: 0, cached: 0, skipped: 0, ms: 0 };
  const results = new Map<string, SkeletonResult>();
  await mapLimit(shown, 16, async (e) => {
    const r = await skeletonFor({ path: e.path, hash: e.hash, size: e.size }, ws.skeletonDeps);
    results.set(e.path, r);
    if (r.status === "ok") stats[r.cached ? "cached" : "parsed"]++;
    else stats.skipped++;
  });

  const fileNode = (e: TreeEntry): MapFile => {
    const r = results.get(e.path);
    const all = r?.status === "ok" ? (r.entry.skeleton ?? []) : [];
    const visible = opts.all ? all : all.filter((s) => s.exported);
    const symbols = visible.slice(0, maxSymbols);
    return {
      kind: "file",
      path: e.path,
      name: e.path.slice(e.path.lastIndexOf("/") + 1),
      tokens: Math.ceil((e.size ?? 0) / 4),
      lang: r?.status === "ok" ? r.entry.lang : null,
      symbols,
      hiddenSymbols: all.length - symbols.length,
      skipped: r?.status === "skipped" && r.reason !== "unsupported" ? r.reason : null,
      summary: null,
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
    summary: null,
  });

  const root = single ? fileNode(single) : folderNode(rootDir as Dir, 0);
  stats.ms = Math.round(performance.now() - t0);
  return { root, tree: snap.tree, depth, stats };
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
 * Files directly inside expanded folders. The root is level 0 and always
 * expanded; a folder at level L is expanded when L < depth (the same rule
 * folderNode uses).
 */
function collectShown(dir: Dir, depth: number): TreeEntry[] {
  const out: TreeEntry[] = [];
  const walk = (d: Dir, level: number) => {
    out.push(...d.files);
    for (const c of d.dirs.values()) if (level + 1 < depth) walk(c, level + 1);
  };
  walk(dir, 0);
  return out;
}
