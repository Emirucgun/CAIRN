import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MapFile, MapFolder, MapNode, MapResult } from "../../src/core/map.js";
import { cli } from "../helpers/cli.js";
import { makeRepo } from "../helpers/repo.js";
import { guard } from "../helpers/safety.js";

const APP = {
  "README.md": "# app\n",
  "package.json": '{ "name": "app" }\n',
  "src/index.ts": 'import { login } from "./auth/session";\nexport function main(): void { login("a", "b"); }\n',
  "src/auth/session.ts":
    "/** Logs in. */\nexport async function login(email: string, pw: string): Promise<void> {}\nfunction hash(pw: string) { return pw; }\nexport class Session { refresh(): void {} }\n",
  "src/auth/tokens.ts": "export const TTL = 60;\n",
  "src/lib/deep/util.ts": "export function deepUtil() {}\n",
  "scripts/build.py": "def build(target: str) -> None:\n    pass\n",
};

async function initialized(files: Record<string, string> = APP) {
  const r = makeRepo(files);
  await cli(r.dir, "init");
  r.git("add", ".gitignore");
  r.git("commit", "-q", "-m", "init");
  return r;
}

async function mapJson(dir: string, ...args: string[]) {
  const res = await cli(dir, "--json", "map", ...args);
  expect(res.err).toBe("");
  expect(res.code).toBe(0);
  return res.json() as MapResult & { warnings: string[] };
}

const find = (node: MapNode, path: string): MapNode | undefined => {
  if (node.path === path) return node;
  if (node.kind === "folder") for (const c of node.children ?? []) {
    const hit = find(c, path);
    if (hit) return hit;
  }
  return undefined;
};

