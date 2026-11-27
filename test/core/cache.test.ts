import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Cache, cacheKey, type CorruptEntry } from "../../src/core/cache.js";
import { GEN, skeletonEntry } from "../helpers/entries.js";
import { tmpDir } from "../helpers/tmp.js";

const HASH = "9f2c4e0000000000000000000000000000000000";
const parts = (hash = HASH) => ({ kind: "blob" as const, hash, layer: "skeleton" as const, generator: GEN });

function newCache() {
  const reports: CorruptEntry[] = [];
  const cache = new Cache(join(tmpDir(), "cache"), (c) => reports.push(c));
  return { cache, reports };
}

describe("cacheKey", () => {
  it("matches golden vectors", () => {
    expect(cacheKey(parts())).toBe("e84c2a13c1aba66ed495c6dc6f19f67451eef5c801d3ce3c2694f687a362974a");
    expect(
      cacheKey({
        kind: "tree",
        hash: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        layer: "summary",
        generator: "ollama/qwen2.5-coder:7b@p3",
      }),
    ).toBe("ae83f1b271ee5bd61d97ba401e20c95b2e270eef52200c9e459715075358b71b");
  });

  it("changes with every component", () => {
    const base = cacheKey(parts());
    expect(cacheKey({ ...parts(), kind: "tree" })).not.toBe(base);
    expect(cacheKey({ ...parts(), hash: "0".repeat(40) })).not.toBe(base);
    expect(cacheKey({ ...parts(), layer: "summary" })).not.toBe(base);
    expect(cacheKey({ ...parts(), generator: "ts:typescript@0.1.13+x2" })).not.toBe(base);
  });
});

describe("Cache", () => {
  it("stores at cache/<2 hex>/<62 hex>.json and round-trips", async () => {
    const { cache } = newCache();
    const entry = skeletonEntry(HASH);
    await cache.put(entry);
    const file = cache.pathFor(entry.key);
    expect(file).toBe(join(cache.dir, entry.key.slice(0, 2), `${entry.key.slice(2)}.json`));
    expect(existsSync(file)).toBe(true);
    expect(await cache.get(parts())).toEqual(entry);
    expect(readdirSync(dirname(file))).toEqual([`${entry.key.slice(2)}.json`]); // no temp files left
  });

  it("returns null on a miss", async () => {
    const { cache, reports } = newCache();
    expect(await cache.get(parts())).toBeNull();
    expect(reports).toEqual([]);
  });

  it("shares one entry for the same content at two paths", async () => {
    const { cache } = newCache();
    await cache.put(skeletonEntry(HASH, { path_hint: "a/x.ts" }));
    await cache.put(skeletonEntry(HASH, { path_hint: "b/y.ts" }));
    expect(readdirSync(cache.dir)).toHaveLength(1);
    expect((await cache.get(parts()))?.path_hint).toBe("b/y.ts");
  });

  it("refuses to write an entry whose key does not match its fields", async () => {
    const { cache } = newCache();
    await expect(cache.put(skeletonEntry(HASH, { key: "0".repeat(64) }))).rejects.toThrow(/does not match/);
    await expect(cache.put({ ...skeletonEntry(HASH), summary: "x" })).rejects.toThrow();
  });

  it.each([
    ["json", "{not json"],
    ["schema", JSON.stringify({ ...skeletonEntry(HASH), schema: 3 })],
    ["invalid", JSON.stringify({ ...skeletonEntry(HASH), tokens: null })],
    ["key-mismatch", JSON.stringify(skeletonEntry("1".repeat(40)))],
  ])("deletes and reports a %s-corrupt entry, then rebuilds", async (reason, body) => {
    const { cache, reports } = newCache();
    const file = cache.pathFor(cacheKey(parts()));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);

    expect(await cache.get(parts())).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(reports).toMatchObject([{ path: file, reason }]);

    await cache.put(skeletonEntry(HASH));
    expect(await cache.get(parts())).not.toBeNull();
  });

  it("scans, reports, and with fix deletes corrupt entries", async () => {
    const { cache } = newCache();
    await cache.put(skeletonEntry(HASH));
    await cache.put(skeletonEntry("2".repeat(40)));
    const badFile = cache.pathFor("ab" + "c".repeat(62));
    mkdirSync(dirname(badFile), { recursive: true });
    writeFileSync(badFile, "garbage");
    const stray = join(dirname(badFile), "leftover.tmp");
    writeFileSync(stray, "");

    const report = await cache.scan();
    expect(report.ok).toBe(2);
    expect(report.corrupt.map((c) => [c.path, c.reason]).sort()).toEqual(
      [
        [badFile, "json"],
        [stray, "unreadable"],
      ].sort(),
    );
    expect(existsSync(badFile)).toBe(true);

    const fixed = await cache.scan({ fix: true });
    expect(fixed.corrupt).toHaveLength(2);
    expect(existsSync(badFile) || existsSync(stray)).toBe(false);
    expect(await cache.scan()).toEqual({ ok: 2, corrupt: [] });
  });

  it("migrates a schema 1 entry on read by adding files: null", async () => {
    const { cache, reports } = newCache();
    const v1 = { ...skeletonEntry(HASH), schema: 1 } as Record<string, unknown>;
    delete v1.files;
    const file = cache.pathFor(cacheKey(parts()));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(v1));
    expect(await cache.get(parts())).toEqual(skeletonEntry(HASH));
    expect(reports).toEqual([]);
  });

  it("scans an empty or missing cache dir", async () => {
    const { cache } = newCache();
    expect(await cache.scan()).toEqual({ ok: 0, corrupt: [] });
  });

  it("property: a lookup never returns an entry for a different hash", async () => {
    const { cache } = newCache();
    const blobHash = (s: string) => createHash("sha1").update(`blob ${Buffer.byteLength(s)}\0${s}`).digest("hex");
    const written = new Set<string>();
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string(), { minLength: 1, maxLength: 8 }), fc.string(), async (versions, probe) => {
        // Write entries for several versions of a file, then look up an arbitrary one.
        for (const v of versions) {
          await cache.put(skeletonEntry(blobHash(v)));
          written.add(v);
        }
        const want = blobHash(probe);
        const got = await cache.get(parts(want));
        if (got) expect(got.object.hash).toBe(want);
        expect(got !== null).toBe(written.has(probe));
      }),
      { numRuns: 50 },
    );
    // Every file on disk holds the hash its key was computed from.
    for (const v of written) {
      const file = cache.pathFor(cacheKey(parts(blobHash(v))));
      expect(JSON.parse(readFileSync(file, "utf8")).object.hash).toBe(blobHash(v));
    }
  });
});
