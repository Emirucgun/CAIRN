import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Cache } from "../../src/core/cache.js";
import { buildAndStore, skeletonGenerator } from "../../src/core/skeleton/index.js";
import { ParsePool } from "../../src/core/skeleton/pool.js";
import { tmpDir } from "../helpers/tmp.js";

const FILES = [
  { path: "a.ts", lang: "typescript", src: "export function a(x: number): string { return String(x); }\n" },
  { path: "b.py", lang: "python", src: "def b(y: int) -> int:\n    return y\n" },
  { path: "c.dart", lang: "dart", src: "int c(int z) => z;\n" },
  { path: "d.swift", lang: "swift", src: "public func d() -> Int { 1 }\n" },
] as const;

describe("ParsePool", () => {
  it("builds and stores the same entries as inline extraction, for every language", async () => {
    const pool = new ParsePool(2);
    const poolCache = new Cache(join(tmpDir(), "cache"));
    const inlineCache = new Cache(join(tmpDir(), "cache"));
    const created = "2026-11-27T08:20:00.000Z";
    try {
      const results = await Promise.all(
        FILES.map((f, i) => {
          const file = { path: f.path, hash: String(i + 1).repeat(40), size: f.src.length };
          return Promise.all([pool.build(poolCache.dir, file, f.lang, f.src, created), buildAndStore(inlineCache, file, f.lang, f.src, created)]);
        }),
      );
      for (const [fromPool, inline] of results) {
        expect(fromPool).toEqual(inline);
        // The worker wrote it to the cache itself.
        expect(await poolCache.get({ kind: "blob", hash: inline.object.hash, layer: "skeleton", generator: inline.generator })).toEqual(inline);
      }
      expect(results.map(([e]) => e.generator)).toEqual(FILES.map((f) => skeletonGenerator(f.lang)));
    } finally {
      await pool.close();
    }
  });

  it("rejects a failing request without breaking the next one", async () => {
    const pool = new ParsePool(1);
    const cache = new Cache(join(tmpDir(), "cache"));
    try {
      await expect(pool.build(cache.dir, { path: "x.ts", hash: "bad", size: 1 }, "typescript", "x", "2026-11-27T08:20:00.000Z")).rejects.toThrow();
      const ok = await pool.build(cache.dir, { path: "y.ts", hash: "e".repeat(40), size: 1 }, "typescript", "export const y = 1;\n", "2026-11-27T08:20:00.000Z");
      expect(ok.skeleton?.[0]?.sym).toBe("y");
    } finally {
      await pool.close();
    }
  });

  it("can be closed without starting", async () => {
    await new ParsePool().close();
  });
});
