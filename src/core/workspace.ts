// Shared setup for commands that read the repo: repo, config, cache, blob
// reader, and the warnings they produce. Commands run inside withWorkspace().
import { access, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assertGitVersion, BlobReader, openRepo, type Repo } from "../git/index.js";
import { Cache } from "./cache.js";
import { loadConfig } from "./config.js";
import { type CairnPaths, cairnPaths } from "./paths.js";
import type { SkeletonDeps } from "./skeleton/index.js";
import { NotInitializedError } from "./snapshot.js";
import type { Config } from "./types.js";

export interface Workspace {
  repo: Repo;
  paths: CairnPaths;
  config: Config;
  cache: Cache;
  blobs: BlobReader;
  /** One-line warnings for stderr (never secret text). */
  warnings: string[];
  skeletonDeps: SkeletonDeps;
  /** The directory the command was run from, relative to the repo root ("" at the root). */
  cwdInRepo: string;
}

export async function withWorkspace<T>(cwd: string, fn: (ws: Workspace) => Promise<T>): Promise<T> {
  await assertGitVersion(cwd);
  const repo = await openRepo(cwd);
  const paths = cairnPaths(repo);
  try {
    await access(paths.dir);
  } catch {
    throw new NotInitializedError(repo.root);
  }
  const config = await loadConfig(paths.config);
  const warnings: string[] = [];
  const cache = new Cache(paths.cache, (c) => warnings.push(`rebuilt corrupt cache entry ${relative(repo.root, c.path)} (${c.reason})`));
  const blobs = new BlobReader(repo);
  const skeletonDeps: SkeletonDeps = {
    cache,
    blobs,
    onSecret: (path, pattern, line) => warnings.push(`skipped ${path}: looks like it contains a secret (${pattern}, line ${line})`),
  };
  const cwdInRepo = toRepoPath(repo, await realpath(cwd), "") ?? "";
  try {
    return await fn({ repo, paths, config, cache, blobs, warnings, skeletonDeps, cwdInRepo });
  } finally {
    await blobs.close();
  }
}

export class PathOutsideRepoError extends Error {
  constructor(readonly path: string) {
    super(`${path} is outside the repository`);
    this.name = "PathOutsideRepoError";
  }
}

/**
 * Converts a user-supplied path (relative to `fromDir`, which is repo-relative,
 * or absolute) to a repo-relative path with forward slashes. "" is the root.
 * Returns null if it points outside the repo.
 */
export function toRepoPath(repo: Repo, input: string, fromDir: string): string | null {
  const abs = isAbsolute(input) ? input : resolve(repo.root, fromDir, input);
  const rel = relative(repo.root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Runs `fn` over items with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
