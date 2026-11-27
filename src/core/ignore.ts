// What CAIRN never indexes (SPEC §Security): anything git ignores (handled by
// `git add`), built-in denies, .cairnignore, and, for skeletons only, files
// over 1 MiB, binary, or containing a private key.
import { readFile } from "node:fs/promises";
import ignore, { type Ignore } from "ignore";
import { CAIRN_DIR } from "./paths.js";
import { scanForSecrets } from "./secrets.js";

/** SSH key file names, exactly (not `id_*`, which would hide files like src/id_generator.ts). */
const SSH_KEY_NAMES = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].flatMap((n) => [n, `${n}.pub`, `${n}-cert.pub`]);

/** SPEC §Security built-in denies, in gitignore syntax (no slash → any depth). */
export const BUILTIN_DENIES: readonly string[] = [".env*", "*.pem", "*.key", "*.p12", "secrets.*", ...SSH_KEY_NAMES];

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

export type IndexableVerdict =
  | { ok: true }
  | { ok: false; reason: "too-large" | "binary" }
  | { ok: false; reason: "secret"; pattern: string; line: number };

/**
 * Whether a file's content may be skeletoned or cached: not over 1 MiB, not
 * binary, and no private key anywhere in it, whatever the file is called.
 * `content` must be the whole file (it is only read when size is allowed).
 */
export function checkIndexable(size: number, content: Uint8Array): IndexableVerdict {
  if (size > MAX_INDEXABLE_BYTES) return { ok: false, reason: "too-large" };
  const n = Math.min(content.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (content[i] === 0) return { ok: false, reason: "binary" };
  const [hit] = scanForSecrets(Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString("utf8"));
  if (hit) return { ok: false, reason: "secret", pattern: hit.pattern, line: hit.line };
  return { ok: true };
}
