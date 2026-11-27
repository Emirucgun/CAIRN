// What CAIRN never indexes (SPEC §Security): anything git ignores (handled by
// `git add`), built-in denies, .cairnignore, and, for skeletons only, files
// over 1 MiB or binary.
import { readFile } from "node:fs/promises";
import ignore, { type Ignore } from "ignore";
import { CAIRN_DIR } from "./paths.js";

/** SPEC §Security built-in denies, in gitignore syntax (no slash → any depth). */
export const BUILTIN_DENIES = [".env*", "*.pem", "*.key", "id_*", "*.p12", "secrets.*"] as const;

/**
 * The same denies as git pathspec globs, passed to `git add` as excludes so
 * matching untracked files are never hashed into .git/objects. `.cairn/` is
 * always excluded, even before `cairn init` adds it to .gitignore.
 */
export const BUILTIN_DENY_GLOBS: readonly string[] = [
  ...BUILTIN_DENIES.map((p) => `**/${p}`),
  `${CAIRN_DIR}/**`,
];

/** 1 MiB. Larger files stay in the snapshot but get no skeleton. */
export const MAX_INDEXABLE_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;

export interface IgnoreRules {
  /** True if a repo-relative path must be left out of the snapshot. */
  excludes(path: string): boolean;
}

export async function loadIgnoreRules(cairnignorePath: string): Promise<IgnoreRules> {
  let cairnignore = "";
  try {
    cairnignore = await readFile(cairnignorePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return buildIgnoreRules(cairnignore);
}

export function buildIgnoreRules(cairnignore: string): IgnoreRules {
  // Kept separate so a `!pattern` in .cairnignore can never re-include a built-in deny.
  const denies: Ignore = ignore().add([...BUILTIN_DENIES, `/${CAIRN_DIR}/`]);
  const user: Ignore = ignore().add(cairnignore);
  return {
    excludes: (path) => denies.ignores(path) || user.ignores(path),
  };
}

/** Whether a file's content may get a skeleton: not too big and not binary. */
export function isIndexableContent(size: number, head: Uint8Array): boolean {
  if (size > MAX_INDEXABLE_BYTES) return false;
  const n = Math.min(head.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (head[i] === 0) return false;
  return true;
}
