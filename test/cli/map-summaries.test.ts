import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContextResult } from "../../src/core/context.js";
import type { MapFolder, MapNode, MapResult } from "../../src/core/map.js";
import { FakeSummarizer } from "../../src/summarizers/index.js";
import { cli, cliWith } from "../helpers/cli.js";
import { makeRepo, type TempRepo } from "../helpers/repo.js";

const FILES = {
  "README.md": "# demo\n",
  "a/b/c.ts": "export function c(): number { return 1; }\n",
  "a/b/d.py": "def d():\n    return 2\n",
  "a/e.ts": "export const e = 3;\n",
};

/** Poses as the configured provider, so map finds what it wrote. */
function fake() {
  const f = new FakeSummarizer("fake-1", false);
  f.provider = "ollama";
  return f;
}

async function summarized(files: Record<string, string> = FILES) {
  const r = makeRepo(files);
  await cli(r.dir, "init");
  writeFileSync(join(r.dir, ".cairn/config.toml"), '[summarizer]\nprovider = "ollama"\nmodel = "fake-1"\n');
  const res = await cliWith({ summarizer: fake() }, r.dir, "summarize", "--yes");
  expect(res.code).toBe(0);
  return r;
}

const hashOf = (r: TempRepo, path: string) => r.git("rev-parse", `HEAD:${path}`).trim();
const find = (n: MapNode, path: string): MapNode | undefined =>
  n.path === path ? n : n.kind === "folder" ? (n.children ?? []).map((c) => find(c, path)).find(Boolean) : undefined;

describe("summaries in map", () => {
  it("shows nothing and costs nothing when summaries are off", async () => {
    const r = makeRepo(FILES);
    await cli(r.dir, "init");
    const res = await cli(r.dir, "map");
    expect(res.out).not.toContain("≈");
    expect((await cli(r.dir, "--json", "map")).json()).toMatchObject({ summaries: null });
  });

  it("shows cached summaries for folders and files, labelled with their source hash", async () => {
    const r = await summarized();
    const res = await cli(r.dir, "map", "--depth", "3");
    // The snapshot's root tree, which includes the untracked .gitignore from cairn init.
    const tree = ((await cli(r.dir, "--json", "map")).json() as MapResult).tree;
    expect(res.out).toContain(`./  (5 files`);
    expect(res.out).toContain(`  ≈ (${tree.slice(0, 7)}) Summary of ./`);
    expect(res.out).toContain(`    ≈ (${hashOf(r, "a").slice(0, 7)}) Summary of a/`);
    expect(res.out).toContain(`      ≈ (${hashOf(r, "a/b/c.ts").slice(0, 7)}) Summary of a/b/c.ts`);
    expect(res.out).toContain(`    ≈ (${hashOf(r, "README.md").slice(0, 7)}) Summary of README.md`);
    expect(res.out).not.toContain("without a current summary");
    const j = (await cli(r.dir, "--json", "map", "--depth", "3")).json() as MapResult;
    expect(find(j.root, "a/b/c.ts")).toMatchObject({ summary: { hash: hashOf(r, "a/b/c.ts"), text: expect.stringMatching(/^Summary of a\/b\/c\.ts/) } });
    expect(j.summaries).toMatchObject({ generator: "ollama/fake-1@p1", foldersMissing: 0 });
  });

  it("shows a collapsed folder's summary too", async () => {
    const r = await summarized();
    const j = (await cli(r.dir, "--json", "map", "--depth", "1")).json() as MapResult;
    expect(find(j.root, "a")).toMatchObject({ children: null, summary: { hash: hashOf(r, "a") } });
  });

  it("never shows a stale summary: after an edit the changed file and its folders have none, the rest keep theirs", async () => {
    const r = await summarized();
    r.write("a/b/c.ts", "export function c(): number { return 2; }\n");
    const j = (await cli(r.dir, "--json", "map", "--depth", "3")).json() as MapResult;
    expect(find(j.root, "a/b/c.ts")?.summary).toBeNull();
    expect((find(j.root, "a/b") as MapFolder).summary).toBeNull();
    expect((find(j.root, "a") as MapFolder).summary).toBeNull();
    expect(j.root.summary).toBeNull();
    // Unchanged files keep their own summaries, through the bounded per-file fallback.
    expect(find(j.root, "a/b/d.py")?.summary).toMatchObject({ hash: hashOf(r, "a/b/d.py") });
    expect(find(j.root, "a/e.ts")?.summary).toMatchObject({ hash: hashOf(r, "a/e.ts") });
    const text = await cli(r.dir, "map", "--depth", "3");
    expect(text.out).toContain("3 folders shown without a current summary: cairn summarize");
  });

  it("maps a single file with its summary, and read never shows summaries", async () => {
    const r = await summarized();
    expect((await cli(r.dir, "map", "a/e.ts")).out).toContain(`≈ (${hashOf(r, "a/e.ts").slice(0, 7)}) Summary of a/e.ts`);
    expect((await cli(r.dir, "read", "a/e.ts")).out).not.toContain("≈");
  });

  it("never calls the model: map and context work with no key and no server", async () => {
    const r = await summarized();
    // Pose as an external provider whose key is not set: showing summaries needs no key.
    writeFileSync(join(r.dir, ".cairn/config.toml"), '[summarizer]\nprovider = "openai-compatible"\nmodel = "m"\n');
    const res = await cli(r.dir, "map");
    expect(res.code).toBe(0);
    // A different generator: nothing is cached for it, so all three folders shown lack one.
    expect(res.out).toContain("3 folders shown without a current summary: cairn summarize");
    expect(res.out).not.toContain("≈");
  });
});

describe("summaries in context", () => {
  it("shows top-level folder summaries on a first session and after changes", async () => {
    const r = await summarized();
    const first = await cli(r.dir, "--agent", "claude-code", "context");
    expect(first.out).toContain(`≈ (${hashOf(r, "a").slice(0, 7)}) Summary of a/`);
    r.write("README.md", "# demo v2\n");
    const later = (await cli(r.dir, "--json", "--agent", "claude-code", "context")).json() as ContextResult;
    // The root changed (README.md), so its summary is gone, but folder a/ is unchanged.
    expect(later.map.root.summary).toBeNull();
    expect(find(later.map.root, "a")).toMatchObject({ summary: { hash: hashOf(r, "a") } });
  });
});
