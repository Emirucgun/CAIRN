import type { Command } from "commander";
import { buildReport, parseSince, readStats, type ServeTotals } from "../core/stats.js";
import { formatUsd } from "../core/summarize/pricing.js";
import { withWorkspace } from "../core/workspace.js";
import { emit, type GlobalOptions, type Io } from "./io.js";
import { formatTokens } from "./map.js";

function savingLine(label: string, t: ServeTotals, width: number): string {
  const saved = t.fullRead - t.served;
  const pct = t.fullRead > 0 ? Math.round((saved / t.fullRead) * 100) : 0;
  const s = saved >= 0 ? `saved ~${formatTokens(saved)} (${pct}%)` : `~${formatTokens(-saved)} more than a full read`;
  return `  ${label.padEnd(width)}  ${String(t.events).padStart(5)} ×  served ~${formatTokens(t.served).padEnd(6)} vs full read ~${formatTokens(t.fullRead).padEnd(6)} ${s}`;
}

export function registerStats(program: Command, io: Io): void {
  program
    .command("stats")
    .description("tokens CAIRN served vs. reading the files whole, and summarizer spend (from .cairn/stats.jsonl)")
    .option("--since <when>", "only events since a duration (30m, 24h, 7d, 4w) or a date (2026-11-01)")
    .action(async (opts: { since?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const since = opts.since ? parseSince(opts.since) : undefined;
      await withWorkspace(io.cwd, async (ws) => {
        const report = buildReport(readStats(ws.paths.stats), { ...(since && { since }), ...(g.agent !== undefined && { agent: g.agent }) });
        emit(io, g, report, () => {
          const s = report.serve;
          const sum = report.summarize;
          const scope = [since ? `since ${report.since?.slice(0, 16).replace("T", " ")} UTC` : "all time", g.agent ? `agent ${g.agent}` : null]
            .filter(Boolean)
            .join(", ");
          if (s.total.events === 0 && sum.calls === 0) return `No stats yet (${scope}). They are written by map, read, context and summarize.\n`;
          const lines = [`CAIRN stats (${scope}; token counts are estimates)`, ""];
          if (s.total.events) {
            const keys = [...Object.keys(s.byCommand), ...Object.keys(s.byAgent), "total"];
            const w = Math.max(...keys.map((k) => k.length), 8);
            lines.push("Served:");
            for (const [k, t] of Object.entries(s.byCommand).sort()) lines.push(savingLine(k, t, w));
            lines.push(savingLine("total", s.total, w));
            if (Object.keys(s.byAgent).length > 1 || !g.agent) {
              lines.push("", "By agent:");
              for (const [k, t] of Object.entries(s.byAgent).sort()) lines.push(savingLine(k, t, w));
            }
            const days = Object.entries(s.byDay).sort().slice(-7);
            if (days.length > 1) {
              lines.push("", "Last days:");
              for (const [k, t] of days) lines.push(savingLine(k, t, w));
            }
          }
          if (sum.calls) {
            const cost = sum.callsWithoutPrice === sum.calls ? "cost unknown" : `~${formatUsd(sum.costUsd)}${sum.callsWithoutPrice ? ` (+${sum.callsWithoutPrice} calls without a price)` : ""}`;
            lines.push("", `Summarizer: ${sum.calls} calls, ${formatTokens(sum.inputTokens)} in / ${formatTokens(sum.outputTokens)} out tokens (as reported by the provider), ${cost}`);
            for (const [m, t] of Object.entries(sum.byModel).sort()) lines.push(`  ${m}: ${t.calls} calls, ${formatTokens(t.inputTokens)} in / ${formatTokens(t.outputTokens)} out`);
          }
          if (report.skippedLines) lines.push("", `(${report.skippedLines} unreadable lines skipped)`);
          return lines.join("\n") + "\n";
        });
      });
    });
}
