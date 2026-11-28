import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Cache } from "../../src/core/cache.js";
import { folderGenerator, folderSkeleton, skeletonFor } from "../../src/core/skeleton/index.js";
import { BlobReader, lsTree, openRepo } from "../../src/git/index.js";
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
  let reads = 0;
  const counting = { read: (h: string) => (reads++, blobs.read(h)) } as unknown as BlobReader;
  const deps = { cache: new Cache(join(tmpDir(), "cache")), blobs: counting, onSecret: (p: string) => secrets.push(p) };
  return { r, repo, deps, secrets, reads: () => reads };
}

async function folder(r: TempRepo, repo: Awaited<ReturnType<typeof openRepo>>, path: string) {
  const hash = path === "" ? r.git("rev-parse", "HEAD^{tree}").trim() : r.git("rev-parse", `HEAD:${path}`).trim();
  const entries = (await lsTree(repo, hash)).map((e) => ({ ...e, path: path ? `${path}/${e.path}` : e.path }));
  return { path, hash, entries };
}

describe("folderSkeleton", () => {
  it("stores one entry for a folder's direct files, sorted, and serves it from the cache next time", async () => {
    const { r, repo, deps, reads } = await setup({
      "src/b.ts": "export function b(): void {}\n",
      "src/a.py": "def a():\n    pass\n",
      "src/README.md": "# not code\n",
      "src/deep/c.ts": "export const c = 1;\n",
    });
    const f = await folder(r, repo, "src");
    const first = await folderSkeleton(f, deps, new Date("2026-11-27T08:20:00Z"));
    expect(first).toMatchObject({ cached: false, parsed: 2, reused: 0 });
    expect(first.entry).toMatchObject({
      schema: 3,
      object: { kind: "tree", hash: f.hash },
      layer: "skeleton",
      generator: folderGenerator(),
      path_hint: "src",
      skeleton: null,
      summary: null,
    });
    expect(first.entry?.files?.map((x) => [x.name, x.lang, x.skeleton?.map((s) => s.sym)])).toEqual([
      ["a.py", "python", ["a"]],
      ["b.ts", "typescript", ["b"]],
    ]);
    expect(first.entry?.children?.map((c) => `${c.kind}:${c.name}`)).toEqual(["blob:README.md", "blob:a.py", "blob:b.ts", "tree:deep"]);
    expect(reads()).toBe(2); // README.md is never read

    const second = await folderSkeleton(f, deps);
    expect(second).toMatchObject({ cached: true, parsed: 0, reused: 2 });
    expect(reads()).toBe(2);
    expect((await deps.cache.scan()).ok).toBe(1);
  });

  it("reuses per-file entries instead of re-parsing", async () => {
    const { r, repo, deps, reads } = await setup({ "x.ts": "export const x = 1;\n", "y.ts": "export const y = 2;\n" });
    await skeletonFor({ path: "x.ts", hash: r.git("rev-parse", "HEAD:x.ts").trim(), size: 20 }, deps);
    const res = await folderSkeleton(await folder(r, repo, ""), deps);
    expect(res).toMatchObject({ cached: false, parsed: 1, reused: 1 });
    expect(reads()).toBe(2);
  });

  it("records skipped files without their content, and warns once about secrets", async () => {
    const { r, repo, deps, secrets } = await setup({
      "keys.ts": "export const k = `\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n`;\n",
      "bin.ts": "\u0000\u0001",
      "ok.ts": "export const ok = true;\n",
    });
    const res = await folderSkeleton(await folder(r, repo, ""), deps);
    expect(res.entry?.files?.map((f) => [f.name, f.skipped, f.skeleton])).toEqual([
      ["bin.ts", "binary", null],
      ["keys.ts", "secret", null],
      ["ok.ts", null, [{ sym: "ok", kind: "const", sig: "", lines: [1, 1], exported: true }]],
    ]);
    expect(JSON.stringify(res.entry)).not.toContain("MIIE");
    expect(secrets).toEqual(["keys.ts"]);
  });

  it("stores nothing for a folder without code", async () => {
    const { r, repo, deps } = await setup({ "docs/a.md": "# a\n" });
    expect(await folderSkeleton(await folder(r, repo, "docs"), deps)).toEqual({ entry: null, cached: false, parsed: 0, reused: 0 });
    expect((await deps.cache.scan()).ok).toBe(0);
  });
});
