import { join, sep } from "node:path";
import type { Repo } from "../git/index.js";

export const CAIRN_DIR = ".cairn";

export interface CairnPaths {
  dir: string;
  config: string;
  cache: string;
  sessions: string;
  tmpIndex: string;
  /** CAIRN's own lock. Not tmp-index.lock: git itself creates <index>.lock while writing the index. */
  snapshotLock: string;
  stats: string;
  consent: string;
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
    snapshotLock: join(dir, "snapshot.lock"),
    stats: join(dir, "stats.jsonl"),
    consent: join(dir, "consent.json"),
    cairnignore: join(repo.root, ".cairnignore"),
  };
}

/** Converts an OS path (relative) to the forward-slash form CAIRN shows and stores. */
export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
