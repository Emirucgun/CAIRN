import { runGit, runGitBuffer } from "./exec.js";
import type { Repo } from "./repo.js";

export type ObjectType = "blob" | "tree" | "commit";

export interface TreeEntry {
  mode: string;
  type: ObjectType;
  hash: string;
  /** Repo-relative path with forward slashes. */
  path: string;
  /** Blob size in bytes; null for trees and submodule commits. */
  size: number | null;
}

export interface LsTreeOptions {
  /** Recurse into subtrees (-r). */
  recursive?: boolean;
  /** With recursive, also list the trees themselves (-t). */
  includeTrees?: boolean;
  /** Restrict to these paths (pathspecs are literal). */
  paths?: readonly string[];
}

const LS_TREE_FORMAT = "%(objectmode) %(objecttype) %(objectname) %(objectsize)%x09%(path)";

export function parseLsTree(out: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, hash, size] = record.slice(0, tab).split(" ");
    if (!mode || !type || !hash || size === undefined) throw new Error(`unexpected ls-tree record: ${record}`);
    entries.push({
      mode,
      type: type as ObjectType,
      hash,
      path: record.slice(tab + 1),
      size: size === "-" ? null : Number(size),
    });
  }
  return entries;
}

export async function lsTree(repo: Repo, treeish: string, opts: LsTreeOptions = {}): Promise<TreeEntry[]> {
  const args = ["ls-tree", "-z", `--format=${LS_TREE_FORMAT}`];
  if (opts.recursive) args.push("-r");
  if (opts.recursive && opts.includeTrees) args.push("-t");
  args.push("--end-of-options", treeish);
  if (opts.paths?.length) args.push("--", ...opts.paths.map((p) => `:(literal)${p}`));
  const { stdout } = await runGit(args, { cwd: repo.root });
  return parseLsTree(stdout);
}

export type ChangeStatus = "A" | "M" | "D" | "T" | "R" | "C";

export interface TreeChange {
  status: ChangeStatus;
  path: string;
  /** Source path for renames and copies. */
  from?: string;
  /** Similarity percentage for renames and copies. */
  score?: number;
}

export function parseNameStatus(out: string): TreeChange[] {
  const fields = out.split("\0");
  const changes: TreeChange[] = [];
  let i = 0;
  while (i < fields.length) {
    const code = fields[i++];
    if (!code) continue;
    const status = code[0] as ChangeStatus;
    if (status === "R" || status === "C") {
      const from = fields[i++];
      const to = fields[i++];
      if (from === undefined || to === undefined) throw new Error("truncated diff-tree output");
      changes.push({ status, from, path: to, score: Number(code.slice(1)) });
    } else {
      const path = fields[i++];
      if (path === undefined) throw new Error("truncated diff-tree output");
      changes.push({ status, path });
    }
  }
  return changes;
}

export interface DiffTreeOptions {
  /** Detect renames (-M). Off by default: a rename is then a D plus an A. */
  renames?: boolean;
}

/** Files that differ between two trees (or commits), recursively. */
export async function diffTree(repo: Repo, from: string, to: string, opts: DiffTreeOptions = {}): Promise<TreeChange[]> {
  const args = ["diff-tree", "-r", "-z", "--name-status", opts.renames ? "-M" : "--no-renames", "--end-of-options", from, to];
  return parseNameStatus((await runGit(args, { cwd: repo.root })).stdout);
}

/** Unified diff between two trees, optionally limited to some paths. */
export async function diffTreePatch(repo: Repo, from: string, to: string, paths: readonly string[] = []): Promise<string> {
  const args = ["diff-tree", "-p", "--no-color", "--no-ext-diff", "--no-renames", "--end-of-options", from, to];
  if (paths.length) args.push("--", ...paths.map((p) => `:(literal)${p}`));
  return (await runGit(args, { cwd: repo.root })).stdout;
}

/** Raw bytes of a blob. */
export async function readBlob(repo: Repo, hash: string): Promise<Buffer> {
  return (await runGitBuffer(["cat-file", "blob", hash], { cwd: repo.root })).stdout;
}

/**
 * Hashes work-tree files as blobs without writing them to the object store.
 * Clean filters and line-ending rules apply, so the hash matches what `git add` stores.
 */
export async function hashFiles(repo: Repo, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const { stdout } = await runGit(["hash-object", "--stdin-paths"], {
    cwd: repo.root,
    input: paths.join("\n") + "\n",
  });
  return stdout.trim().split("\n");
}

const emptyTrees = new Map<string, string>();

/** The empty tree's hash for this repo's object format. */
export async function emptyTree(repo: Repo): Promise<string> {
  let hash = emptyTrees.get(repo.objectFormat);
  if (!hash) {
    hash = (await runGit(["hash-object", "-t", "tree", "--stdin"], { cwd: repo.root, input: "" })).stdout.trim();
    emptyTrees.set(repo.objectFormat, hash);
  }
  return hash;
}
