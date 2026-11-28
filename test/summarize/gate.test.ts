import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isYes } from "../../src/cli/io.js";
import { grantConsent, hasConsent } from "../../src/core/summarize/consent.js";
import type { Plan } from "../../src/core/summarize/plan.js";
import {
  ConfirmationRequiredError,
  ConsentRequiredError,
  describePlan,
  EST_THINKING_TOKENS,
  estimateRun,
  prepareRun,
  type PrepareOptions,
} from "../../src/core/summarize/prepare.js";
import { costUsd, factorFor, formatUsd, priceFor } from "../../src/core/summarize/pricing.js";
import { CallCapError } from "../../src/core/summarize/run.js";
import { Config } from "../../src/core/types.js";
import { FakeSummarizer } from "../../src/summarizers/index.js";
import { tmpDir } from "../helpers/tmp.js";

const cfg = (summarizer: Record<string, unknown> = {}) => Config.parse({ summarizer });

function plan(calls: number, over: Partial<Plan> = {}): Plan {
  const nodes = Array.from({ length: calls }, (_, i) => ({ kind: "file" as const, path: `f${i}.ts`, hash: "a".repeat(40), key: "k", lang: "typescript", skeleton: [], prompt: "p", sourceTokens: 10 }));
  return { generator: "fake/fake-1@p1", root: "", nodes, cached: 2, skipped: [], stoppedAt: null, estimate: { calls, inputTokens: calls * 1000, outputTokens: calls * 150 }, ...over };
}

function asker(...answers: boolean[]) {
  const asked: string[] = [];
  return { asked, ask: (q: string) => (asked.push(q), Promise.resolve(answers.shift() ?? false)) };
}

describe("pricing", () => {
  it("has built-in prices for current Anthropic models only", () => {
    expect(priceFor("anthropic", "claude-haiku-5-5", cfg().summarizer)).toEqual({ inputPerMTok: 0.1, outputPerMTok: 0.5, source: "built-in" });
    expect(priceFor("anthropic", "claude-opus-5-5", cfg().summarizer)).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(priceFor("anthropic", "claude-made-up-9", cfg().summarizer)).toBeNull();
    expect(priceFor("openai-compatible", "gpt-x", cfg().summarizer)).toBeNull();
  });

  it("uses config prices when both are set, for any provider", () => {
    const c = cfg({ price_input_per_mtok: 0.5, price_output_per_mtok: 1.5 }).summarizer;
    expect(priceFor("openai-compatible", "gpt-x", c)).toEqual({ inputPerMTok: 0.5, outputPerMTok: 1.5, source: "config" });
    expect(priceFor("anthropic", "claude-haiku-5-5", c)?.source).toBe("config");
    expect(priceFor("openai-compatible", "gpt-x", cfg({ price_input_per_mtok: 0.5 }).summarizer)).toBeNull();
  });

  it("computes cost, formats it, and finds the model factor", () => {
    expect(costUsd({ inputPerMTok: 0.1, outputPerMTok: 0.5, source: "built-in" }, 1_000_000, 200_000)).toBeCloseTo(0.2);
    expect(formatUsd(0.0012)).toBe("$0.0012");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(factorFor("claude-haiku-5-5", { claude: 1.1, gpt: 1.0 })).toBe(1.1);
    expect(factorFor("claude-haiku-5-5", { claude: 1.1, "claude-haiku": 1.3 })).toBe(1.3);
    expect(factorFor("llama3", { claude: 1.1 })).toBe(1);
  });
});

