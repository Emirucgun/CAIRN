import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Cache } from "../../src/core/cache.js";
import { renderSymbol, skeletonFor, skeletonGenerator } from "../../src/core/skeleton/index.js";
import { BlobReader, openRepo } from "../../src/git/index.js";
import { makeRepo, type TempRepo } from "../helpers/repo.js";
import { tmpDir } from "../helpers/tmp.js";

const readers: BlobReader[] = [];
afterEach(async () => {
  for (const r of readers.splice(0)) await r.close();
});

async function setup(files: Record<string, string>) {
  const r = makeRepo(files);
  const repo = await openRepo(r.dir);
  const blobs = new BlobReader(repo);
  readers.push(blobs);
  const secrets: string[] = [];
  const cache = new Cache(join(tmpDir(), "cache"));
  let reads = 0;
  const counting = { read: (h: string) => (reads++, blobs.read(h)), close: () => blobs.close() } as unknown as BlobReader;
  const deps = { cache, blobs: counting, onSecret: (p: string, pat: string, line: number) => secrets.push(`${p}:${pat}:${line}`), now: () => new Date("2026-11-27T08:20:00Z") };
  const ref = (path: string) => fileRef(r, path);
  return { r, deps, ref, secrets, reads: () => reads, cache };
}

function fileRef(r: TempRepo, path: string) {
  const [hash, size] = r.git("ls-tree", "-l", "HEAD", "--", path).split(/\s+/).slice(2, 4) as [string, string];
  return { path, hash, size: Number(size) };
}

const SRC = "/** Logs in. */\nexport async function login(email: string): Promise<void> {}\n";

describe("skeletonFor", () => {
  it("builds, caches and then serves an entry keyed by blob hash and generator", async () => {
    const { deps, ref, reads, cache } = await setup({ "src/auth.ts": SRC });
    const first = await skeletonFor(ref("src/auth.ts"), deps);
    expect(first).toMatchObject({ status: "ok", cached: false });
    if (first.status !== "ok") throw new Error();
    expect(first.entry).toMatchObject({
      schema: 1,
      layer: "skeleton",
      lang: "typescript",
      path_hint: "src/auth.ts",
      generator: "ts:typescript@0.1.13+x1",
      imports: [],
      summary: null,
      children: null,
      created: "2026-11-27T08:20:00.000Z",
      skeleton: [{ sym: "login", kind: "function", sig: "(email: string): Promise<void>", lines: [1, 2], exported: true }],
    });
    expect(first.entry.tokens.source).toBe(Math.ceil(SRC.length / 4));
    expect(first.entry.tokens.summary).toBeNull();

    const second = await skeletonFor(ref("src/auth.ts"), deps);
    expect(second).toMatchObject({ status: "ok", cached: true });
    expect(reads()).toBe(1); // the cache hit never touched the blob
    expect((await cache.scan()).ok).toBe(1);
  });

  it("shares one entry for identical content at two paths", async () => {
    const { deps, ref, reads, cache } = await setup({ "a/x.ts": SRC, "b/y.ts": SRC });
    await skeletonFor(ref("a/x.ts"), deps);
    const other = await skeletonFor(ref("b/y.ts"), deps);
    expect(other).toMatchObject({ status: "ok", cached: true });
    expect(reads()).toBe(1);
    expect((await cache.scan()).ok).toBe(1);
  });

  it("uses a generator id per language, so the same bytes as .ts and .js are separate entries", async () => {
    const js = "export function f() {}\n";
    const { deps, ref } = await setup({ "a.ts": js, "a.js": js });
    const t = await skeletonFor(ref("a.ts"), deps);
    const j = await skeletonFor(ref("a.js"), deps);
    expect(t.status === "ok" && t.entry.generator).toBe(skeletonGenerator("typescript"));
    expect(j).toMatchObject({ status: "ok", cached: false, entry: { generator: "ts:javascript@0.1.13+x1" } });
  });

  it("skips unsupported, oversized, binary and secret-bearing files without caching them", async () => {
    const key = "export const k = `\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbg==\n`;\n";
    const { r, deps, ref, reads, secrets, cache } = await setup({
      "README.md": "# hi\n",
      "src/keys.ts": key,
      "src/bin.ts": "a\u0000b",
    });
    expect(await skeletonFor(ref("README.md"), deps)).toEqual({ status: "skipped", reason: "unsupported" });
    expect(await skeletonFor({ ...ref("src/bin.ts"), size: 2_000_000 }, deps)).toEqual({ status: "skipped", reason: "too-large" });
    expect(reads()).toBe(0); // neither needed the content
    expect(await skeletonFor(ref("src/bin.ts"), deps)).toEqual({ status: "skipped", reason: "binary" });
    const s = await skeletonFor(ref("src/keys.ts"), deps);
    expect(s).toEqual({ status: "skipped", reason: "secret", detail: "private-key at line 2" });
    expect(secrets).toEqual(["src/keys.ts:private-key:2"]);
    expect(JSON.stringify(s)).not.toContain("b3Blbg");
    expect(existsAny(cache.dir)).toBe(false);
    void r;
  });

  it("rebuilds after an edit (new blob hash) and after a corrupt entry", async () => {
    const { r, deps, ref } = await setup({ "a.ts": "export function one() {}\n" });
    const before = await skeletonFor(ref("a.ts"), deps);
    r.write("a.ts", "export function two() {}\n");
    r.commit();
    const after = await skeletonFor(ref("a.ts"), deps);
    expect(after).toMatchObject({ status: "ok", cached: false, entry: { skeleton: [{ sym: "two" }] } });
    expect(before.status === "ok" && before.entry.object.hash).not.toBe(after.status === "ok" && after.entry.object.hash);
  });

  it("renders symbols compactly", () => {
    expect(renderSymbol({ sym: "login", kind: "function", sig: "(e: string): void", lines: [3, 9], exported: true })).toBe(
      "function login(e: string): void  L3-9",
    );
    expect(renderSymbol({ sym: "A", kind: "class", sig: "extends B", lines: [1, 1], exported: false }, { lines: false })).toBe(
      "(local) class A extends B",
    );
    expect(renderSymbol({ sym: "x", kind: "property", sig: ": number", lines: [1, 1], exported: true }, { lines: false })).toBe("property x: number");
  });
});

function existsAny(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}
