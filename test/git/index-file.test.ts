import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addAllInto,
  listIndex,
  openRepo,
  readTreeInto,
  removeFromIndex,
  UserIndexError,
  writeTreeFrom,
} from "../../src/git/index.js";
import { makeRepo, protectedState } from "../helpers/repo.js";

describe("scratch index", () => {
  it("captures uncommitted, untracked and deleted files without touching the user's index", async () => {
    const r = makeRepo({ ".gitignore": "*.log\n", "a.ts": "a\n", "gone.ts": "g\n" });
    r.write("a.ts", "edited\n");
    r.remove("gone.ts");
    r.write("new.ts", "n\n");
    r.write("debug.log", "ignored\n");
    r.git("add", "a.ts"); // user has something staged; must survive
    const repo = await openRepo(r.dir);
    const before = protectedState(r);

    const idx = join(r.dir, ".git", "cairn-test-index");
    await readTreeInto(repo, idx, "HEAD");
    await addAllInto(repo, idx);
    expect(await listIndex(repo, idx)).toEqual([".gitignore", "a.ts", "new.ts"]);
    const tree = await writeTreeFrom(repo, idx);

    expect(r.git("ls-tree", "-r", "--name-only", tree).trim().split("\n")).toEqual([".gitignore", "a.ts", "new.ts"]);
    expect(r.git("cat-file", "-p", `${tree}:a.ts`)).toBe("edited\n");
    expect(protectedState(r)).toEqual(before);
    expect(r.git("diff", "--cached", "--name-only").trim()).toBe("a.ts");
  });

  it("excludes globs before hashing, so denied files never reach the object store", async () => {
    const r = makeRepo({ "a.ts": "a\n" });
    r.write(".env.local", "SECRET=hunter2\n");
    r.write("config/server.pem", "-----BEGIN PRIVATE KEY-----\n");
    const repo = await openRepo(r.dir);
    const idx = join(r.dir, ".git", "cairn-test-index");
    await readTreeInto(repo, idx, "HEAD");
    await addAllInto(repo, idx, [".env*", "**/*.pem"]);
    expect(await listIndex(repo, idx)).toEqual(["a.ts"]);
    const secretHash = r.git("hash-object", ".env.local").trim();
    expect(() => r.git("cat-file", "-e", secretHash)).toThrow();
  });

  it("removes paths and starts from empty in a repo with no commits", async () => {
    const r = makeRepo({ "a.ts": "a\n", "b.ts": "b\n" }, { commit: false });
    const repo = await openRepo(r.dir);
    const idx = join(r.dir, ".git", "cairn-test-index");
    await readTreeInto(repo, idx, null);
    await addAllInto(repo, idx);
    await removeFromIndex(repo, idx, ["b.ts"]);
    await removeFromIndex(repo, idx, []);
    expect(await listIndex(repo, idx)).toEqual(["a.ts"]);
    await writeTreeFrom(repo, idx);
    expect(existsSync(join(r.dir, ".git", "index"))).toBe(false);
  });

  it("refuses to use the user's index", async () => {
    const r = makeRepo({ "a.ts": "a\n" });
    const repo = await openRepo(r.dir);
    await expect(readTreeInto(repo, ".git/index", null)).rejects.toBeInstanceOf(UserIndexError);
    await expect(addAllInto(repo, join(r.dir, ".git", "index"))).rejects.toBeInstanceOf(UserIndexError);
    // Same file through a symlinked path (macOS tmpdir is /var -> /private/var).
    symlinkSync(join(r.dir, ".git"), join(r.dir, "gitlink"), process.platform === "win32" ? "junction" : "dir");
    await expect(writeTreeFrom(repo, join(r.dir, "gitlink", "index"))).rejects.toBeInstanceOf(UserIndexError);
  });
});
