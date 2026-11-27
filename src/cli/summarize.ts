import type { Command } from "commander";
import { describePlan, executeSummaries, planSummaries, prepareRun } from "../core/summarize/index.js";
import { formatUsd } from "../core/summarize/pricing.js";
import { withWorkspace } from "../core/workspace.js";
import { CliError, emit, type GlobalOptions, type Io } from "./io.js";
import { formatTokens } from "./map.js";

function positiveInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new CliError("--max-calls must be a whole number of at least 1");
  return n;
}

const label = (p: string) => (p === "" ? "." : p);

export function registerSummarize(program: Command, io: Io): void {
  program
    .command("summarize")
    .argument("[path]", "folder or file, relative to the current directory (default: here)")
    .description("build missing file and folder summaries with your own API key; shows the cost and asks first")
    .option("--dry-run", "show what would be summarized and the estimate; send nothing")
    .option("-y, --yes", "confirm the run without asking (never grants consent)")
    .option("--max-calls <n>", "allow up to n calls for this run (default: [summarizer] max_calls_per_run)", positiveInt)
    .action(async (path: string | undefined, opts: { dryRun?: boolean; yes?: boolean; maxCalls?: number }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      await withWorkspace(io.cwd, async (ws) => {
        const planned = await planSummaries(ws, {
          ...(path !== undefined && { path }),
          env: io.env,
          ...(io.summarizerFactory && { summarizer: io.summarizerFactory() }),
        });
        const cap = opts.maxCalls ?? ws.config.summarizer.max_calls_per_run;
        const description = describePlan(planned.plan, planned.summarizer, planned.estimate, cap);
        // In --json mode the plan goes to stderr, so stdout stays one JSON document.
        if (g.json) io.err(`${description}\n`);
        else io.out(`${description}\n`);

        const decision = await prepareRun(planned.plan, planned.summarizer, planned.estimate, {
          cap,
          dryRun: opts.dryRun ?? false,
          yes: opts.yes ?? false,
          interactive: io.interactive ?? false,
          ask: io.ask ?? (() => Promise.resolve(false)),
          consentPath: ws.paths.consent,
        });

        const plan = {
          root: planned.plan.root,
          provider: planned.summarizer.provider,
          model: planned.summarizer.model,
          host: planned.summarizer.host,
          calls: planned.plan.estimate.calls,
          cached: planned.plan.cached,
          skipped: planned.plan.skipped,
          stoppedAt: planned.plan.stoppedAt,
          estimate: {
            inputTokens: planned.estimate.inputTokens,
            outputTokens: planned.estimate.outputTokens,
            costUsd: planned.estimate.costUsd,
          },
        };
        if (decision !== "run") {
          const note = {
            "dry-run": "Dry run: nothing was sent.",
            nothing: "",
            "declined-consent": "Nothing was sent.",
            "declined-run": "Nothing was sent.",
          }[decision];
          emit(io, g, { decision, plan }, () => (note ? `${note}\n` : ""));
          return;
        }

        const progress =
          io.interactive && !g.json ? (d: number, t: number) => io.err(`\rSummarizing ${d}/${t}…${d === t ? "\n" : ""}`) : undefined;
        const res = await executeSummaries(ws, planned, progress);
        for (const w of ws.warnings) io.err(`cairn: ${w}\n`);

        emit(io, g, { decision, plan, result: res }, () => {
          const used = `${formatTokens(res.usage.input_tokens)} in / ${formatTokens(res.usage.output_tokens)} out tokens`;
          const cost = res.costUsd !== null ? `, ~${formatUsd(res.costUsd)}` : "";
          const lines = [`Done: ${res.done.length} summaries written, ${res.failed.length} failed. Used ${used}${cost} (as reported by the provider).`];
          if (res.failed.length) {
            lines.push("Failed (run again to retry):");
            for (const f of res.failed) lines.push(`  ${label(f.path)}: ${f.message}`);
          }
          if (res.blocked.length) lines.push(`Not built because a file inside failed: ${res.blocked.map(label).join(", ")}`);
          return `${lines.join("\n")}\n`;
        });
        if (res.failed.length) process.exitCode = 1;
      });
    });
}
