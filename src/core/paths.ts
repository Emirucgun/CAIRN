import { join } from "node:path";
import type { Repo } from "../git/index.js";

export const CAIRN_DIR = ".cairn";

export interface CairnPaths {
  dir: string;
  config: string;
  cache: string;
  sessions: string;
  tmpIndex: string;
  tmpIndexLock: string;
  stats: string;
  cairnignore: string;
}

/** Locations from SPEC §On-disk layout, rooted at the work tree. */
export function cairnPaths(repo: Pick<Repo, "root">): CairnPaths {
  const dir = join(repo.root, CAIRN_DIR);
  return {
    dir,
    config: join(dir, "config.toml"),
    cache: join(dir, "cache"),
    sessions: join(dir, "sessions"),
    tmpIndex: join(dir, "tmp-index"),
    tmpIndexLock: join(dir, "tmp-index.lock"),
    stats: join(dir, "stats.jsonl"),
    cairnignore: join(repo.root, ".cairnignore"),
  };
}
