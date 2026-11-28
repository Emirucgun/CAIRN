import { describe, expect, it } from "vitest";
import { FakeSummarizer, SummarizerError } from "../../src/summarizers/index.js";

describe("FakeSummarizer", () => {
  it("is deterministic, records calls and can fail on demand", async () => {
    const f = new FakeSummarizer("fake-1", true, (r) => (r.prompt.includes("bad") ? new SummarizerError("refusal", "no") : null));
    const a = await f.summarize({ system: "s", prompt: "Path: src/a.ts\nx" });
    const b = await f.summarize({ system: "s", prompt: "Path: src/a.ts\nx" });
    expect(a).toEqual(b);
    expect(a.text).toMatch(/^Summary of src\/a\.ts \([0-9a-f]{8}\)\.$/);
    await expect(f.summarize({ system: "s", prompt: "Path: bad" })).rejects.toMatchObject({ kind: "refusal" });
    expect(f.calls).toHaveLength(3);
    expect(f.generatorId(1)).toBe("fake/fake-1@p1");
  });
});
