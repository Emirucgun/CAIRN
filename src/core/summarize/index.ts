// `cairn summarize [path]` (SPEC §CLI, §Summarizer): plan, show, gate, run.
// The CLI prints the plan between planSummaries() and the gate.
import type { Summarizer } from "../../summarizers/index.js";
import { createSummarizer } from "../../summarizers/index.js";
import { PathNotInSnapshotError, snapshotListing } from "../map.js";
import { PathOutsideRepoError, toRepoPath, type Workspace } from "../workspace.js";
import { buildPlan, type Plan } from "./plan.js";
import { type Estimate, estimateRun } from "./prepare.js";
import { costUsd } from "./pricing.js";
import { PROMPT_VERSION } from "./prompts.js";
import { runPlan, type RunResult } from "./run.js";

export class SummariesOffError extends Error {
  constructor() {
    super(
      'summaries are off. To turn them on, set a provider and model in .cairn/config.toml, e.g. [summarizer] provider = "anthropic", model = "claude-haiku-5-5", and export ANTHROPIC_API_KEY. Keys are read only from env vars.',
    );
    this.name = "SummariesOffError";
  }
}

export interface Planned {
  summarizer: Summarizer;
  plan: Plan;
  estimate: Estimate;
}

export async function planSummaries(
  ws: Workspace,
  opts: { path?: string; env: NodeJS.ProcessEnv; summarizer?: Summarizer },
): Promise<Planned> {
  const summarizer = opts.summarizer ?? createSummarizer(ws.config.summarizer, opts.env);
  if (!summarizer) throw new SummariesOffError();
  const root = toRepoPath(ws.repo, opts.path ?? ".", ws.cwdInRepo);
  if (root === null) throw new PathOutsideRepoError(opts.path ?? ".");
  const listing = await snapshotListing(ws);
  if (root !== "" && !listing.trees.has(root) && !listing.blobs.some((b) => b.path === root)) throw new PathNotInSnapshotError(root);
  const plan = await buildPlan(ws, listing, {
    root,
    generator: summarizer.generatorId(PROMPT_VERSION),
    sourceLines: ws.config.summarizer.source_lines,
  });
  return { summarizer, plan, estimate: estimateRun(plan, summarizer, ws.config) };
}

export interface Executed extends RunResult {
  /** Actual cost from the usage the provider reported; null when the price is unknown. */
  costUsd: number | null;
}

export async function executeSummaries(ws: Workspace, p: Planned, onProgress?: (done: number, total: number) => void): Promise<Executed> {
  const res = await runPlan(p.plan, p.summarizer, ws.cache, {
    concurrency: ws.config.summarizer.concurrency,
    ...(onProgress ? { onProgress: (d: number, t: number) => onProgress(d, t) } : {}),
  });
  const price = p.estimate.price;
  return { ...res, costUsd: price ? costUsd(price, res.usage.input_tokens, res.usage.output_tokens) : null };
}

export { ConfirmationRequiredError, ConsentRequiredError, describePlan, prepareRun } from "./prepare.js";
export { CallCapError } from "./run.js";
