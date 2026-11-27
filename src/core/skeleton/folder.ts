// Folder skeletons (SPEC §Cache entry, schema 2): one cache entry per folder,
// keyed by its tree hash, holding the skeletons of its direct files. `map`
// reads one entry per folder it shows instead of one per file.
import type { TreeEntry } from "../../git/index.js";
import { cacheKey } from "../cache.js";
import { checkIndexable, MAX_INDEXABLE_BYTES } from "../ignore.js";
import { estimateTokens } from "../tokens.js";
import type { CacheEntry, FolderFile, TreeChild } from "../types.js";
import { EXTRACTOR_VERSION, extractSkeleton, isSupported } from "./extract.js";
import { type SkeletonDeps, skeletonGenerator } from "./index.js";
import { langForPath } from "./langs.js";
import { GRAMMAR_PKG_VERSION } from "./loader.js";
import { renderSkeleton } from "./render.js";

export function folderGenerator(): string {
  return `ts-dir@${GRAMMAR_PKG_VERSION}+x${EXTRACTOR_VERSION}`;
}

export interface FolderInput {
  /** Repo-relative folder path ("" for the root). */
  path: string;
  /** The folder's tree hash. */
  hash: string;
  /** Direct children: blobs with sizes, and subtrees (for `children`). */
  entries: readonly TreeEntry[];
}

export interface FolderResult {
  /** null when the folder has no files CAIRN can skeleton (no entry is stored). */
  entry: CacheEntry | null;
  cached: boolean;
  /** Files parsed now / served from per-file entries or this folder's entry. */
  parsed: number;
  reused: number;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export async function folderSkeleton(folder: FolderInput, deps: SkeletonDeps, now = new Date()): Promise<FolderResult> {
  const code = folder.entries.filter((e) => {
    if (e.type !== "blob") return false;
    const lang = langForPath(e.path);
    return lang !== null && isSupported(lang);
  });
  if (code.length === 0) return { entry: null, cached: false, parsed: 0, reused: 0 };

  const generator = folderGenerator();
  const parts = { kind: "tree", hash: folder.hash, layer: "skeleton", generator } as const;
  const hit = await deps.cache.get(parts);
  if (hit) return { entry: hit, cached: true, parsed: 0, reused: code.length };

  let parsed = 0;
  let reused = 0;
  const files = await Promise.all(
    code.map(async (e): Promise<FolderFile> => {
      const lang = langForPath(e.path) as NonNullable<ReturnType<typeof langForPath>>;
      const base = { name: nameOf(e.path), hash: e.hash, lang };
      if (e.size !== null && e.size > MAX_INDEXABLE_BYTES) {
        return { ...base, skeleton: null, imports: null, tokens: { source: Math.ceil(e.size / 4), skeleton: null }, skipped: "too-large" };
      }
      // A per-file entry (from cairn read or context) saves a parse.
      const own = await deps.cache.get({ kind: "blob", hash: e.hash, layer: "skeleton", generator: skeletonGenerator(lang) });
      if (own?.skeleton) {
        reused++;
        return { ...base, skeleton: own.skeleton, imports: own.imports, tokens: { source: own.tokens.source, skeleton: own.tokens.skeleton }, skipped: null };
      }
      const content = await deps.blobs.read(e.hash);
      const tokens = { source: estimateTokens(content.toString("latin1")), skeleton: null };
      const verdict = checkIndexable(content.length, content);
      if (!verdict.ok) {
        if (verdict.reason === "secret") deps.onSecret?.(e.path, verdict.pattern, verdict.line);
        return { ...base, skeleton: null, imports: null, tokens, skipped: verdict.reason };
      }
      const src = content.toString("utf8");
      const ex = await (deps.extract ?? extractSkeleton)(lang, src);
      parsed++;
      return {
        ...base,
        skeleton: ex.skeleton,
        imports: ex.imports,
        tokens: { source: estimateTokens(src), skeleton: estimateTokens(renderSkeleton(ex.skeleton)) },
        skipped: null,
      };
    }),
  );
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const children: TreeChild[] = folder.entries
    .filter((e) => e.type === "blob" || e.type === "tree")
    .map((e) => ({ name: nameOf(e.path), kind: e.type as "blob" | "tree", hash: e.hash }));
  const entry: CacheEntry = {
    schema: 2,
    key: cacheKey(parts),
    object: { kind: "tree", hash: folder.hash },
    layer: "skeleton",
    path_hint: folder.path,
    lang: null,
    skeleton: null,
    imports: null,
    summary: null,
    children,
    files,
    tokens: {
      source: files.reduce((n, f) => n + f.tokens.source, 0),
      skeleton: files.reduce((n, f) => n + (f.tokens.skeleton ?? 0), 0),
      summary: null,
    },
    generator,
    created: now.toISOString(),
  };
  await deps.cache.put(entry);
  return { entry, cached: false, parsed, reused };
}