describe("estimateRun and describePlan", () => {
  it("adds a thinking allowance for Anthropic models that think by default, and prices the run", async () => {
    const { AnthropicSummarizer } = await import("../../src/summarizers/index.js");
    const s = new AnthropicSummarizer({ model: "claude-haiku-5-5", apiKey: "k", baseURL: "https://api.anthropic.com" });
    const e = estimateRun(plan(10), s, cfg());
    expect(e).toMatchObject({ calls: 10, inputTokens: 10_000, outputTokens: 10 * (150 + EST_THINKING_TOKENS) });
    expect(e.costUsd).toBeCloseTo((10_000 * 0.1 + 3500 * 0.5) / 1e6);
    const text = describePlan(plan(10), s, e, 200);
    expect(text).toMatch(/^Summarize the whole repo with anthropic\/claude-haiku-5-5 at api\.anthropic\.com\n/);
    expect(text).toContain("10 calls: 10 files, 0 folders (2 already up to date)");
    expect(text).toContain("Estimated tokens: ~10k in, ~3.5k out");
    expect(text).toContain(`Estimated cost: ~${formatUsd(e.costUsd as number)} (built-in prices from 2026-11-03; may be out of date)`);
  });

  it("lists at most 20 files, notes skips, stops and the cap, and says when cost is unknown", () => {
    const f = new FakeSummarizer();
    const p = plan(25, { skipped: [{ path: "k.ts", reason: "secret", pattern: "private-key" }], stoppedAt: "src" });
    const text = describePlan(p, f, estimateRun(p, f, cfg()), 10);
    expect(text.match(/^ {4}f\d+\.ts$/gm)).toHaveLength(20);
    expect(text).toContain("… and 5 more files");
    expect(text).toContain("Not sent: 1 secret (k.ts)");
    expect(text).toContain("Parent folders stop at src/");
    expect(text).toContain("Estimated cost: unknown (set price_input_per_mtok and price_output_per_mtok in [summarizer])");
    expect(text).toContain("Over the call cap of 10: the run will be refused (narrow the path, or pass --max-calls 25)");
    expect(text).not.toContain("private-key"); // pattern names are for logs; paths are enough here
  });

  it("says when there is nothing to do", () => {
    const f = new FakeSummarizer();
    expect(describePlan(plan(0), f, estimateRun(plan(0), f, cfg()), 200)).toContain("Nothing to do: 2 summaries are already up to date.");
  });
});

describe("consent", () => {
  const target = { provider: "anthropic", host: "api.anthropic.com", external: true };

  it("is stored once per provider and host, and a changed host asks again", () => {
    const path = join(tmpDir(), "consent.json");
    expect(hasConsent(path, target)).toBe(false);
    grantConsent(path, target, new Date("2026-11-27T10:00:00Z"));
    grantConsent(path, target);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      schema: 1,
      grants: [{ provider: "anthropic", host: "api.anthropic.com", granted_at: "2026-11-27T10:00:00.000Z" }],
    });
    expect(hasConsent(path, target)).toBe(true);
    expect(hasConsent(path, { ...target, host: "gateway.example.com" })).toBe(false);
    expect(hasConsent(path, { ...target, provider: "openai-compatible" })).toBe(false);
  });

  it("is not needed for localhost, and an unreadable file grants nothing", () => {
    const path = join(tmpDir(), "consent.json");
    expect(hasConsent(path, { provider: "ollama", host: "127.0.0.1:11434", external: false })).toBe(true);
    writeFileSync(path, "{ broken");
    expect(hasConsent(path, target)).toBe(false);
  });
});

