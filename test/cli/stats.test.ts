import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStats } from "../../src/core/stats.js";
import type { StatsReport } from "../../src/core/stats.js";
import { FakeSummarizer } from "../../src/summarizers/index.js";
import { cli, cliWith } from "../helpers/cli.js";
import { makeRepo } from "../helpers/repo.js";

const BIG = Array.from({ length: 40 }, (_, i) => `export function f${i}(x: number): number {\n  return x + ${i};\n}\n`).join("");

async function repo() {
  const r = makeRepo({ "src/big.ts": BIG, "src/small.ts": "export const s = 1;\n" });
  await cli(r.dir, "init");
  return r;
}

const events = (dir: string) => readStats(join(dir, ".cairn/stats.jsonl")).events;

describe("stats from commands", () => {
  it("map, read and context each log one serve event with estimated served and full-read tokens", async () => {
    const r = await repo();
    await cli(r.dir, "map");
    await cli(r.dir, "read", "src/big.ts#f3");
    await cli(r.dir, "--agent", "claude-code", "context");
    const [map, read, ctx] = events(r.dir);
    expect(map).toMatchObject({ type: "serve", command: "map", agent: "default" });
    expect(read).toMatchObject({ type: "serve", command: "read" });
    expect(ctx).toMatchObject({ type: "serve", command: "context", agent: "claude-code" });
    if (read?.type !== "serve" || map?.type !== "serve" || ctx?.type !== "serve") throw new Error("expected serve events");
    expect(read.served_tokens).toBeLessThan(read.full_read_tokens / 5); // one symbol vs the whole file
    expect(read.full_read_tokens).toBe(Math.ceil(Buffer.byteLength(BIG) / 4));
    expect(map.full_read_tokens).toBeGreaterThan(read.full_read_tokens);
    expect(ctx.full_read_tokens).toBe(map.full_read_tokens); // first session: the repo map
  });

  it("context after a change counts only the changed files as the full read", async () => {
    const r = await repo();
    await cli(r.dir, "--agent", "a1", "context");
    r.write("src/small.ts", "export const s = 2;\n");
    await cli(r.dir, "--agent", "a1", "context");
    const last = events(r.dir).at(-1);
    expect(last).toMatchObject({ command: "context", full_read_tokens: Math.ceil(Buffer.byteLength("export const s = 2;\n") / 4) });
  });

  it("logs nothing for failed commands, and never stores source or prompt text", async () => {
    const r = await repo();
    await cli(r.dir, "read", "src/nope.ts");
    expect(events(r.dir)).toEqual([]);
    await cli(r.dir, "read", "src/big.ts#f1");
    expect(readFileSync(join(r.dir, ".cairn/stats.jsonl"), "utf8")).not.toMatch(/return x|export function/);
  });

  it("summarize logs one event per call with the provider's usage, and the cost when priced", async () => {
    const r = await repo();
    writeFileSync(join(r.dir, ".cairn/config.toml"), "[summarizer]\nprice_input_per_mtok = 1.0\nprice_output_per_mtok = 2.0\n");
    const fake = new FakeSummarizer();
    const res = await cliWith({ interactive: true, answers: [true, true], summarizer: fake }, r.dir, "summarize");
    expect(res.code).toBe(0);
    const calls = events(r.dir).filter((e) => e.type === "summarize");
    expect(calls).toHaveLength(fake.calls.length);
    expect(calls[0]).toMatchObject({ provider: "fake", model: "fake-1", output_tokens: 12, agent: "default" });
    const c = calls[0];
    if (c?.type !== "summarize") throw new Error();
    expect(c.cost_usd).toBeCloseTo((c.input_tokens * 1 + 12 * 2) / 1e6);
  });

  it("a broken stats file never breaks a command", async () => {
    const r = await repo();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(r.dir, ".cairn/stats.jsonl"));
    expect((await cli(r.dir, "map")).code).toBe(0);
  });
});

describe("cairn stats", () => {
  it("says when there is nothing yet", async () => {
    const r = await repo();
    const res = await cli(r.dir, "stats");
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/^No stats yet \(all time\)\./);
  });

  it("reports served vs full read per command and agent, and summarizer spend", async () => {
    const r = await repo();
    await cli(r.dir, "map");
    await cli(r.dir, "read", "src/big.ts#f3");
    await cli(r.dir, "--agent", "claude-code", "context");
    await cliWith({ interactive: true, answers: [true, true], summarizer: new FakeSummarizer() }, r.dir, "summarize");
    const res = await cli(r.dir, "stats");
    expect(res.out).toMatch(/^CAIRN stats \(all time; token counts are estimates\)/);
    expect(res.out).toMatch(/ {2}read +1 × +served ~\d+ +vs full read ~\d+ +saved ~\d+ \(\d+%\)/);
    expect(res.out).toContain("By agent:");
    expect(res.out).toMatch(/Summarizer: 4 calls, .* out tokens \(as reported by the provider\), cost unknown/);
    const j = (await cli(r.dir, "--json", "stats")).json() as StatsReport;
    expect(j.serve.byCommand).toHaveProperty("map");
    expect(j.summarize.calls).toBe(4);
    // stats itself is not logged
    expect(events(r.dir).filter((e) => e.type === "serve")).toHaveLength(3);
  });

  it("filters with --since and --agent, and rejects a bad --since", async () => {
    const r = await repo();
    await cli(r.dir, "--agent", "claude-code", "map");
    await cli(r.dir, "map");
    const mine = (await cli(r.dir, "--json", "--agent", "claude-code", "stats")).json() as StatsReport;
    expect(mine.serve.total.events).toBe(1);
    expect(((await cli(r.dir, "--json", "stats", "--since", "1h")).json() as StatsReport).serve.total.events).toBe(2);
    const bad = await cli(r.dir, "stats", "--since", "yesterday");
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/use a duration like 30m, 24h, 7d or 4w/);
  });
});
