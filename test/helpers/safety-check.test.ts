// The safety rule check must itself be able to fail: each kind of change
// it protects against is detected, and refs/notes/cairn is exempt.
import { describe, expect, it } from "vitest";
import { makeRepo, protectedStateOf } from "./repo.js";

describe("safety rule check", () => {
  it.each([
    ["the index", (r: ReturnType<typeof makeRepo>) => (r.write("a.txt", "2"), r.git("add", "a.txt"))],
    ["HEAD", (r: ReturnType<typeof makeRepo>) => r.git("checkout", "-q", "-b", "other")],
    ["a branch ref", (r: ReturnType<typeof makeRepo>) => r.git("branch", "side")],
    ["packed refs", (r: ReturnType<typeof makeRepo>) => (r.git("tag", "v1"), r.git("pack-refs", "--all"))],
  ])("detects a change to %s", (_what, change) => {
    const r = makeRepo({ "a.txt": "1" });
    const before = protectedStateOf(r.dir);
    change(r);
    expect(protectedStateOf(r.dir)).not.toEqual(before);
  });

  it("ignores refs/notes/cairn", () => {
    const r = makeRepo({ "a.txt": "1" });
    const before = protectedStateOf(r.dir);
    r.git("notes", "--ref=cairn", "add", "-m", "{}", "HEAD");
    expect(protectedStateOf(r.dir)).toEqual(before);
  });
});