describe("cairn map", () => {
  it("prints folders with counts and files with exported symbols, depth 2 by default", async () => {
    const r = await initialized();
    guard(r);
    const res = await cli(r.dir, "map");
    expect(res.code).toBe(0);
    expect(res.out).toBe(
      [
        "./  (8 files, ~98 tok)",
        "  scripts/  (1 file, ~11 tok)",
        "    build.py  (~11 tok)",
        "      function build(target: str) -> None  L1-2",
        "  src/  (4 files, ~80 tok)",
        "    auth/  (2 files, ~50 tok)",
        "    lib/  (1 file, ~8 tok)",
        "    index.ts  (~23 tok)",
        "      function main(): void  L2-2",
        "  .gitignore  (~2 tok)",
        "  README.md  (~2 tok)",
        "  package.json  (~5 tok)",
        "",
      ].join("\n"),
    );
  });

  it("expands deeper with --depth and shows local symbols with --all", async () => {
    const r = await initialized();
    const res = await cli(r.dir, "map", "src", "--depth", "2", "--all");
    expect(res.out).toContain("  auth/  (2 files");
    expect(res.out).toContain("      function login(email: string, pw: string): Promise<void>  L1-2");
    expect(res.out).toContain("      (local) function hash(pw: string)  L3-3");
    expect(res.out).toContain("      method Session.refresh(): void  L4-4");
    expect(res.out).toContain("    deep/  (1 file"); // level 2 is collapsed at --depth 2
    expect(res.out).not.toContain("deepUtil");
  });

  it("maps a single file, and paths are relative to the current directory", async () => {
    const r = await initialized();
    const root = await mapJson(r.dir, "src/auth/session.ts");
    expect(root.root).toMatchObject({ kind: "file", path: "src/auth/session.ts", lang: "typescript" });
    const fromSub = await mapJson(join(r.dir, "src"), "auth");
    expect(fromSub.root).toMatchObject({ kind: "folder", path: "src/auth", files: 2 });
    const here = await mapJson(join(r.dir, "src", "auth"));
    expect(here.root.path).toBe("src/auth");
  });

  it("reflects uncommitted and untracked changes", async () => {
    const r = await initialized();
    r.write("src/index.ts", "export function renamed(): void {}\n");
    r.write("src/new.ts", "export const fresh = 1;\n");
    r.remove("scripts/build.py");
    guard(r);
    const m = await mapJson(r.dir);
    expect((find(m.root, "src/index.ts") as MapFile).symbols.map((s) => s.sym)).toEqual(["renamed"]);
    expect((find(m.root, "src/new.ts") as MapFile).symbols.map((s) => s.sym)).toEqual(["fresh"]);
    expect(find(m.root, "scripts")).toBeUndefined();
  });

  it("never shows denied files, and flags secret-bearing and binary files without their content", async () => {
    const r = await initialized({
      "src/app.ts": "export const a = 1;\n",
      "src/keys.ts": "export const k = `\n-----BEGIN RSA PRIVATE KEY-----\nMIIE\n`;\n",
      "src/blob.ts": "\u0000\u0001",
    });
    r.write(".env", "TOKEN=abc\n");
    r.write("id_ed25519", "x\n");
    const res = await cli(r.dir, "map");
    expect(res.out).not.toMatch(/\.env|id_ed25519/);
    expect(res.out).toContain("keys.ts  (~");
    expect(res.out).toContain("skipped: may contain a secret");
    expect(res.out).toContain("blob.ts  (~1 tok, binary)");
    expect(res.out + res.err).not.toContain("MIIE");
    expect(res.err).toBe("cairn: skipped src/keys.ts: looks like it contains a secret (private-key, line 2)\n");
  });

  it("parses on the first run and serves from the cache on the next", async () => {
    const r = await initialized();
    const first = await mapJson(r.dir, "--depth", "9");
    expect(first.stats).toMatchObject({ parsed: 5, cached: 0, files: 8 }); // 5 supported files
    const second = await mapJson(r.dir, "--depth", "9");
    expect(second.stats).toMatchObject({ parsed: 0, cached: 5 });
    expect(second.tree).toBe(first.tree);
    r.write("src/auth/tokens.ts", "export const TTL = 120;\n");
    expect((await mapJson(r.dir, "--depth", "9")).stats).toMatchObject({ parsed: 1, cached: 4 });
  });

  it("caps symbols per file", async () => {
    const many = Array.from({ length: 50 }, (_, i) => `export const c${i} = ${i};`).join("\n") + "\n";
    const r = await initialized({ "many.ts": many });
    const m = await mapJson(r.dir);
    const f = find(m.root, "many.ts") as MapFile;
    expect(f.symbols).toHaveLength(40);
    expect(f.hiddenSymbols).toBe(10);
    expect((await cli(r.dir, "map", "--max-symbols", "3")).out).toContain("… 47 more");
  });

  it("collapsed folders carry counts in JSON", async () => {
    const r = await initialized();
    const m = await mapJson(r.dir);
    expect(find(m.root, "src/auth")).toMatchObject({ kind: "folder", files: 2, children: null, summary: null });
    expect((m.root as MapFolder).files).toBe(8);
  });

  it("fails clearly for a missing or excluded path, outside the repo, before init, and on a bad --depth", async () => {
    const r = await initialized();
    r.write(".env", "X=1\n");
    for (const p of ["nope", ".env"]) {
      const res = await cli(r.dir, "map", p);
      expect(res.code).toBe(1);
      expect(res.err).toMatch(/is not in the snapshot/);
    }
    expect((await cli(r.dir, "map", "../..")).err).toMatch(/outside the repository/);
    expect((await cli(r.dir, "map", "--depth", "0")).err).toMatch(/--depth must be a whole number of at least 1/);
    const fresh = makeRepo({ "a.ts": "export const a = 1;\n" });
    expect((await cli(fresh.dir, "map")).err).toMatch(/cairn init/);
  });

  it("works in a repo with no commits", async () => {
    const r = makeRepo({ "a.ts": "export function f() {}\n" }, { commit: false });
    await cli(r.dir, "init");
    guard(r);
    expect((await cli(r.dir, "map")).out).toContain("function f()  L1-1");
  });
});

describe("cairn map on a large batch", () => {
  it("parses through the worker pool and matches inline results", async () => {
    const { POOL_THRESHOLD, INLINE_PARSES } = await import("../../src/core/map.js");
    const files = Object.fromEntries(
      Array.from({ length: POOL_THRESHOLD + 20 }, (_, i) => [`f${String(i).padStart(4, "0")}.ts`, `export function f${i}(n: number): number { return n + ${i}; }\n`]),
    );
    const r = await initialized(files);
    guard(r);
    const m = await mapJson(r.dir);
    expect(m.stats.parsed).toBe(POOL_THRESHOLD + 20);
    expect(m.stats.parsed).toBeGreaterThan(INLINE_PARSES); // so the pool really ran
    const f = find(m.root, "f0123.ts") as MapFile;
    expect(f.symbols).toEqual([{ sym: "f123", kind: "function", sig: "(n: number): number", lines: [1, 1], exported: true }]);
    expect((await mapJson(r.dir)).stats).toMatchObject({ parsed: 0, cached: POOL_THRESHOLD + 20 });
  }, 60_000);
});
