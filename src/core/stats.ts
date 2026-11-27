// Token accounting (SPEC §stats.jsonl, principle 6 "Measured"): one JSON line
// per event in .cairn/stats.jsonl, rotated to stats.1.jsonl at 10 MB. Writing
// stats never fails a command; reading skips lines it can't parse.
import { appendFileSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA, StatsEvent } from "./types.js";

export const ROTATE_BYTES = 10 * 1024 * 1024;

/** Appends events; returns false (and writes nothing) if the log can't be written. */
export function appendStats(path: string, events: readonly StatsEvent[], rotateBytes = ROTATE_BYTES): boolean {
  if (events.length === 0) return true;
  try {
    const lines = events.map((e) => JSON.stringify(StatsEvent.parse(e))).join("\n") + "\n";
    try {
      if (statSync(path).size + lines.length > rotateBytes) renameSync(path, rotatedPath(path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    appendFileSync(path, lines);
    return true;
  } catch {
    return false;
  }
}

export function rotatedPath(path: string): string {
  return join(dirname(path), "stats.1.jsonl");
}

export interface ReadStats {
  events: StatsEvent[];
  /** Lines that were not valid events (corrupt, or from a newer schema). */
  skipped: number;
}

/** Reads the rotated log, then the current one, oldest first. */
export function readStats(path: string): ReadStats {
  const out: ReadStats = { events: [], skipped: 0 };
  for (const p of [rotatedPath(path), path]) {
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = StatsEvent.safeParse(JSON.parse(line));
        if (parsed.success && parsed.data.schema <= SCHEMA.stats) out.events.push(parsed.data);
        else out.skipped++;
      } catch {
        out.skipped++;
      }
    }
  }
  return out;
}

export class InvalidSinceError extends Error {
  constructor(readonly value: string) {
    super(`--since ${JSON.stringify(value)}: use a duration like 30m, 24h, 7d or 4w, or a date like 2026-11-01`);
    this.name = "InvalidSinceError";
  }
}

/** "7d" -> 7 days before now; "2026-11-01" -> that date (UTC). */
export function parseSince(value: string, now = new Date()): Date {
  const m = /^(\d+)([mhdw])$/.exec(value.trim());
  if (m) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2] as "m" | "h" | "d" | "w"];
    return new Date(now.getTime() - Number(m[1]) * unit);
  }
  if (/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/.test(value.trim())) {
    const d = new Date(value.trim().length === 10 ? `${value.trim()}T00:00:00Z` : value.trim());
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new InvalidSinceError(value);
}

export interface ServeTotals {
  events: number;
  served: number;
  fullRead: number;
}

export interface StatsReport {
  since: string | null;
  agent: string | null;
  skippedLines: number;
  serve: { total: ServeTotals; byCommand: Record<string, ServeTotals>; byAgent: Record<string, ServeTotals>; byDay: Record<string, ServeTotals> };
  summarize: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    /** Sum over calls with a known price. */
    costUsd: number;
    callsWithoutPrice: number;
    byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }>;
  };
}

const zero = (): ServeTotals => ({ events: 0, served: 0, fullRead: 0 });

export function buildReport(read: ReadStats, opts: { since?: Date; agent?: string } = {}): StatsReport {
  const report: StatsReport = {
    since: opts.since?.toISOString() ?? null,
    agent: opts.agent ?? null,
    skippedLines: read.skipped,
    serve: { total: zero(), byCommand: {}, byAgent: {}, byDay: {} },
    summarize: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, callsWithoutPrice: 0, byModel: {} },
  };
  const add = (t: ServeTotals, served: number, full: number) => {
    t.events++;
    t.served += served;
    t.fullRead += full;
  };
  for (const e of read.events) {
    if (opts.since && new Date(e.ts) < opts.since) continue;
    if (opts.agent && e.agent !== opts.agent) continue;
    if (e.type === "serve") {
      const s = report.serve;
      add(s.total, e.served_tokens, e.full_read_tokens);
      add((s.byCommand[e.command] ??= zero()), e.served_tokens, e.full_read_tokens);
      add((s.byAgent[e.agent] ??= zero()), e.served_tokens, e.full_read_tokens);
      add((s.byDay[e.ts.slice(0, 10)] ??= zero()), e.served_tokens, e.full_read_tokens);
    } else {
      const s = report.summarize;
      s.calls++;
      s.inputTokens += e.input_tokens;
      s.outputTokens += e.output_tokens;
      if (e.cost_usd === null) s.callsWithoutPrice++;
      else s.costUsd += e.cost_usd;
      const m = (s.byModel[`${e.provider}/${e.model}`] ??= { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
      m.calls++;
      m.inputTokens += e.input_tokens;
      m.outputTokens += e.output_tokens;
      m.costUsd += e.cost_usd ?? 0;
    }
  }
  return report;
}
