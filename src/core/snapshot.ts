// SPEC §Algorithm 1: a tree hash for the current working tree, including
// uncommitted and untracked (non-ignored) files, without touching the
// user's index, HEAD or refs.
import { access } from "node:fs/promises";
import {
  addAllInto,
  headCommit,
  listIndex,
  readTreeInto,
  removeFromIndex,
  type Repo,
  writeTreeFrom,
} from "../git/index.js";
import { BUILTIN_DENY_GLOBS, loadIgnoreRules } from "./ignore.js";
import { withLock, type LockOptions } from "./lock.js";
import { type CairnPaths, cairnPaths } from "./paths.js";

export class NotInitializedError extends Error {
  constructor(readonly root: string) {
    super(`CAIRN is not set up in ${root}. Run \`cairn init\` first.`);
    this.name = "NotInitializedError";
  }
}

export interface Snapshot {
  /** Tree hash of the working tree as CAIRN sees it. */
  tree: string;
  /** HEAD commit at snapshot time; null in a repo with no commits. */
  head: string | null;
  /**
   * Paths dropped from the scratch index by built-in denies or .cairnignore.
   * Untracked denied files are not listed: they are never staged at all.
   */
  excluded: string[];
}

export async function snapshot(repo: Repo, opts: { paths?: CairnPaths; lock?: LockOptions } = {}): Promise<Snapshot> {
  const paths = opts.paths ?? cairnPaths(repo);
  try {
    await access(paths.dir);
  } catch {
    throw new NotInitializedError(repo.root);
  }
  const rules = await loadIgnoreRules(paths.cairnignore);
  return withLock(
    paths.snapshotLock,
    async () => {
      const head = await headCommit(repo);
      const idx = paths.tmpIndex;
      // Start from HEAD so tracked-but-gitignored files are kept, as git itself would.
      await readTreeInto(repo, idx, head, { keepStat: true });
      await addAllInto(repo, idx, BUILTIN_DENY_GLOBS);
      // Remove what add could not skip: tracked files that are denied or in .cairnignore,
      // and untracked files matched by .cairnignore.
      const excluded = (await listIndex(repo, idx)).filter((p) => rules.excludes(p));
      await removeFromIndex(repo, idx, excluded);
      return { tree: await writeTreeFrom(repo, idx), head, excluded };
    },
    opts.lock,
  );
}
