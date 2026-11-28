import { describe, expect, it } from "vitest";
import { snapshotListing } from "../../src/core/map.js";
import { buildPlan, type Plan } from "../../src/core/summarize/plan.js";
import { PROMPT_VERSION } from "../../src/core/summarize/prompts.js";
import { CallCapError, checkCap, runPlan } from "../../src/core/summarize/run.js";
import { withWorkspace } from "../../src/core/workspace.js";
import { FakeSummarizer, SummarizerError } from "../../src/summarizers/index.js";
import { cli } from "../helpers/cli.js";
import { makeRepo, type TempRepo } from "../helpers/repo.js";

const FILES = {
  "README.md": "# demo\nA demo app.\n",
  "package.json": '{ "name": "demo" }\n',
  "a/b/c.ts": "export function c(): number { return 1; }\n",
  "a/b/d.py": "def d():\n    return 2\n",
  "a/e.ts": "export const e = 3;\n",
  "f.dart": "int f() => 4;\n",
};

async function repo(files: Record<string, string> = FILES) {
  const r = makeRepo(files);
  await cli(r.dir, "init");
  return r;
}

async function summarize(r: TempRepo, fake = new FakeSummarizer(), root = "", concurrency = 4) {
  return withWorkspace(r.dir, async (ws) => {
    const listing = await snapshotListing(ws);
    const plan = await buildPlan(ws, listing, { root, generator: fake.generatorId(PROMPT_VERSION), sourceLines: 200 });
    const res = await runPlan(plan, fake, ws.cache, { concurrency });
    return { plan, res, fake };
  });
}

const order = (p: Plan) => p.nodes.map((n) => `${n.kind}:${n.path || "."}`);

