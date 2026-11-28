import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendStats, buildReport, InvalidSinceError, parseSince, readStats, rotatedPath } from "../../src/core/stats.js";
import type { StatsEvent } from "../../src/core/types.js";
import { tmpDir } from "../helpers/tmp.js";

const serve = (over: Partial<Extract<StatsEvent, { type: "serve" }>> = {}): StatsEvent => ({
  schema: 1,
  type: "serve",
  ts: "2026-11-27T10:00:00.000Z",
  agent: "claude-code",
  command: "map",
  served_tokens: 100,
  full_read_tokens: 1000,
  ...over,
});
const call = (over: Partial<Extract<StatsEvent, { type: "summarize" }>> = {}): StatsEvent => ({
  schema: 1,
  type: "summarize",
  ts: "2026-11-27T10:00:00.000Z",
  agent: "default",
  provider: "anthropic",
  model: "claude-haiku-5-5",
  input_tokens: 1000,
  output_tokens: 50,
  cost_usd: 0.000125,
  ...over,
});

describe("stats.jsonl", () => {
  it("appends one line per event and reads them back", () => {
    const path = join(tmpDir(), "stats.jsonl");
    expect(appendStats(path, [serve(), call()])).toBe(true);
    expect(appendStats(path, [])).toBe(true);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readStats(path)).toEqual({ events: [serve(), call()], skipped: 0 });
  });

  it("rotates to stats.1.jsonl past the size limit and reads both, oldest first", () => {
    const path = join(tmpDir(), "stats.jsonl");
    appendStats(path, [serve({ served_tokens: 1 })], 400);
    appendStats(path, [serve({ served_tokens: 2 })], 400);
    appendStats(path, [serve({ served_tokens: 3 })], 400);
    expect(existsSync(rotatedPath(path))).toBe(true);
    expect(readStats(path).events.map((e) => (e.type === "serve" ? e.served_tokens : 0))).toEqual([1, 2, 3]);
  });

  it("skips unreadable and newer-schema lines", () => {
    const path = join(tmpDir(), "stats.jsonl");
    writeFileSync(path, `${JSON.stringify(serve())}\nnot json\n${JSON.stringify({ ...serve(), schema: 2 })}\n{"type":"serve"}\n\n`);
    expect(readStats(path)).toMatchObject({ events: [serve()], skipped: 3 });
  });

  it("never fails when it can't write, and refuses invalid events", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, "stats.jsonl")); // a directory where the file should be
    expect(appendStats(join(dir, "stats.jsonl"), [serve()])).toBe(false);
    expect(appendStats(join(tmpDir(), "s.jsonl"), [{ ...serve(), served_tokens: -1 } as StatsEvent])).toBe(false);
  });
});

describe("parseSince", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  it.each([
    ["30m", "2026-11-27T11:30:00.000Z"],
    ["24h", "2026-11-26T12:00:00.000Z"],
    ["7d", "2026-11-20T12:00:00.000Z"],
    ["2w", "2026-11-13T12:00:00.000Z"],
    ["2026-11-01", "2026-11-01T00:00:00.000Z"],
  ])("%s", (v, want) => expect(parseSince(v, now).toISOString()).toBe(want));

  it.each(["yesterday", "7", "-3d", "2026-13-45"])("rejects %s", (v) => expect(() => parseSince(v, now)).toThrow(InvalidSinceError));
});

describe("buildReport", () => {
  const events = [
    serve(),
    serve({ command: "read", served_tokens: 50, full_read_tokens: 400 }),
    serve({ agent: "opencode", ts: "2026-11-26T09:00:00.000Z" }),
    call(),
    call({ cost_usd: null, model: "llama3", provider: "ollama" }),
  ];

  it("totals per command, agent and day, and summarizer spend", () => {
    const r = buildReport({ events, skipped: 1 });
    expect(r.serve.total).toEqual({ events: 3, served: 250, fullRead: 2400 });
    expect(r.serve.byCommand).toEqual({ map: { events: 2, served: 200, fullRead: 2000 }, read: { events: 1, served: 50, fullRead: 400 } });
    expect(Object.keys(r.serve.byAgent).sort()).toEqual(["claude-code", "opencode"]);
    expect(Object.keys(r.serve.byDay).sort()).toEqual(["2026-11-26", "2026-11-27"]);
    expect(r.summarize).toMatchObject({ calls: 2, inputTokens: 2000, outputTokens: 100, costUsd: 0.000125, callsWithoutPrice: 1 });
    expect(r.skippedLines).toBe(1);
  });

  it("filters by time and agent", () => {
    expect(buildReport({ events, skipped: 0 }, { since: new Date("2026-11-27T00:00:00Z") }).serve.total.events).toBe(2);
    expect(buildReport({ events, skipped: 0 }, { agent: "opencode" }).serve.total).toEqual({ events: 1, served: 100, fullRead: 1000 });
  });
});
