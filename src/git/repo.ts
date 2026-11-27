import { realpathSync } from "node:fs";
import { GitError, runGit } from "./exec.js";

/** A git repository CAIRN works on, located from a directory inside its work tree. */
export interface Repo {
  /** Absolute path of the work tree root. */
  root: string;
  /** Absolute path of this work tree's git dir (differs from commonDir in linked worktrees). */
  gitDir: string;
  /** Absolute path of the shared git dir that holds objects and refs. */
  commonDir: string;
  objectFormat: "sha1" | "sha256";
}

export class NotARepoError extends Error {
  constructor(readonly dir: string) {
    super(`${dir} is not inside a git work tree. Run \`git init\` first, or cd into your repo.`);
    this.name = "NotARepoError";
  }
}

export async function openRepo(dir: string): Promise<Repo> {
  let out: string;
  try {
    out = (
      await runGit(
        ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--show-object-format"],
        { cwd: dir },
      )
    ).stdout;
  } catch (e) {
    if (e instanceof GitError) throw new NotARepoError(dir);
    throw e;
  }
  const [root, gitDir, commonDir, format] = out.split("\n");
  if (!root || !gitDir || !commonDir) throw new NotARepoError(dir);
  return { root: canonical(root), gitDir: canonical(gitDir), commonDir: canonical(commonDir), objectFormat: format === "sha256" ? "sha256" : "sha1" };
}

/**
 * Native, symlink-free, long-name form of a path. On Windows git prints
 * C:/… paths and may keep 8.3 short names (C:/Users/RUNNER~1/…), while Node
 * gives C:\… long names; mixing them makes relative paths go wrong.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Resolves a revision to an object hash, or null if it does not exist. */
export async function revParse(repo: Repo, rev: string): Promise<string | null> {
  const { stdout, exitCode } = await runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", rev], {
    cwd: repo.root,
    okExitCodes: [1],
  });
  return exitCode === 0 ? stdout.trim() : null;
}

/** The commit HEAD points to, or null in a repo with no commits yet. */
export async function headCommit(repo: Repo): Promise<string | null> {
  return revParse(repo, "HEAD^{commit}");
}

/** The hash git assigns to `<rev>:<path>` (a blob or tree), or null if the path is absent there. */
export async function objectAt(repo: Repo, rev: string, path: string): Promise<string | null> {
  return revParse(repo, `${rev}:${path}`);
}

export async function isShallow(repo: Repo): Promise<boolean> {
  return (await runGit(["rev-parse", "--is-shallow-repository"], { cwd: repo.root })).stdout.trim() === "true";
}

/** Whether git would ignore `path` (repo-relative) if it were untracked. */
export async function isIgnored(repo: Repo, path: string): Promise<boolean> {
  const { exitCode } = await runGit(["check-ignore", "-q", "--no-index", "--", path], {
    cwd: repo.root,
    okExitCodes: [1],
  });
  return exitCode === 0;
}
