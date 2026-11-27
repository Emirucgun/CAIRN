// The gate in front of every summarize run (SPEC §Summarizer): cap, plan and
// estimate, consent once per repo, confirmation every run. Interaction goes
// through an injected `ask`, so every path is testable without a terminal.
import type { Summarizer } from "../../summarizers/index.js";
import { supportsEffort } from "../../summarizers/index.js";
import type { Config } from "../types.js";
import { grantConsent, hasConsent } from "./consent.js";
import type { Plan } from "./plan.js";
import { costUsd, factorFor, formatUsd, type Price, PRICE_TABLE_DATE, priceFor } from "./pricing.js";
import { checkCap } from "./run.js";

/** Extra output tokens per call assumed for thinking on models that think by default. */
export const EST_THINKING_TOKENS = 200;
const LIST_LIMIT = 20;

export class ConsentRequiredError extends Error {
  constructor(provider: string, host: string) {
    super(
      `sending source to ${provider} at ${host} needs your consent once for this repo, and there is no terminal to ask in. ` +
        "Run `cairn summarize` once in a terminal (--yes confirms a run but never grants consent).",
    );
    this.name = "ConsentRequiredError";
  }
}

export class ConfirmationRequiredError extends Error {
  constructor() {
    super("this run needs confirmation and there is no terminal to ask in. Review it with --dry-run, then pass --yes.");
    this.name = "ConfirmationRequiredError";
  }
}

export interface Estimate {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  price: Price | null;
  costUsd: number | null;
}

export function estimateRun(plan: Plan, summarizer: Summarizer, cfg: Config): Estimate {
  const factor = factorFor(summarizer.model, cfg.models.factors);
  const inputTokens = Math.ceil(plan.estimate.inputTokens * factor);
  const thinking = summarizer.provider === "anthropic" && supportsEffort(summarizer.model) ? EST_THINKING_TOKENS : 0;
  const outputTokens = Math.ceil((plan.estimate.outputTokens + plan.estimate.calls * thinking) * factor);
  const price = priceFor(summarizer.provider, summarizer.model, cfg.summarizer);
  return { calls: plan.estimate.calls, inputTokens, outputTokens, price, costUsd: price ? costUsd(price, inputTokens, outputTokens) : null };
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The human-readable plan shown before asking. */
export function describePlan(plan: Plan, summarizer: Summarizer, est: Estimate, cap: number): string {
  const where = plan.root === "" ? "the whole repo" : plan.root;
  const files = plan.nodes.filter((n) => n.kind === "file");
  const folders = plan.nodes.length - files.length;
  const lines = [`Summarize ${where} with ${summarizer.provider}/${summarizer.model} at ${summarizer.host}${summarizer.external ? "" : " (local)"}`];
  if (plan.nodes.length === 0) {
    lines.push(`  Nothing to do: ${plan.cached} summaries are already up to date.`);
  } else {
    lines.push(`  ${est.calls} calls: ${files.length} files, ${folders} folders (${plan.cached} already up to date)`);
    for (const f of files.slice(0, LIST_LIMIT)) lines.push(`    ${f.path}`);
    if (files.length > LIST_LIMIT) lines.push(`    … and ${files.length - LIST_LIMIT} more files`);
  }
  if (plan.skipped.length) {
    const by = new Map<string, number>();
    for (const s of plan.skipped) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
    lines.push(`  Not sent: ${[...by].map(([r, n]) => `${n} ${r}`).join(", ")} (${plan.skipped.map((s) => s.path).slice(0, 5).join(", ")}${plan.skipped.length > 5 ? ", …" : ""})`);
  }
  if (plan.stoppedAt !== null) {
    const at = plan.stoppedAt === "" ? "the repo root" : `${plan.stoppedAt}/`;
    lines.push(`  Parent folders stop at ${at}: it has other files without summaries (summarize it to include them).`);
  }
  if (plan.nodes.length) {
    lines.push(`  Estimated tokens: ~${k(est.inputTokens)} in, ~${k(est.outputTokens)} out (estimate; actual usage is reported after the run)`);
    lines.push(
      est.price && est.costUsd !== null
        ? `  Estimated cost: ~${formatUsd(est.costUsd)} (${est.price.source === "built-in" ? `built-in prices from ${PRICE_TABLE_DATE}; may be out of date` : "prices from config.toml"})`
        : "  Estimated cost: unknown (set price_input_per_mtok and price_output_per_mtok in [summarizer])",
    );
  }
  if (est.calls > cap) lines.push(`  Over the call cap of ${cap}: the run will be refused (narrow the path, or pass --max-calls ${est.calls}).`);
  return lines.join("\n");
}

export interface PrepareOptions {
  cap: number;
  dryRun: boolean;
  yes: boolean;
  /** stdin and stdout are a terminal. */
  interactive: boolean;
  /** Asks a yes/no question; resolves true only for an explicit yes. */
  ask: (question: string) => Promise<boolean>;
  consentPath: string;
  now?: Date;
}

export type Decision = "run" | "dry-run" | "nothing" | "declined-consent" | "declined-run";

export async function prepareRun(plan: Plan, summarizer: Summarizer, est: Estimate, o: PrepareOptions): Promise<Decision> {
  if (o.dryRun) return "dry-run"; // shows the plan; needs no consent, makes no calls
  checkCap(plan, o.cap); // SPEC: refused before asking
  if (plan.nodes.length === 0) return "nothing";

  if (!hasConsent(o.consentPath, summarizer)) {
    if (!o.interactive) throw new ConsentRequiredError(summarizer.provider, summarizer.host);
    const ok = await o.ask(`Send source from this repo to ${summarizer.provider} at ${summarizer.host}? This is asked once per repo. [y/N] `);
    if (!ok) return "declined-consent";
    grantConsent(o.consentPath, summarizer, o.now);
  }

  if (o.yes) return "run";
  if (!o.interactive) throw new ConfirmationRequiredError();
  const cost = est.costUsd !== null ? `, ~${formatUsd(est.costUsd)}` : "";
  return (await o.ask(`Proceed with ${est.calls} calls (~${k(est.inputTokens)} in / ~${k(est.outputTokens)} out tokens${cost})? [y/N] `)) ? "run" : "declined-run";
}
