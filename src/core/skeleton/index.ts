// Cache-aware skeletons (SPEC §Algorithm 2, steps 2 and 6): one cache entry
// per blob hash and generator; content shared by several paths is parsed once.
import type { BlobReader } from "../../git/index.js";
import type { Cache } from "../cache.js";
import { cacheKey } from "../cache.js";
import { checkIndexable, MAX_INDEXABLE_BYTES } from "../ignore.js";
import { estimateTokens } from "../tokens.js";
import type { CacheEntry } from "../types.js";
import { EXTRACTOR_VERSION, extractSkeleton, isSupported } from "./extract.js";
import { langForPath } from "./langs.js";
import { GRAMMAR_PKG_VERSION, type Lang } from "./loader.js";
import { renderSkeleton } from "./render.js";

export { langForPath } from "./langs.js";
export { renderSkeleton, renderSymbol } from "./render.js";

/** `ts:<lang>@<grammar-pkg-version>+x<extractor-version>` (SPEC §Cache key). */
export function skeletonGenerator(lang: Lang): string {
  return `ts:${lang}@${GRAMMAR_PKG_VERSION}+x${EXTRACTOR_VERSION}`;
}

export interface FileRef {
  path: string;
  /** Blob hash in the snapshot tree. */
  hash: string;
  /** Blob size in bytes, if known (from ls-tree); avoids reading oversized blobs. */
  size: number | null;
}

export type SkipReason = "unsupported" | "too-large" | "binary" | "secret";

export type SkeletonResult =
  | { status: "ok"; entry: CacheEntry; cached: boolean }
  | { status: "skipped"; reason: SkipReason; detail?: string };

export interface SkeletonDeps {
  cache: Cache;
  blobs: BlobReader;
  /** Called once per file skipped for a secret: SPEC §Security says log a warning, never the text. */
  onSecret?: (path: string, pattern: string, line: number) => void;
  now?: () => Date;
}

export async function skeletonFor(file: FileRef, deps: SkeletonDeps): Promise<SkeletonResult> {
  const lang = langForPath(file.path);
  if (!lang || !isSupported(lang)) return { status: "skipped", reason: "unsupported" };
  if (file.size !== null && file.size > MAX_INDEXABLE_BYTES) return { status: "skipped", reason: "too-large" };

  const generator = skeletonGenerator(lang);
  const parts = { kind: "blob", hash: file.hash, layer: "skeleton", generator } as const;
  const hit = await deps.cache.get(parts);
  if (hit) return { status: "ok", entry: hit, cached: true };

  const content = await deps.blobs.read(file.hash);
  const verdict = checkIndexable(content.length, content);
  if (!verdict.ok) {
    if (verdict.reason === "secret") {
      deps.onSecret?.(file.path, verdict.pattern, verdict.line);
      return { status: "skipped", reason: "secret", detail: `${verdict.pattern} at line ${verdict.line}` };
    }
    return { status: "skipped", reason: verdict.reason };
  }

  const src = content.toString("utf8");
  const { skeleton, imports } = await extractSkeleton(lang, src);
  const entry: CacheEntry = {
    schema: 1,
    key: cacheKey(parts),
    object: { kind: "blob", hash: file.hash },
    layer: "skeleton",
    path_hint: file.path,
    lang,
    skeleton,
    imports,
    summary: null,
    children: null,
    tokens: { source: estimateTokens(src), skeleton: estimateTokens(renderSkeleton(skeleton)), summary: null },
    generator,
    created: (deps.now?.() ?? new Date()).toISOString(),
  };
  await deps.cache.put(entry);
  return { status: "ok", entry, cached: false };
}
