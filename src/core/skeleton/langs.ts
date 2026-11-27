import type { Lang } from "./loader.js";

const BY_EXTENSION: Record<string, Lang> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".dart": "dart",
  ".swift": "swift",
};

/** The grammar for a path, or null if CAIRN has no skeleton support for it. */
export function langForPath(path: string): Lang | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot).toLowerCase()] ?? null;
}
