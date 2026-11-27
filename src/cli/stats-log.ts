// Writes stats.jsonl events after a command has printed its output.
import type { Workspace } from "../core/workspace.js";
import { resolveAgent } from "../core/sessions.js";
import { appendStats } from "../core/stats.js";
import { estimateTokens } from "../core/tokens.js";
import type { StatsEvent } from "../core/types.js";
import type { GlobalOptions, Io } from "./io.js";

/** The agent id for stats; null (log nothing) if the id is invalid. */
export function statsAgent(g: GlobalOptions, io: Io): string | null {
  try {
    return resolveAgent(g.agent, io.env).id;
  } catch {
    return null;
  }
}

export function logServe(ws: Workspace, g: GlobalOptions, io: Io, command: "map" | "read" | "context", output: string, fullReadTokens: number): void {
  const agent = statsAgent(g, io);
  if (!agent) return;
  appendStats(ws.paths.stats, [
    {
      schema: 1,
      type: "serve",
      ts: new Date().toISOString(),
      agent,
      command,
      served_tokens: estimateTokens(output),
      full_read_tokens: Math.max(0, Math.round(fullReadTokens)),
    },
  ]);
}

export function logEvents(ws: Workspace, events: StatsEvent[]): void {
  appendStats(ws.paths.stats, events);
}
