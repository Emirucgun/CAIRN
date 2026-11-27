import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_TOML } from "../../src/core/config.js";
import { gitignoreHasCairn } from "../../src/core/init.js";
import { cli } from "../helpers/cli.js";
import { makeRepo } from "../helpers/repo.js";
import { guard } from "../helpers/safety.js";

describe("cairn init", () => {
  it("creates .cairn/, the default config and a .gitignore entry", async () => {
    const r = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    guard(r);
    const res = await cli(r.dir, "init");
    expect(res.code).toBe(0);
    expect(res.out).toContain("created .cairn/config.toml");
    for (const p of [".cairn", ".cairn/cache", ".cairn/sessions"]) expect(existsSync(join(r.dir, p))).toBe(true);
    expect(readFileSync(join(r.dir, ".cairn/config.toml"), "utf8")).toBe(DEFAULT_CONFIG_TOML);
    expect(readFileSync(join(r.dir, ".gitignore"), "utf8")).toBe(".cairn/\n");
    // .cairn/ no longer shows up in git status; only the new .gitignore does.
    expect(r.git("status", "--porcelain").trim()).toBe("?? .gitignore");
  });

  it("is idempotent and says so", async () => {
    const r = makeRepo({ "a.ts": "a" });
    await cli(r.dir, "init");
    const gi = readFileSync(join(r.dir, ".gitignore"), "utf8");
    guard(r);
    const res = await cli(r.dir, "--json", "init");
    expect(res.code).toBe(0);
    expect(res.json()).toMatchObject({ alreadyInitialized: true, changed: [] });
    expect(readFileSync(join(r.dir, ".gitignore"), "utf8")).toBe(gi);
  });

  it("appends to an existing .gitignore without a trailing newline", async () => {
    const r = makeRepo({ ".gitignore": "node_modules\ndist", "a.ts": "a" });
    guard(r);
    const res = await cli(r.dir, "--json", "init");
    expect(res.json()).toMatchObject({ changed: expect.arrayContaining([{ path: ".gitignore", action: "updated" }]) });
    expect(readFileSync(join(r.dir, ".gitignore"), "utf8")).toBe("node_modules\ndist\n.cairn/\n");
  });

  it.each([".cairn", ".cairn/", "/.cairn", "/.cairn/", "  .cairn/  "])("leaves .gitignore alone if it already has %j", async (line) => {
    const r = makeRepo({ ".gitignore": `node_modules\n${line}\n`, "a.ts": "a" });
    await cli(r.dir, "init");
    expect(readFileSync(join(r.dir, ".gitignore"), "utf8")).toBe(`node_modules\n${line}\n`);
  });

  it("does not treat similar lines as ignoring .cairn/", () => {
    expect(gitignoreHasCairn("# .cairn/\n.cairnignore\nsrc/.cairn/\n!.cairn/\n")).toBe(false);
  });

  it("keeps an existing config", async () => {
    const r = makeRepo({ "a.ts": "a" });
    await cli(r.dir, "init");
    writeFileSync(join(r.dir, ".cairn/config.toml"), "[context]\nmax_diff_lines = 10\n");
    await cli(r.dir, "init");
    expect(readFileSync(join(r.dir, ".cairn/config.toml"), "utf8")).toBe("[context]\nmax_diff_lines = 10\n");
  });

  it("works from a subdirectory and in a repo with no commits", async () => {
    const r = makeRepo({ "pkg/src/a.ts": "a" }, { commit: false });
    guard(r);
    const res = await cli(join(r.dir, "pkg", "src"), "init");
    expect(res.code).toBe(0);
    expect(existsSync(join(r.dir, ".cairn/config.toml"))).toBe(true);
    expect(existsSync(join(r.dir, "pkg/.cairn"))).toBe(false);
  });

  it("fails clearly outside a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-norepo-"));
    const res = await cli(dir, "init");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/not inside a git work tree.*git init/);
    expect(res.err).not.toMatch(/at .*\.ts:\d+/); // no stack trace
    const json = await cli(dir, "--json", "init");
    expect(json.json()).toMatchObject({ error: { name: "NotARepoError" } });
  });
});
