import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentId,
  CacheEntry,
  InvalidFormatError,
  parseVersioned,
  SchemaTooNewError,
  SessionCursor,
} from "../../src/core/types.js";
import { skeletonEntry } from "../helpers/entries.js";

const AgentObj = z.object({ schema: z.literal(3), name: z.string() });
const HASH = "9f2c4e0000000000000000000000000000000000";
const TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

describe("CacheEntry", () => {
  it("accepts the SPEC example shape", () => {
    expect(CacheEntry.safeParse(skeletonEntry(HASH)).success).toBe(true);
  });

  it("accepts a tree summary entry with children", () => {
    const tree = {
      ...skeletonEntry(TREE),
      object: { kind: "tree", hash: TREE },
      layer: "summary",
      lang: null,
      skeleton: null,
      imports: null,
      summary: "Auth: sessions and tokens.",
      children: [{ name: "session.ts", kind: "blob", hash: HASH }],
      tokens: { source: 9000, skeleton: null, summary: 12 },
    };
    expect(CacheEntry.safeParse(tree).success).toBe(true);
  });

  it.each([
    ["blob with children", { children: [] }],
    ["skeleton layer with a summary", { summary: "nope" }],
    ["summary layer without a summary", { layer: "summary" }],
    ["inverted line range", { skeleton: [{ sym: "f", kind: "function", sig: "", lines: [9, 3], exported: false }] }],
    ["unknown symbol kind", { skeleton: [{ sym: "f", kind: "macro", sig: "", lines: [1, 1], exported: false }] }],
    ["bad hash", { object: { kind: "blob", hash: "xyz" } }],
    ["missing field", { lang: undefined }],
  ])("rejects %s", (_name, over) => {
    expect(CacheEntry.safeParse({ ...skeletonEntry(HASH), ...over }).success).toBe(false);
  });

  it("rejects a tree entry with a skeleton", () => {
    const e = { ...skeletonEntry(TREE), object: { kind: "tree", hash: TREE }, children: [] };
    expect(CacheEntry.safeParse(e).success).toBe(false);
  });
});

describe("SessionCursor", () => {
  const cursor = {
    schema: 1,
    agent: "claude-code",
    last_snapshot_tree: TREE,
    last_head: HASH,
    last_seen: "2026-11-27T07:55:00Z",
    active_task: null,
  };

  it("accepts a cursor, including one from a repo with no commits", () => {
    expect(SessionCursor.safeParse(cursor).success).toBe(true);
    expect(SessionCursor.safeParse({ ...cursor, last_head: null }).success).toBe(true);
  });

  it.each(["../etc/passwd", "a/b", "", ".hidden", "x".repeat(65), "has space"])("rejects agent id %j", (id) => {
    expect(AgentId.safeParse(id).success).toBe(false);
  });

  it.each(["claude-code", "opencode", "gemini", "my_agent.2", "Codex"])("accepts agent id %j", (id) => {
    expect(AgentId.safeParse(id).success).toBe(true);
  });
});

describe("parseVersioned", () => {
  it("rejects a higher schema than known", () => {
    expect(() => parseVersioned("cursor", SessionCursor, 1, { schema: 2 })).toThrow(SchemaTooNewError);
  });

  it("rejects missing or bad schema and non-objects", () => {
    for (const bad of [{}, { schema: "1" }, { schema: 0 }, { schema: 1.5 }, [], null, "x"]) {
      expect(() => parseVersioned("cursor", SessionCursor, 1, bad)).toThrow(InvalidFormatError);
    }
  });

  it("migrates lower schemas step by step before validating", () => {
    const migrated = parseVersioned(
      "cursor",
      SessionCursor,
      1,
      { schema: 1, agent: "a", last_snapshot_tree: TREE, last_head: null, last_seen: "2026-11-27T07:55:00Z", active_task: null },
    );
    expect(migrated.agent).toBe("a");

    // A hypothetical format at schema 3 reading a schema-1 file.
    const steps: string[] = [];
    const out = parseVersioned("x", AgentObj, 3, { schema: 1, name: "a" }, {
      1: (d) => (steps.push("1→2"), { ...d, name: `${String(d.name)}2` }),
      2: (d) => (steps.push("2→3"), { ...d, name: `${String(d.name)}3` }),
    });
    expect(steps).toEqual(["1→2", "2→3"]);
    expect(out).toEqual({ schema: 3, name: "a23" });
  });

  it("fails clearly when a migration is missing", () => {
    expect(() => parseVersioned("x", AgentObj, 3, { schema: 2, name: "a" })).toThrow(/no migration from schema 2/);
  });
});

