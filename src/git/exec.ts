// The only place CAIRN starts the git binary. Everything else in src/git/
// builds on runGit(); nothing outside src/git/ calls git directly.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { execa } from "execa";

export const MIN_GIT_VERSION = [2, 38, 0] as const;

/**
 * Variables that would make git act on a different repo, work tree or index
 * than the one CAIRN asked for. They are set inside git hooks, which is
 * exactly where the generic post-commit adapter will run us, so they are
 * always removed and the repo is chosen by `cwd` alone.
 */
const STRIPPED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
] as const;

export interface GitOptions {
  cwd: string;
  /** Extra environment, applied after the stripping above (e.g. GIT_INDEX_FILE for snapshots). */
  env?: Record<string, string>;
  input?: string | Buffer;
  /** Exit codes treated as success besides 0 (e.g. 1 for "not found" queries). */
  okExitCodes?: readonly number[];
}

export interface GitResult<T extends string | Buffer = string> {
  stdout: T;
  stderr: string;
  exitCode: number;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${exitCode ?? "no exit code"}): ${stderr.trim() || "no output"}`);
    this.name = "GitError";
  }
}

export class MissingDirectoryError extends Error {
  constructor(readonly dir: string) {
    super(`directory does not exist: ${dir}`);
    this.name = "MissingDirectoryError";
  }
}

/** ENOENT from spawning git means a missing cwd as often as a missing git binary. */
export function spawnEnoentError(cwd: string): Error {
  return existsSync(cwd) ? new GitNotFoundError() : new MissingDirectoryError(cwd);
}

export class GitNotFoundError extends Error {
  constructor() {
    super("git was not found on PATH. Install git 2.38 or newer: https://git-scm.com/downloads");
    this.name = "GitNotFoundError";
  }
}

function buildEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const stripped: ReadonlySet<string> = new Set(STRIPPED_ENV);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !stripped.has(k)));
  return {
    ...env,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    // Stops read-only commands from refreshing and rewriting the user's .git/index.
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    ...extra,
  };
}

/**
 * Starts a long-lived git process with piped stdin/stdout (e.g. `cat-file
 * --batch`). Same environment rules as runGit. Uses child_process directly:
 * with execa, awaiting the subprocess could settle before the child exited,
 * leaving it alive (and the CLI unable to exit) for ~10 s after a large run.
 */
export function spawnGit(args: readonly string[], opts: Pick<GitOptions, "cwd" | "env">): ChildProcessWithoutNullStreams {
  return spawn("git", ["-c", "core.quotePath=false", ...args], {
    cwd: opts.cwd,
    env: buildEnv(opts.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function run(
  args: readonly string[],
  opts: GitOptions,
  encoding: "utf8" | "buffer",
): Promise<GitResult<string | Buffer>> {
  const fullArgs = ["-c", "core.quotePath=false", ...args];
  const result = await execa("git", fullArgs, {
    cwd: opts.cwd,
    env: buildEnv(opts.env),
    extendEnv: false,
    reject: false,
    stripFinalNewline: false,
    encoding,
    ...(opts.input !== undefined ? { input: opts.input } : { stdin: "ignore" as const }),
  });
  if ((result as { code?: string }).code === "ENOENT") throw spawnEnoentError(opts.cwd);
  const exitCode = result.exitCode;
  const stderr = typeof result.stderr === "string" ? result.stderr : Buffer.from(result.stderr).toString("utf8");
  if (exitCode === undefined || (exitCode !== 0 && !(opts.okExitCodes ?? []).includes(exitCode))) {
    throw new GitError(args, exitCode, stderr);
  }
  const stdout = encoding === "buffer" ? Buffer.from(result.stdout as Uint8Array) : (result.stdout as string);
  return { stdout, stderr, exitCode };
}

export async function runGit(args: readonly string[], opts: GitOptions): Promise<GitResult> {
  return (await run(args, opts, "utf8")) as GitResult;
}

export async function runGitBuffer(args: readonly string[], opts: GitOptions): Promise<GitResult<Buffer>> {
  return (await run(args, opts, "buffer")) as GitResult<Buffer>;
}

export type Version = readonly [number, number, number];

export function parseGitVersion(output: string): Version {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!m) throw new Error(`could not parse git version from: ${output.trim()}`);
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function gitVersion(cwd: string = process.cwd()): Promise<Version> {
  return parseGitVersion((await runGit(["version"], { cwd })).stdout);
}

export class GitTooOldError extends Error {
  constructor(readonly found: Version) {
    super(
      `git ${found.join(".")} is too old; CAIRN needs ${MIN_GIT_VERSION.join(".")} or newer. Upgrade: https://git-scm.com/downloads`,
    );
    this.name = "GitTooOldError";
  }
}

export async function assertGitVersion(cwd?: string): Promise<Version> {
  const v = await gitVersion(cwd);
  if (compareVersions(v, MIN_GIT_VERSION) < 0) throw new GitTooOldError(v);
  return v;
}
