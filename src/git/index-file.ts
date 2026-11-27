// Operations on a scratch index file, never the user's .git/index.
// Every function requires an explicit index path, and it must not be the
// repo's real index; snapshot.ts (plan step 4) composes these.
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { runGit } from "./exec.js";
import type { Repo } from "./repo.js";

export class UserIndexError extends Error {
  constructor(path: string) {
    super(`refusing to use the user's index (${path}) as a scratch index`);
    this.name = "UserIndexError";
  }
}

/** Canonical path, resolving symlinks in the directory even if the file itself doesn't exist yet. */
function canonical(path: string): string {
  try {
    return resolve(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

function envFor(repo: Repo, indexFile: string): Record<string, string> {
  const abs = resolve(repo.root, indexFile);
  if (canonical(abs) === canonical(resolve(repo.gitDir, "index"))) throw new UserIndexError(abs);
  return { GIT_INDEX_FILE: abs };
}

export interface ReadTreeOptions {
  /**
   * Keep cached stat info for entries whose content matches the tree
   * (`read-tree -m`), so the following `add` only rehashes files that
   * changed. The resulting index content is the same either way.
   */
  keepStat?: boolean;
}

/** Loads a tree into the scratch index, or empties it when `treeish` is null. */
export async function readTreeInto(
  repo: Repo,
  indexFile: string,
  treeish: string | null,
  opts: ReadTreeOptions = {},
): Promise<void> {
  const args =
    treeish === null
      ? ["read-tree", "--empty"]
      : ["read-tree", ...(opts.keepStat ? ["-m"] : []), "--end-of-options", treeish];
  await runGit(args, { cwd: repo.root, env: envFor(repo, indexFile) });
}

/**
 * Stages the whole work tree (tracked changes, deletions and non-ignored
 * untracked files) into the scratch index. `excludeGlobs` become
 * `:(exclude,glob)` pathspecs, so matching files are never hashed into
 * .git/objects at all.
 */
export async function addAllInto(repo: Repo, indexFile: string, excludeGlobs: readonly string[] = []): Promise<void> {
  const pathspecs = [":/", ...excludeGlobs.map((g) => `:(top,exclude,glob)${g}`)];
  await runGit(["add", "--all", "--ignore-errors", "--", ...pathspecs], {
    cwd: repo.root,
    env: envFor(repo, indexFile),
  });
}

/** Removes paths from the scratch index (the work tree is untouched). */
export async function removeFromIndex(repo: Repo, indexFile: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await runGit(["update-index", "--force-remove", "-z", "--stdin"], {
    cwd: repo.root,
    env: envFor(repo, indexFile),
    input: paths.join("\0") + "\0",
  });
}

/** Paths currently in the scratch index. */
export async function listIndex(repo: Repo, indexFile: string): Promise<string[]> {
  const { stdout } = await runGit(["ls-files", "-z", "--cached", "--full-name"], {
    cwd: repo.root,
    env: envFor(repo, indexFile),
  });
  return stdout.split("\0").filter(Boolean);
}

/** Writes the scratch index as a tree object and returns its hash. */
export async function writeTreeFrom(repo: Repo, indexFile: string): Promise<string> {
  return (await runGit(["write-tree"], { cwd: repo.root, env: envFor(repo, indexFile) })).stdout.trim();
}
