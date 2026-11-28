import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DoctorReport } from "../../src/core/doctor.js";
import { cli, cliWith } from "../helpers/cli.js";
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
      summarizer: "ok",
      consent: "skip",
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

  describe("summarizer", () => {
    const KEY = "sk-ant-api03-doctor-test-value-0123456789abcdefghij";
    const noKeys = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined };
    async function doctorEnv(r: TempRepo, env: NodeJS.ProcessEnv) {
      const res = await cliWith({ env }, r.dir, "--json", "doctor");
      const report = res.json() as DoctorReport;
      const by = (id: string) => report.checks.find((c) => c.id === id);
      return { res, report, summarizer: by("summarizer"), consent: by("consent") };
    }
    async function anthropicRepo() {
      const r = await initialized();
      writeFileSync(join(r.dir, ".cairn/config.toml"), '[summarizer]\nprovider = "anthropic"\nmodel = "claude-haiku-5-5"\n');
      return r;
    }

    it("reports summaries off by default", async () => {
      const r = await initialized();
      guard(r);
      const { summarizer, consent } = await doctorEnv(r, noKeys);
      expect(summarizer).toMatchObject({ status: "ok", message: expect.stringMatching(/^off/) as unknown });
      expect(consent?.status).toBe("skip");
    });

    it("warns when the key's env var is missing, naming it", async () => {
      const r = await anthropicRepo();
      guard(r);
      const { res, report, summarizer, consent } = await doctorEnv(r, noKeys);
      expect(res.code).toBe(0);
      expect(report.healthy).toBe(true);
      expect(summarizer?.status).toBe("warn");
      expect(summarizer?.message).toMatch(/ANTHROPIC_API_KEY/);
      expect(summarizer?.fix).toMatch(/never read from config\.toml/);
      expect(consent?.status).toBe("skip");
    });

    it("says the key is set without ever printing it", async () => {
      const r = await anthropicRepo();
      guard(r);
      const json = await doctorEnv(r, { ...noKeys, ANTHROPIC_API_KEY: KEY });
      expect(json.summarizer?.status).toBe("ok");
      expect(json.summarizer?.message).toMatch(/anthropic\/claude-haiku-5-5 at api\.anthropic\.com; key from ANTHROPIC_API_KEY \(set\)/);
      expect(json.res.out).not.toContain(KEY);
      expect(json.res.out).not.toContain(KEY.slice(0, 16));
      const text = await cliWith({ env: { ...noKeys, ANTHROPIC_API_KEY: KEY } }, r.dir, "doctor");
      expect(text.out + text.err).not.toContain(KEY.slice(0, 16));
    });

    it("reports consent as not asked, then granted", async () => {
      const r = await anthropicRepo();
      guard(r);
      const env = { ...noKeys, ANTHROPIC_API_KEY: KEY };
      expect((await doctorEnv(r, env)).consent).toMatchObject({ status: "ok", message: expect.stringMatching(/not asked yet for anthropic at api\.anthropic\.com/) as unknown });
      writeFileSync(
        join(r.dir, ".cairn/consent.json"),
        JSON.stringify({ schema: 1, grants: [{ provider: "anthropic", host: "api.anthropic.com", granted_at: "2026-11-27T00:00:00.000Z" }] }),
      );
      expect((await doctorEnv(r, env)).consent).toMatchObject({ status: "ok", message: "granted for anthropic at api.anthropic.com" });
    });

    it("asks consent again for a different ANTHROPIC_BASE_URL host", async () => {
      const r = await anthropicRepo();
      guard(r);
      writeFileSync(
        join(r.dir, ".cairn/consent.json"),
        JSON.stringify({ schema: 1, grants: [{ provider: "anthropic", host: "api.anthropic.com", granted_at: "2026-11-27T00:00:00.000Z" }] }),
      );
      const { summarizer, consent } = await doctorEnv(r, { ...noKeys, ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" });
      expect(summarizer?.message).toMatch(/at llm-gateway\.example\.com;/);
      expect(consent?.message).toMatch(/not asked yet for anthropic at llm-gateway\.example\.com/);
    });

    it("needs no consent for a local server", async () => {
      const r = await initialized();
      guard(r);
      writeFileSync(join(r.dir, ".cairn/config.toml"), '[summarizer]\nprovider = "ollama"\nmodel = "qwen3:8b"\n');
      const { summarizer, consent } = await doctorEnv(r, noKeys);
      expect(summarizer?.status).toBe("ok");
      expect(summarizer?.message).toMatch(/\(local\); no key needed/);
      expect(consent?.status).toBe("skip");
    });
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