describe("summary plan and run", () => {
  it("plans every summarizable file and folder, leaves before their folders", async () => {
    const r = await repo();
    const { plan, res, fake } = await summarize(r);
    expect(order(plan)).toEqual(["file:a/b/c.ts", "file:a/b/d.py", "folder:a/b", "file:a/e.ts", "folder:a", "file:README.md", "file:f.dart", "folder:."]);
    expect(plan.estimate.calls).toBe(8);
    expect(plan.skipped).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(res.done).toHaveLength(8);
    expect(fake.calls).toHaveLength(8);
    expect(res.usage.output_tokens).toBe(8 * 12);
  });

  it("makes no calls the second time", async () => {
    const r = await repo();
    await summarize(r);
    const { plan, fake } = await summarize(r);
    expect(plan.nodes).toEqual([]);
    expect(plan.cached).toBe(1); // the root folder entry covers everything below it
    expect(fake.calls).toHaveLength(0);
  });

  it("editing one file at depth 3 triggers exactly 4 summary calls (v0.2 acceptance)", async () => {
    const r = await repo();
    await summarize(r);
    r.write("a/b/c.ts", "export function c(): number { return 42; }\n");
    const { plan, fake } = await summarize(r);
    expect(order(plan)).toEqual(["file:a/b/c.ts", "folder:a/b", "folder:a", "folder:."]);
    expect(fake.calls).toHaveLength(4);
  });

  it("summarizes a subfolder and climbs while the other children are already summarized", async () => {
    const r = await repo();
    await summarize(r);
    r.write("a/b/c.ts", "export function c(): string { return 'x'; }\n");
    const { plan } = await summarize(r, new FakeSummarizer(), "a/b");
    expect(order(plan)).toEqual(["file:a/b/c.ts", "folder:a/b", "folder:a", "folder:."]);
    expect(plan.stoppedAt).toBeNull();
  });

  it("stops climbing at a folder whose other children have no summaries yet, and says where", async () => {
    const r = await repo();
    const { plan, fake } = await summarize(r, new FakeSummarizer(), "a/b");
    expect(order(plan)).toEqual(["file:a/b/c.ts", "file:a/b/d.py", "folder:a/b"]);
    expect(plan.stoppedAt).toBe("a"); // a/e.ts has no summary
    expect(fake.calls).toHaveLength(3);
  });

  it("summarizes a single file", async () => {
    const r = await repo();
    const { plan } = await summarize(r, new FakeSummarizer(), "a/e.ts");
    expect(order(plan)).toEqual(["file:a/e.ts"]);
    expect(plan.stoppedAt).toBe("a");
  });

  it("builds file prompts from skeleton and source head, and folder prompts without any source", async () => {
    const r = await repo();
    const { fake } = await summarize(r);
    const filePrompt = fake.calls.find((c) => c.prompt.startsWith("Path: a/b/c.ts"))?.prompt ?? "";
    expect(filePrompt).toContain("function c(): number");
    expect(filePrompt).toContain("export function c(): number { return 1; }");
    const folder = fake.calls.find((c) => c.prompt.startsWith("Path: a/b/\n"))?.prompt ?? "";
    expect(folder).toMatch(/- file c\.ts \[c\]: Summary of a\/b\/c\.ts/);
    expect(folder).not.toContain("return 1");
    const root = fake.calls.find((c) => c.prompt.startsWith("Path: ./\n"))?.prompt ?? "";
    expect(root).toContain("- file package.json: (not summarized)");
    expect(root).toContain("- folder a/: Summary of a/");
  });

  it("limits source to source_lines", async () => {
    const r = await repo({ "big.ts": Array.from({ length: 500 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n" });
    const fake = new FakeSummarizer();
    await withWorkspace(r.dir, async (ws) => {
      const plan = await buildPlan(ws, await snapshotListing(ws), { root: "", generator: fake.generatorId(1), sourceLines: 20 });
      await runPlan(plan, fake, ws.cache, { concurrency: 2 });
    });
    const p = fake.calls[0]?.prompt ?? "";
    expect(p).toContain("First 20 of 500 lines:");
    expect(p).toContain("export const v19 = 19;");
    expect(p).not.toContain("export const v20 = 20;");
  });

  it("never sends files with secrets, and still summarizes their folder", async () => {
    const key = ["sk", "_live_", "x9".repeat(12)].join("");
    const r = await repo({
      "src/pay.ts": `export const stripe = "${key}";\n`,
      "src/keys.ts": "export const k = `\n-----BEGIN EC PRIVATE KEY-----\nMHc\n`;\n",
      "src/ok.ts": "export const ok = 1;\n",
    });
    const { plan, fake } = await summarize(r);
    expect(plan.skipped.map((s) => [s.path, s.reason, s.pattern])).toEqual([
      ["src/keys.ts", "secret", "private-key"],
      ["src/pay.ts", "secret", "stripe-live-key"],
    ]);
    for (const c of fake.calls) expect(c.prompt).not.toMatch(/sk_live|PRIVATE KEY/);
    expect(order(plan)).toEqual(["file:src/ok.ts", "folder:src", "folder:."]);
    const folder = fake.calls.find((c) => c.prompt.startsWith("Path: src/\n"))?.prompt ?? "";
    expect(folder).toContain("- file keys.ts: (not summarized)");
  });

  it("does not cache a folder whose child failed, and resumes on the next run", async () => {
    const r = await repo();
    const flaky = new FakeSummarizer("fake-1", true, (q) => (q.prompt.startsWith("Path: a/b/d.py") ? new SummarizerError("network", "down") : null));
    const first = await summarize(r, flaky);
    expect(first.res.failed).toEqual([{ path: "a/b/d.py", kind: "network", message: "down" }]);
    expect(first.res.blocked.sort()).toEqual(["", "a", "a/b"]);
    expect(first.res.done.sort()).toEqual(["README.md", "a/b/c.ts", "a/e.ts", "f.dart"]);
    const second = await summarize(r);
    expect(order(second.plan)).toEqual(["file:a/b/d.py", "folder:a/b", "folder:a", "folder:."]);
    expect(second.res.failed).toEqual([]);
  });

  it("respects the concurrency limit", async () => {
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`m${i}.ts`, `export const m${i} = ${i};\n`]));
    const r = await repo(many);
    const fake = new FakeSummarizer("fake-1", true, () => null, 15);
    await summarize(r, fake, "", 3);
    expect(fake.maxInFlight).toBe(3);
    expect(fake.calls).toHaveLength(13);
  });

  it("refuses a plan over the call cap", async () => {
    const r = await repo();
    await withWorkspace(r.dir, async (ws) => {
      const plan = await buildPlan(ws, await snapshotListing(ws), { root: "", generator: "fake/fake-1@p1", sourceLines: 200 });
      expect(() => checkCap(plan, 7)).toThrow(CallCapError);
      expect(() => checkCap(plan, 7)).toThrow(/needs 8 summary calls, over the cap of 7.*--max-calls 8/);
      expect(() => checkCap(plan, 8)).not.toThrow();
    });
  });

  it("stores schema 3 entries: files carry their skeleton, folders their children's summaries", async () => {
    const r = await repo();
    const fake = new FakeSummarizer();
    await summarize(r, fake);
    await withWorkspace(r.dir, async (ws) => {
      const listing = await snapshotListing(ws);
      const ab = await ws.cache.get({ kind: "tree", hash: listing.trees.get("a/b") as string, layer: "summary", generator: fake.generatorId(1) });
      expect(ab).toMatchObject({ schema: 3, layer: "summary", path_hint: "a/b", files: null });
      expect(ab?.children?.map((c) => [c.name, c.summary?.startsWith("Summary of a/b/")])).toEqual([
        ["c.ts", true],
        ["d.py", true],
      ]);
      const c = listing.blobs.find((b) => b.path === "a/b/c.ts");
      const file = await ws.cache.get({ kind: "blob", hash: c?.hash as string, layer: "summary", generator: fake.generatorId(1) });
      expect(file?.skeleton?.map((s) => s.sym)).toEqual(["c"]);
      expect(file?.summary).toMatch(/^Summary of a\/b\/c\.ts/);
    });
  });
});
