import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DoctorReport } from "../../src/core/doctor.js";
import { cli } from "../helpers/cli.js";
import { makeRepo, type TempRepo } from "../helpers/repo.js";
import { guard } from "../helpers/safety.js";

async function doctor(r: TempRepo | string, ...args: string[]) {
  const res = await cli(typeof r === "string" ? r : r.dir, "--json", "doctor", ...args);
  const report = res.json() as DoctorReport;
  const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
  return { res, report, status };
}

async function initialized(files: Record<string, string> = { "a.ts": "export const a = 1;\n" }) {
  const r = makeRepo(files);
  await cli(r.dir, "init");
  return r;
}

describe("cairn doctor", () => {
  it("is healthy after init", async () => {
    const r = await initialized();
    guard(r);
    const { res, report, status } = await doctor(r);
    expect(res.code).toBe(0);
    expect(report.healthy).toBe(true);
    expect(status).toEqual({
      git: "ok",
      repo: "ok",
      init: "ok",
      gitignore: "ok",
      config: "ok",
      grammars: "ok",
      cache: "ok",
      sessions: "ok",
      snapshot: "ok",
    });
  });

  it("fails before init and says how to fix it", async () => {
    const r = makeRepo({ "a.ts": "a" });
    guard(r);
    const { res, report, status } = await doctor(r);
    expect(res.code).toBe(1);
    expect(status).toMatchObject({ init: "fail", gitignore: "warn", cache: "skip", snapshot: "skip" });
    expect(report.checks.find((c) => c.id === "init")?.fix).toMatch(/cairn init/);
    expect(existsSync(join(r.dir, ".cairn"))).toBe(false); // doctor never initializes
  });

  it("fails outside a git repo", async () => {
    const { res, status } = await doctor(mkdtempSync(join(tmpdir(), "cairn-norepo-")));
    expect(res.code).toBe(1);
    expect(status).toEqual({ git: "ok", repo: "fail" });
  });

  it("fails on an invalid config", async () => {
    const r = await initialized();
    writeFileSync(join(r.dir, ".cairn/config.toml"), '[summarizer]\nprovider = "nope"\n');
    const { res, report } = await doctor(r);
    expect(res.code).toBe(1);
    expect(report.checks.find((c) => c.id === "config")).toMatchObject({ status: "fail", message: expect.stringMatching(/provider/) });
  });

  it("warns about corrupt cache entries, and --fix removes them", async () => {
    const r = await initialized();
    const bad = join(r.dir, ".cairn/cache/ab", `${"c".repeat(62)}.json`);
    mkdirSync(join(r.dir, ".cairn/cache/ab"), { recursive: true });
    writeFileSync(bad, "{oops");
    guard(r);

    const before = await doctor(r);
    expect(before.res.code).toBe(0); // a warning, not a failure: entries rebuild on use
    expect(before.report.checks.find((c) => c.id === "cache")).toMatchObject({
      status: "warn",
      message: expect.stringContaining("1 corrupt"),
      fix: expect.stringContaining("--fix"),
    });
    expect(existsSync(bad)).toBe(true);

    const fixed = await doctor(r, "--fix");
    expect(fixed.status.cache).toBe("ok");
    expect(existsSync(bad)).toBe(false);
  });

  it("warns about unreadable session cursors, and --fix removes them", async () => {
    const r = await initialized();
    const cursor = join(r.dir, ".cairn/sessions/claude-code.json");
    writeFileSync(cursor, JSON.stringify({ schema: 1, agent: "someone-else" }));
    expect((await doctor(r)).status.sessions).toBe("warn");
    expect((await doctor(r, "--fix")).status.sessions).toBe("ok");
    expect(existsSync(cursor)).toBe(false);
  });

  it("warns when .cairn/ is not gitignored", async () => {
    const r = await initialized();
    writeFileSync(join(r.dir, ".gitignore"), "");
    const { res, status } = await doctor(r);
    expect(res.code).toBe(0);
    expect(status.gitignore).toBe("warn");
  });

  it("prints a readable text report", async () => {
    const r = makeRepo({ "a.ts": "a" });
    const res = await cli(r.dir, "doctor");
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/^FAIL {2}init/m);
    expect(res.out).toMatch(/→ Run `cairn init`/);
    expect(res.out).toMatch(/cannot run until the FAIL items are fixed/);
  });
});
