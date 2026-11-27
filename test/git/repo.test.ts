import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { headCommit, isShallow, NotARepoError, objectAt, openRepo, revParse } from "../../src/git/index.js";
import { makeRepo } from "../helpers/repo.js";

describe("repo", () => {
  it("opens from a subdirectory", async () => {
    const r = makeRepo({ "src/a.ts": "x" });
    const repo = await openRepo(join(r.dir, "src"));
    expect(repo.root).toBe(realpathSync(r.dir));
    expect(repo.gitDir).toBe(join(realpathSync(r.dir), ".git"));
    expect(repo.commonDir).toBe(repo.gitDir);
    expect(repo.objectFormat).toBe("sha1");
  });

  it("rejects a directory outside any repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-norepo-"));
    await expect(openRepo(dir)).rejects.toBeInstanceOf(NotARepoError);
  });

  it("has no HEAD commit in an empty repo", async () => {
    const repo = await openRepo(makeRepo().dir);
    expect(await headCommit(repo)).toBeNull();
  });

  it("resolves revisions and paths", async () => {
    const r = makeRepo({ "src/a.ts": "export const a = 1;\n" });
    const repo = await openRepo(r.dir);
    const head = await headCommit(repo);
    expect(head).toBe(r.git("rev-parse", "HEAD").trim());
    expect(await objectAt(repo, "HEAD", "src/a.ts")).toBe(r.git("rev-parse", "HEAD:src/a.ts").trim());
    expect(await objectAt(repo, "HEAD", "src")).toBe(r.git("rev-parse", "HEAD:src").trim());
    expect(await objectAt(repo, "HEAD", "missing.ts")).toBeNull();
    expect(await revParse(repo, "no-such-branch")).toBeNull();
  });

  it("works on a detached HEAD", async () => {
    const r = makeRepo({ "a.txt": "1" });
    const first = r.git("rev-parse", "HEAD").trim();
    r.write("a.txt", "2");
    r.commit();
    r.git("checkout", "-q", "--detach", first);
    expect(await headCommit(await openRepo(r.dir))).toBe(first);
  });

  it("reports shallow clones", async () => {
    const r = makeRepo({ "a.txt": "1" });
    expect(await isShallow(await openRepo(r.dir))).toBe(false);
  });
});
