import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeSummarizer, SummarizerError } from "../../src/summarizers/index.js";
import { cli, cliWith } from "../helpers/cli.js";
import { makeRepo, type TempRepo } from "../helpers/repo.js";

const FILES = {
  "README.md": "# demo\n",
  "a/b/c.ts": "export function c(): number { return 1; }\n",
  "a/b/d.py": "def d():\n    return 2\n",
  "a/e.ts": "export const e = 3;\n",
};

async function repo(files: Record<string, string> = FILES) {
  const r = makeRepo(files);
  await cli(r.dir, "init");
  return r;
}

const consent = (r: TempRepo) => join(r.dir, ".cairn/consent.json");

/** Interactive run that says yes to every question. */
const yesRun = (r: TempRepo, fake: FakeSummarizer, ...argv: string[]) =>
  cliWith({ interactive: true, answers: [true, true, true], summarizer: fake }, r.dir, "summarize", ...argv);

describe("cairn summarize", () => {
  it("is off by default and says how to turn it on", async () => {
    const r = await repo();
    const res = await cli(r.dir, "summarize");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/summaries are off.*provider = "anthropic".*ANTHROPIC_API_KEY/);
  });

  it("names the env var when the key is missing, and never reads a key from config", async () => {
    const r = await repo();
    writeFileSync(join(r.dir, ".cairn/config.toml"), '[summarizer]\nprovider = "anthropic"\nmodel = "claude-haiku-5-5"\n');
    const res = await cli(r.dir, "summarize", "--dry-run");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/set ANTHROPIC_API_KEY/);
  });

  it("dry-run shows the plan and estimate, asks nothing and sends nothing", async () => {
    const r = await repo();
    const fake = new FakeSummarizer();
    const res = await cliWith({ summarizer: fake }, r.dir, "summarize", "--dry-run");
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^Summarize the whole repo with fake\/fake-1 at fake\.invalid\n {2}7 calls: 4 files, 3 folders \(0 already up to date\)/);
    expect(res.out).toContain("    a/b/c.ts");
    expect(res.out).toContain("Estimated cost: unknown");
    expect(res.out).toContain("Dry run: nothing was sent.");
    expect(res.asked).toEqual([]);
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(consent(r))).toBe(false);
  });

  it("asks consent once and confirmation every run, then writes the summaries", async () => {
    const r = await repo();
    const fake = new FakeSummarizer();
    const res = await yesRun(r, fake);
    expect(res.code).toBe(0);
    expect(res.asked).toHaveLength(2);
    expect(res.asked[0]).toMatch(/^Send source from this repo to fake at fake\.invalid\?/);
    expect(res.asked[1]).toMatch(/^Proceed with 7 calls \(~[\d.]+k? in \/ ~[\d.]+k? out tokens\)\? \[y\/N\] $/);
    expect(res.out).toMatch(/Done: 7 summaries written, 0 failed\. Used \d+ in \/ 84 out tokens \(as reported by the provider\)\./);
    expect(fake.calls).toHaveLength(7);
    expect(JSON.parse(readFileSync(consent(r), "utf8")).grants).toMatchObject([{ provider: "fake", host: "fake.invalid" }]);

    const again = await yesRun(r, new FakeSummarizer());
    expect(again.asked).toEqual([]); // nothing to do: no questions
    expect(again.out).toContain("Nothing to do: 1 summaries are already up to date.");
  });

  it("editing one file at depth 3 triggers exactly 4 summary calls (v0.2 acceptance, CLI)", async () => {
    const r = await repo();
    await yesRun(r, new FakeSummarizer());
    r.write("a/b/c.ts", "export function c(): number { return 42; }\n");
    const fake = new FakeSummarizer();
    const res = await yesRun(r, fake);
    expect(res.out).toContain("4 calls: 1 files, 3 folders");
    expect(fake.calls.map((c) => c.prompt.split("\n")[0])).toEqual(["Path: a/b/c.ts", "Path: a/b/", "Path: a/", "Path: ./"]);
  });

  it("stops after a declined consent or run, and sends nothing", async () => {
    const r = await repo();
    const fake = new FakeSummarizer();
    const no = await cliWith({ interactive: true, answers: [false], summarizer: fake }, r.dir, "summarize");
    expect(no.code).toBe(0);
    expect(no.out).toContain("Nothing was sent.");
    expect(existsSync(consent(r))).toBe(false);
    const later = await cliWith({ interactive: true, answers: [true, false], summarizer: fake }, r.dir, "summarize");
    expect(later.out).toContain("Nothing was sent.");
    expect(fake.calls).toHaveLength(0);
  });

  it("without a terminal: fails without consent even with --yes, and runs with consent and --yes", async () => {
    const r = await repo();
    const fake = new FakeSummarizer();
    const res = await cliWith({ summarizer: fake }, r.dir, "summarize", "--yes");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/needs your consent once for this repo.*Run `cairn summarize` once in a terminal/);
    await yesRun(r, fake, "--dry-run"); // dry-run never grants consent either
    expect(existsSync(consent(r))).toBe(false);

    await cliWith({ interactive: true, answers: [true, false], summarizer: fake }, r.dir, "summarize"); // consent yes, run no
    const noYes = await cliWith({ summarizer: fake }, r.dir, "summarize");
    expect(noYes.code).toBe(1);
    expect(noYes.err).toMatch(/needs confirmation.*--dry-run, then pass --yes/);
    const ok = await cliWith({ summarizer: fake }, r.dir, "summarize", "--yes");
    expect(ok.code).toBe(0);
    expect(fake.calls).toHaveLength(7);
  });

  it("needs no consent for a local summarizer", async () => {
    const r = await repo();
    const res = await cliWith({ interactive: true, answers: [true], summarizer: new FakeSummarizer("fake-1", false) }, r.dir, "summarize");
    expect(res.asked).toHaveLength(1);
    expect(res.asked[0]).toMatch(/^Proceed/);
    expect(res.out).toContain("(local)");
    expect(res.out).toContain("Estimated cost: none (local model)");
  });

  it("refuses a run over the cap before asking, and --max-calls allows it", async () => {
    const r = await repo();
    writeFileSync(join(r.dir, ".cairn/config.toml"), "[summarizer]\nmax_calls_per_run = 3\n");
    const fake = new FakeSummarizer();
    const res = await cliWith({ interactive: true, answers: [true, true], summarizer: fake }, r.dir, "summarize");
    expect(res.code).toBe(1);
    expect(res.asked).toEqual([]);
    expect(res.err).toMatch(/needs 7 summary calls, over the cap of 3.*--max-calls 7/);
    const ok = await yesRun(r, fake, "--max-calls", "7");
    expect(ok.code).toBe(0);
    expect((await cli(r.dir, "summarize", "--max-calls", "0")).err).toMatch(/--max-calls must be a whole number of at least 1/);
  });

  it("reports failures and blocked folders, exits 1, and a re-run finishes the job", async () => {
    const r = await repo();
    const flaky = new FakeSummarizer("fake-1", true, (q) => (q.prompt.startsWith("Path: a/b/d.py") ? new SummarizerError("rate-limit", "fake.invalid is rate limiting (429)") : null));
    const res = await yesRun(r, flaky);
    expect(res.code).toBe(1);
    expect(res.out).toContain("Done: 3 summaries written, 1 failed.");
    expect(res.out).toContain("  a/b/d.py: fake.invalid is rate limiting (429)");
    expect(res.out).toMatch(/Not built because a file inside failed: (a\/b, a, \.|.*)/);
    const again = await yesRun(r, new FakeSummarizer());
    expect(again.out).toContain("4 calls: 1 files, 3 folders");
    expect(again.code).toBe(0);
  });

  it("summarizes a path relative to the current directory and rejects unknown paths", async () => {
    const r = await repo();
    const fake = new FakeSummarizer();
    const res = await cliWith({ interactive: true, answers: [true, true], summarizer: fake }, join(r.dir, "a"), "summarize", "b");
    expect(res.out).toMatch(/^Summarize a\/b with fake/);
    expect(res.out).toContain("Parent folders stop at a/");
    expect(fake.calls).toHaveLength(3);
    expect((await cliWith({ summarizer: fake }, r.dir, "summarize", "nope", "--dry-run")).err).toMatch(/nope is not in the snapshot/);
  });

  it("--json keeps stdout a single JSON document", async () => {
    const r = await repo();
    const res = await cliWith({ interactive: true, answers: [true, true], summarizer: new FakeSummarizer() }, r.dir, "--json", "summarize");
    const j = res.json() as { decision: string; plan: { calls: number; provider: string }; result: { done: string[]; usage: { output_tokens: number } } };
    expect(j.decision).toBe("run");
    expect(j.plan).toMatchObject({ calls: 7, provider: "fake" });
    expect(j.result.done).toHaveLength(7);
    expect(res.err).toContain("Summarize the whole repo with fake");
  });
});
