import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { GitError, runGit, runGitBuffer, spawnEnoentError, spawnGit } from "./exec.js";
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

export class MissingObjectError extends Error {
  constructor(readonly hash: string) {
    super(`git object ${hash} is missing`);
    this.name = "MissingObjectError";
  }
}

interface Pending {
  hash: string;
  resolve: (b: Buffer) => void;
  reject: (e: Error) => void;
}

/**
 * Reads many blobs through one `git cat-file --batch` process instead of one
 * process per blob. Requests are answered in order; call close() when done.
 */
export class BlobReader {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> | null = null;
  private readonly queue: Pending[] = [];
  private buf: Buffer = Buffer.alloc(0);
  private failed: Error | null = null;

  constructor(private readonly repo: Repo) {}

  read(hash: string): Promise<Buffer> {
    if (this.failed) return Promise.reject(this.failed);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(hash)) return Promise.reject(new Error(`not an object hash: ${hash}`));
    const proc = this.start();
    return new Promise<Buffer>((resolve, reject) => {
      this.queue.push({ hash, resolve, reject });
      proc.stdin.write(`${hash}\n`);
    });
  }

  /** Ends the batch process and waits until it has really exited (killing it after 2 s). */
  async close(): Promise<void> {
    const proc = this.proc;
    const exited = this.exited;
    this.proc = null;
    this.exited = null;
    if (!proc || !exited) return;
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill("SIGKILL"), 2000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const proc = spawnGit(["cat-file", "--batch"], { cwd: this.repo.root });
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    proc.stdout.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this.drain();
    });
    proc.stdin.on("error", (e) => this.fail(e));
    this.exited = new Promise<void>((resolve) => {
      proc.once("error", (e) => {
        this.fail((e as NodeJS.ErrnoException).code === "ENOENT" ? spawnEnoentError(this.repo.root) : e);
        resolve();
      });
      proc.once("close", (code) => {
        if (this.queue.length) this.fail(new GitError(["cat-file", "--batch"], code ?? undefined, stderr || "exited early"));
        resolve();
      });
    });
    this.proc = proc;
    return proc;
  }

  private drain(): void {
    for (;;) {
      const head = this.queue[0];
      if (!head) return;
      const nl = this.buf.indexOf(10);
      if (nl < 0) return;
      const header = this.buf.subarray(0, nl).toString("utf8");
      if (header.endsWith(" missing")) {
        this.buf = this.buf.subarray(nl + 1);
        this.queue.shift();
        head.reject(new MissingObjectError(head.hash));
        continue;
      }
      const [hash, , sizeText] = header.split(" ");
      const size = Number(sizeText);
      if (!hash || !Number.isInteger(size)) return this.fail(new Error(`unexpected cat-file header: ${header}`));
      if (this.buf.length < nl + 1 + size + 1) return; // wait for the rest
      const body = Buffer.from(this.buf.subarray(nl + 1, nl + 1 + size));
      this.buf = this.buf.subarray(nl + 1 + size + 1);
      this.queue.shift();
      head.resolve(body);
    }
  }

  private fail(e: Error): void {
    this.failed ??= e;
    for (const p of this.queue.splice(0)) p.reject(e);
  }
}

/** Whether an object exists (snapshot trees are unreferenced and can be pruned by `git gc`). */
export async function objectExists(repo: Repo, hash: string): Promise<boolean> {
  const { exitCode } = await runGit(["cat-file", "-e", "--end-of-options", hash], { cwd: repo.root, okExitCodes: [1, 128] });
  return exitCode === 0;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  /** ISO 8601. */
  date: string;
}

/** Commits reachable from `to` but not from `from` (`from..to`), newest first. */
export async function commitsBetween(repo: Repo, from: string | null, to: string, max = 20): Promise<CommitInfo[]> {
  const range = from ? `${from}..${to}` : to;
  const { stdout } = await runGit(["log", "-z", `--max-count=${max}`, "--format=%H%x00%s%x00%an%x00%aI", "--end-of-options", range], {
    cwd: repo.root,
  });
  const f = stdout.split("\0");
  const out: CommitInfo[] = [];
  for (let i = 0; i + 3 < f.length; i += 4) {
    out.push({ hash: (f[i] as string).replace(/^\n/, ""), subject: f[i + 1] as string, author: f[i + 2] as string, date: f[i + 3] as string });
  }
  return out;
}

/** Number of commits in `from..to`. */
export async function countCommits(repo: Repo, from: string | null, to: string): Promise<number> {
  const range = from ? `${from}..${to}` : to;
  return Number((await runGit(["rev-list", "--count", "--end-of-options", range], { cwd: repo.root })).stdout.trim());
}
