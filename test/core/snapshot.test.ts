import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NotInitializedError, snapshot } from "../../src/core/snapshot.js";
import { openRepo } from "../../src/git/index.js";
import { makeRepo, type TempRepo } from "../helpers/repo.js";
import { guard } from "../helpers/safety.js";

function init(r: TempRepo) {
  mkdirSync(join(r.dir, ".cairn"), { recursive: true });
  return r;
}

const files = (r: TempRepo, tree: string) =>
  r
    .git("ls-tree", "-r", "--name-only", tree)
    .split("\n")
    .filter(Boolean);

describe("snapshot", () => {
  it("captures uncommitted, untracked and deleted files", async () => {
    const r = init(makeRepo({ "a.ts": "a\n", "gone.ts": "g\n", "src/keep.ts": "k\n" }));
    r.write("a.ts", "edited\n");
    r.remove("gone.ts");
    r.write("src/new.ts", "n\n");
    guard(r);

    const s = await snapshot(await openRepo(r.dir));
    expect(files(r, s.tree)).toEqual(["a.ts", "src/keep.ts", "src/new.ts"]);
    expect(r.git("cat-file", "-p", `${s.tree}:a.ts`)).toBe("edited\n");
    expect(s.head).toBe(r.git("rev-parse", "HEAD").trim());
  });

  it("equals the tree git would commit, and is deterministic", async () => {
    const r = init(makeRepo({ "a.ts": "a\n", "lib/b.ts": "b\n" }));
    r.write("lib/c.ts", "c\n");
    const repo = await openRepo(r.dir);
    const s1 = await snapshot(repo);
    const s2 = await snapshot(repo);
    expect(s2.tree).toBe(s1.tree);
    r.git("add", "-A", "--", ".", ":(exclude).cairn"); // cairn init gitignores .cairn/; this fixture didn't
    r.git("commit", "-q", "-m", "all");
    expect(r.git("rev-parse", "HEAD^{tree}").trim()).toBe(s1.tree);
  });

  it("leaves out gitignored, built-in denied, .cairnignore'd and .cairn files", async () => {
    const r = init(
      makeRepo({
        ".gitignore": "*.log\n",
        ".cairnignore": "generated/\n*.snap\n",
        "src/app.ts": "x\n",
        "config/secrets.yaml": "tracked: secret\n", // tracked and denied
        "generated/schema.ts": "tracked: ignored by cairn\n",
      }),
    );
    r.write("debug.log", "gitignored\n");
    r.write(".env", "API_KEY=sk-live-123\n");
    r.write("certs/dev.pem", "-----BEGIN PRIVATE KEY-----\n");
    r.write("src/__snapshots__/a.snap", "untracked, cairnignored\n");
    r.write(".cairn/cache/ab/cd.json", "{}");
    guard(r);

    const s = await snapshot(await openRepo(r.dir));
    expect(files(r, s.tree)).toEqual([".cairnignore", ".gitignore", "src/app.ts"]);
    expect(s.excluded.sort()).toEqual(["config/secrets.yaml", "generated/schema.ts", "src/__snapshots__/a.snap"]);
    // Untracked secrets were never hashed into the object store.
    for (const secret of [".env", "certs/dev.pem"]) {
      expect(() => r.git("cat-file", "-e", r.git("hash-object", secret).trim())).toThrow();
    }
  });

  it("keeps files that are tracked even though .gitignore matches them, like git does", async () => {
    const r = init(makeRepo({ "build/keep.js": "tracked\n" }));
    r.write(".gitignore", "build/\n");
    r.write("build/other.js", "untracked, ignored\n");
    const s = await snapshot(await openRepo(r.dir));
    expect(files(r, s.tree)).toEqual([".gitignore", "build/keep.js"]);
  });

  it("works in a repo with no commits", async () => {
    const r = init(makeRepo({ "a.ts": "a\n" }, { commit: false }));
    guard(r);
    const s = await snapshot(await openRepo(r.dir));
    expect(s.head).toBeNull();
    expect(files(r, s.tree)).toEqual(["a.ts"]);
    expect(existsSync(join(r.dir, ".git", "index"))).toBe(false);
  });

  it("returns the empty tree for an empty repo", async () => {
    const r = init(makeRepo());
    const s = await snapshot(await openRepo(r.dir));
    expect(s.tree).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("works on a detached HEAD and while the user's index is locked", async () => {
    const r = init(makeRepo({ "a.ts": "1\n" }));
    r.write("a.ts", "2\n");
    r.commit();
    r.git("checkout", "-q", "--detach", "HEAD~1");
    writeFileSync(join(r.dir, ".git", "index.lock"), "");
    guard(r);
    const s = await snapshot(await openRepo(r.dir));
    expect(r.git("cat-file", "-p", `${s.tree}:a.ts`)).toBe("1\n");
  });

  it("does not disturb what the user has staged", async () => {
    const r = init(makeRepo({ "a.ts": "a\n", "b.ts": "b\n" }));
    r.write("a.ts", "staged\n");
    r.git("add", "a.ts");
    r.write("a.ts", "staged then edited\n");
    r.write("b.ts", "unstaged\n");
    const before = r.git("diff", "--cached");
    const done = guard(r);
    const s = await snapshot(await openRepo(r.dir));
    done();
    expect(r.git("diff", "--cached")).toBe(before);
    expect(r.git("cat-file", "-p", `${s.tree}:a.ts`)).toBe("staged then edited\n");
  });

  it("handles concurrent snapshots", async () => {
    const r = init(makeRepo({ "a.ts": "a\n" }));
    r.write("b.ts", "b\n");
    const repo = await openRepo(r.dir);
    const trees = await Promise.all([snapshot(repo), snapshot(repo), snapshot(repo)]);
    expect(new Set(trees.map((t) => t.tree)).size).toBe(1);
  });

  it("requires cairn init", async () => {
    const r = makeRepo({ "a.ts": "a\n" });
    await expect(snapshot(await openRepo(r.dir))).rejects.toBeInstanceOf(NotInitializedError);
  });
});
