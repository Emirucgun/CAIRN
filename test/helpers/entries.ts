import { cacheKey } from "../../src/core/cache.js";
import type { CacheEntry } from "../../src/core/types.js";

export const GEN = "ts:typescript@0.1.13+x1";

/** A valid skeleton-layer blob entry for `hash`. */
export function skeletonEntry(hash: string, over: Partial<CacheEntry> = {}): CacheEntry {
  const generator = over.generator ?? GEN;
  return {
    schema: 3,
    key: cacheKey({ kind: "blob", hash, layer: "skeleton", generator }),
    object: { kind: "blob", hash },
    layer: "skeleton",
    path_hint: "src/auth/session.ts",
    lang: "typescript",
    skeleton: [
      { sym: "login", kind: "function", sig: "(email: string, pw: string) => Promise<Session>", lines: [12, 48], exported: true },
    ],
    imports: ["../lib/supabase"],
    summary: null,
    children: null,
    files: null,
    tokens: { source: 4210, skeleton: 180, summary: null },
    generator,
    created: "2026-11-27T08:20:00Z",
    ...over,
  };
}
