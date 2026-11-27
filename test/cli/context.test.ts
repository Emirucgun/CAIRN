import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/main.js";
import type { ContextResult } from "../../src/core/context.js";
import { cli } from "../helpers/cli.js";
import { makeRepo, type TempRepo } from "../helpers/repo.js";
import { guard } from "../helpers/safety.js";

const FILES = {
  "src/auth/session.ts": "export function login(email: string): void {}\n",
  "src/util.ts": "export const one = 1;\n",
  "README.md": "# app\n",
};

async function initialized(files: Record<string, string> = FILES) {
  const r = makeRepo(files);
  await cli(r.dir, "init");
  r.git("add", ".gitignore");
  r.git("commit", "-q", "-m", "init");
  return r;
}

const cursorPath = (r: TempRepo, agent: string) => join(r.dir, ".cairn/sessions", `${agent}.json`);
const readCursor = (r: TempRepo, agent: string) => JSON.parse(readFileSync(cursorPath(r, agent), "utf8")) as Record<string, unknown>;

async function ctx(r: TempRepo, ...args: string[]) {
  const res = await cli(r.dir, "--json", "--agent", "claude-code", "context", ...args);
  expect(res.code).toBe(0);
  return res.json() as ContextResult & { warnings: string[] };
}

describe("cairn context", () => {
  it("gives a new agent the repo map, then writes its cursor", async () => {
    const r = await initialized();
    guard(r);
    const res = await cli(r.dir, "--agent", "claude-code", "context");
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^# CAIRN context for claude-code\n\nFirst session for this agent/);
    expect(res.out).toContain("    auth/  (1 file");
    expect(res.out).toContain("      const one  L1-1");
    const cursor = readCursor(r, "claude-code");
    expect(cursor).toMatchObject({ schema: 1, agent: "claude-code", last_head: r.git("rev-parse", "HEAD").trim(), active_task: null });
    expect(cursor.last_snapshot_tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it("then reports nothing changed", async () => {
    const r = await initialized();
    await ctx(r);
    const res = await cli(r.dir, "--agent", "claude-code", "context");
    expect(res.out).toMatch(/Last session just now .*\n\nNothing changed since then\./);
  });

  it("shows uncommitted edits as diffs, added and deleted files, and touched folders' symbols", async () => {
    const r = await initialized();
    await ctx(r);
    r.write("src/auth/session.ts", "export function login(email: string): void {}\nexport function logout(): void {}\n");
    r.write("src/auth/new.ts", "export const fresh = true;\n");
    r.remove("src/util.ts");
    guard(r);
    const res = await cli(r.dir, "--agent", "claude-code", "context");
    expect(res.out).toContain("## Changed files (3)");
    expect(res.out).toContain("### added: src/auth/new.ts (+1 −0)");
    expect(res.out).toContain("### modified: src/auth/session.ts (+1 −0)");
    expect(res.out).toContain("+export function logout(): void {}");
    expect(res.out).toContain("### deleted: src/util.ts");
    expect(res.out).toMatch(/src\/auth\/ {2}\(2 files.*\n {2}new\.ts .*\n {4}const fresh {2}L1-1\n {2}session\.ts .*\n {4}function login.*\n {4}function logout/);
    expect((await ctx(r)).changes).toEqual([]); // the cursor moved
  });

  it("lists commits since the last session", async () => {
    const r = await initialized();
    await ctx(r);
    r.write("src/util.ts", "export const one = 2;\n");
    r.commit("bump one");
    r.write("README.md", "# app v2\n");
    r.commit("docs: readme");
    const j = await ctx(r);
    expect(j.commitCount).toBe(2);
    expect(j.commits.map((c) => c.subject)).toEqual(["docs: readme", "bump one"]);
    expect(j.changes.map((c) => c.path)).toEqual(["README.md", "src/util.ts"]);
  });

  it("falls back to the new skeleton when a diff is over max_diff_lines", async () => {
    const r = await initialized();
    writeFileSync(join(r.dir, ".cairn/config.toml"), "[context]\nmax_diff_lines = 5\n");
    await ctx(r);
    const body = Array.from({ length: 20 }, (_, i) => `export function f${i}(): void {}`).join("\n") + "\n";
    r.write("src/util.ts", body);
    const res = await cli(r.dir, "--agent", "claude-code", "context", "--no-advance");
    expect(res.out).toMatch(/### modified: src\/util\.ts\n\nDiff is \d+ lines, over the limit\. Current symbols:/);
    expect(res.out).toContain("    function f19(): void  L20-20");
    expect(res.out).toContain("cairn read src/util.ts#<symbol>");
    expect(res.out).not.toContain("```diff");
  });

  it("withholds diffs of files that contain a secret on either side", async () => {
    const r = await initialized({ "src/keys.ts": "export const k = `\n-----BEGIN RSA PRIVATE KEY-----\nMIIEold\n`;\n" });
    await ctx(r);
    r.write("src/keys.ts", "export const k = `\n-----BEGIN RSA PRIVATE KEY-----\nMIIEnew\n`;\n");
    r.write("src/oops.ts", "export const leaked = `-----BEGIN OPENSSH PRIVATE KEY-----`;\n");
    const res = await cli(r.dir, "--agent", "claude-code", "context");
    expect(res.out).toContain("### modified: src/keys.ts (content withheld: looks like it contains a secret)");
    expect(res.out).toContain("### added: src/oops.ts (content withheld: looks like it contains a secret)");
    expect(res.out).not.toMatch(/MIIE|BEGIN/);
    expect(res.err).toContain("withheld the diff of src/keys.ts");
  });

  it("keeps a separate cursor per agent, from --agent or CAIRN_AGENT", async () => {
    const r = await initialized();
    await ctx(r);
    r.write("src/util.ts", "export const one = 3;\n");
    await ctx(r); // claude-code has now seen the edit
    let out = "";
    await main(["--json", "context"], { cwd: r.dir, env: { ...process.env, CAIRN_AGENT: "opencode" }, out: (t) => (out += t), err: () => {} });
    const opencode = JSON.parse(out) as ContextResult;
    expect(opencode.agent).toEqual({ id: "opencode", source: "env" });
    expect(opencode.since).toBeNull(); // its first session
    expect(existsSync(cursorPath(r, "opencode"))).toBe(true);
    expect((await ctx(r)).changes).toEqual([]);
  });

  it("uses the default agent with a hint, and rejects unsafe agent ids", async () => {
    const r = await initialized();
    const res = await cli(r.dir, "context");
    expect(res.out).toContain("Agent id is `default`");
    expect(existsSync(cursorPath(r, "default"))).toBe(true);
    const bad = await cli(r.dir, "--agent", "../escape", "context");
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/invalid agent id/);
    expect(existsSync(join(r.dir, ".cairn/escape.json"))).toBe(false);
  });

  it("--no-advance leaves the cursor where it was", async () => {
    const r = await initialized();
    await ctx(r);
    const before = readFileSync(cursorPath(r, "claude-code"), "utf8");
    r.write("src/util.ts", "export const one = 4;\n");
    expect((await ctx(r, "--no-advance")).changes).toHaveLength(1);
    expect(readFileSync(cursorPath(r, "claude-code"), "utf8")).toBe(before);
    expect((await ctx(r)).changes).toHaveLength(1);
  });

  it("does not advance the cursor if the output could not be delivered", async () => {
    const r = await initialized();
    const code = await main(["--agent", "claude-code", "context"], {
      cwd: r.dir,
      env: process.env,
      out: () => {
        throw new Error("EPIPE");
      },
      err: () => {},
    });
    expect(code).toBe(1);
    expect(existsSync(cursorPath(r, "claude-code"))).toBe(false);
  });

  it("starts fresh when the cursor is unreadable or its snapshot was pruned", async () => {
    const r = await initialized();
    writeFileSync(cursorPath(r, "claude-code"), "{ not json");
    const a = await ctx(r);
    expect(a.firstReason).toBe("cursor-unreadable");
    expect(a.warnings[0]).toMatch(/unreadable/);

    const c = readCursor(r, "claude-code");
    writeFileSync(cursorPath(r, "claude-code"), JSON.stringify({ ...c, last_snapshot_tree: "1".repeat(40) }));
    const b = await cli(r.dir, "--agent", "claude-code", "context");
    expect(b.out).toContain("pruned by `git gc`");
  });

  it("says so when the old HEAD is gone, instead of listing all history", async () => {
    const r = await initialized();
    await ctx(r);
    const c = readCursor(r, "claude-code");
    writeFileSync(cursorPath(r, "claude-code"), JSON.stringify({ ...c, last_head: "2".repeat(40) }));
    const j = await ctx(r);
    expect(j.historyRewritten).toBe(true);
    expect(j.commits).toEqual([]);
  });

  it("caps detailed changes and lists the rest by name", async () => {
    const many = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`f${String(i).padStart(2, "0")}.ts`, `export const v${i} = 0;\n`]));
    const r = await initialized(many);
    await ctx(r);
    for (let i = 0; i < 45; i++) r.write(`f${String(i).padStart(2, "0")}.ts`, `export const v${i} = 1;\n`);
    const j = await ctx(r, "--no-advance");
    expect(j.changes.filter((c) => c.detail.kind === "diff")).toHaveLength(40);
    expect(j.changes.filter((c) => c.detail.kind === "listed")).toHaveLength(5);
    const text = await cli(r.dir, "--agent", "claude-code", "context");
    expect(text.out).toContain("Also changed:\n\n- modified: f40.ts");
  });

  it("works in a repo with no commits, and after the first commit lists it", async () => {
    const r = makeRepo({ "a.ts": "export function f() {}\n" }, { commit: false });
    await cli(r.dir, "init");
    const first = await ctx(r);
    expect(first.now.head).toBeNull();
    r.commit("first");
    const second = await ctx(r);
    expect(second.commits.map((c) => c.subject)).toEqual(["first"]);
  });

  it("requires init", async () => {
    const r = makeRepo({ "a.ts": "x" });
    expect((await cli(r.dir, "context")).err).toMatch(/cairn init/);
  });
});
