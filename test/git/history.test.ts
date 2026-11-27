import { describe, expect, it } from "vitest";
import { commitsBetween, countCommits, objectExists, openRepo } from "../../src/git/index.js";
import { makeRepo } from "../helpers/repo.js";

describe("history helpers", () => {
  it("lists commits between two points, newest first, with odd subjects", async () => {
    const r = makeRepo({ "a.txt": "0" });
    const base = r.git("rev-parse", "HEAD").trim();
    r.write("a.txt", "1");
    r.commit("first: fix\ttabs");
    r.write("a.txt", "2");
    r.commit("second");
    const repo = await openRepo(r.dir);
    const commits = await commitsBetween(repo, base, "HEAD");
    expect(commits.map((c) => c.subject)).toEqual(["second", "first: fix\ttabs"]);
    expect(commits[0]?.hash).toBe(r.git("rev-parse", "HEAD").trim());
    expect(commits[0]?.author).toBe("Fixture");
    expect(await countCommits(repo, base, "HEAD")).toBe(2);
    expect(await commitsBetween(repo, base, "HEAD", 1)).toHaveLength(1);
    expect(await commitsBetween(repo, "HEAD", "HEAD")).toEqual([]);
  });

  it("checks object existence", async () => {
    const r = makeRepo({ "a.txt": "0" });
    const repo = await openRepo(r.dir);
    expect(await objectExists(repo, r.git("rev-parse", "HEAD^{tree}").trim())).toBe(true);
    expect(await objectExists(repo, "1".repeat(40))).toBe(false);
  });
});