describe("prepareRun", () => {
  const f = () => new FakeSummarizer("fake-1", true);
  const base = (o: Partial<PrepareOptions>): PrepareOptions => ({
    cap: 200,
    dryRun: false,
    yes: false,
    interactive: true,
    ask: () => Promise.resolve(false),
    consentPath: join(tmpDir(), "consent.json"),
    ...o,
  });
  const est = (p: Plan) => estimateRun(p, f(), cfg());

  it("dry-run needs no consent, asks nothing and is not refused over the cap", async () => {
    const a = asker();
    expect(await prepareRun(plan(500), f(), est(plan(500)), base({ dryRun: true, ask: a.ask, cap: 10 }))).toBe("dry-run");
    expect(a.asked).toEqual([]);
  });

  it("refuses a run over the cap before asking anything", async () => {
    const a = asker(true, true);
    await expect(prepareRun(plan(11), f(), est(plan(11)), base({ cap: 10, ask: a.ask }))).rejects.toBeInstanceOf(CallCapError);
    expect(a.asked).toEqual([]);
  });

  it("does nothing when everything is up to date", async () => {
    expect(await prepareRun(plan(0), f(), est(plan(0)), base({}))).toBe("nothing");
  });

  it("asks consent once per repo, then confirmation every run", async () => {
    const consentPath = join(tmpDir(), "consent.json");
    const a = asker(true, true);
    expect(await prepareRun(plan(3), f(), est(plan(3)), base({ consentPath, ask: a.ask }))).toBe("run");
    expect(a.asked[0]).toMatch(/^Send source from this repo to fake at fake\.invalid\? This is asked once per repo\. \[y\/N\] $/);
    expect(a.asked[1]).toMatch(/^Proceed with 3 calls \(~3\.0k in \/ ~450 out tokens\)\? \[y\/N\] $/);
    const b = asker(true);
    expect(await prepareRun(plan(3), f(), est(plan(3)), base({ consentPath, ask: b.ask }))).toBe("run");
    expect(b.asked).toHaveLength(1); // consent is remembered; confirmation is asked again
    expect(b.asked[0]).toMatch(/^Proceed with/);
  });

  it("records nothing when consent is declined, and stops when the run is declined", async () => {
    const consentPath = join(tmpDir(), "consent.json");
    expect(await prepareRun(plan(3), f(), est(plan(3)), base({ consentPath, ask: asker(false).ask }))).toBe("declined-consent");
    expect(existsSync(consentPath)).toBe(false);
    expect(await prepareRun(plan(3), f(), est(plan(3)), base({ consentPath, ask: asker(true, false).ask }))).toBe("declined-run");
    expect(existsSync(consentPath)).toBe(true);
  });

  it("--yes confirms the run but never grants consent", async () => {
    const consentPath = join(tmpDir(), "consent.json");
    const a = asker(true);
    expect(await prepareRun(plan(3), f(), est(plan(3)), base({ consentPath, yes: true, ask: a.ask }))).toBe("run");
    expect(a.asked).toHaveLength(1); // consent was still asked
    await expect(prepareRun(plan(3), f(), est(plan(3)), base({ consentPath: join(tmpDir(), "c.json"), yes: true, interactive: false }))).rejects.toBeInstanceOf(
      ConsentRequiredError,
    );
  });

  it("without a terminal: consent can't be given, and a consented run still needs --yes", async () => {
    const consentPath = join(tmpDir(), "consent.json");
    const err = await prepareRun(plan(3), f(), est(plan(3)), base({ consentPath, interactive: false })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsentRequiredError);
    expect((err as Error).message).toMatch(/Run `cairn summarize` once in a terminal \(--yes confirms a run but never grants consent\)/);
    grantConsent(consentPath, f());
    await expect(prepareRun(plan(3), f(), est(plan(3)), base({ consentPath, interactive: false }))).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect(await prepareRun(plan(3), f(), est(plan(3)), base({ consentPath, interactive: false, yes: true }))).toBe("run");
  });

  it("needs no consent for a local summarizer", async () => {
    const local = new FakeSummarizer("fake-1", false);
    const a = asker(true);
    expect(await prepareRun(plan(2), local, estimateRun(plan(2), local, cfg()), base({ ask: a.ask }))).toBe("run");
    expect(a.asked).toHaveLength(1);
    expect(a.asked[0]).toMatch(/^Proceed/);
  });
});

describe("isYes", () => {
  it.each([["y", true], ["Y", true], [" yes ", true], ["YES", true], ["", false], ["n", false], ["ye", false], ["yes please", false]])("%j → %s", (a, want) => {
    expect(isYes(a)).toBe(want);
  });
});
