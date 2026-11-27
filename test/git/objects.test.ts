import { describe, expect, it } from "vitest";
import {
  diffTree,
  diffTreePatch,
  emptyTree,
  hashFiles,
  lsTree,
  openRepo,
  parseLsTree,
  parseNameStatus,
  readBlob,
} from "../../src/git/index.js";
import { makeRepo } from "../helpers/repo.js";

describe("objects", () => {
  it("parses NUL-delimited ls-tree records, including odd paths", () => {
    const out = "100644 blob aaaa 12\tsrc/a b.ts\0" + "040000 tree bbbb -\tsrc\0" + "100644 blob cccc 3\tdir/tab\there\0";
    expect(parseLsTree(out)).toEqual([
      { mode: "100644", type: "blob", hash: "aaaa", path: "src/a b.ts", size: 12 },
      { mode: "040000", type: "tree", hash: "bbbb", path: "src", size: null },
      { mode: "100644", type: "blob", hash: "cccc", path: "dir/tab\there", size: 3 },
    ]);
  });

  it("lists a tree recursively with sizes, with and without subtrees", async () => {
    const r = makeRepo({ "README.md": "hi\n", "src/a.ts": "export {}\n", "src/lib/b.ts": "x\n", "ünï code.txt": "u" });
    const repo = await openRepo(r.dir);
    const flat = await lsTree(repo, "HEAD", { recursive: true });
    expect(flat.map((e) => e.path)).toEqual(["README.md", "src/a.ts", "src/lib/b.ts", "ünï code.txt"]);
    expect(flat[0]).toMatchObject({ type: "blob", size: 3, hash: r.git("rev-parse", "HEAD:README.md").trim() });

    const withTrees = await lsTree(repo, "HEAD", { recursive: true, includeTrees: true });
    expect(withTrees.filter((e) => e.type === "tree").map((e) => e.path)).toEqual(["src", "src/lib"]);

    const top = await lsTree(repo, "HEAD");
    expect(top.map((e) => `${e.type}:${e.path}`)).toEqual(["blob:README.md", "tree:src", "blob:ünï code.txt"]);

    const only = await lsTree(repo, "HEAD", { recursive: true, paths: ["src/lib"] });
    expect(only.map((e) => e.path)).toEqual(["src/lib/b.ts"]);
  });

  it("parses name-status with renames", () => {
    expect(parseNameStatus("M\0a.ts\0R087\0old.ts\0new.ts\0D\0gone.ts\0")).toEqual([
      { status: "M", path: "a.ts" },
      { status: "R", from: "old.ts", path: "new.ts", score: 87 },
      { status: "D", path: "gone.ts" },
    ]);
  });

  it("diffs two trees", async () => {
    const r = makeRepo({ "a.ts": "one\n", "b.ts": "bee\n", "keep.ts": "same\n" });
    const repo = await openRepo(r.dir);
    const before = r.git("rev-parse", "HEAD^{tree}").trim();
    r.write("a.ts", "two\n");
    r.remove("b.ts");
    r.write("new/c.ts", "sea\n");
    r.commit();
    const after = r.git("rev-parse", "HEAD^{tree}").trim();

    expect(await diffTree(repo, before, after)).toEqual([
      { status: "M", path: "a.ts" },
      { status: "D", path: "b.ts" },
      { status: "A", path: "new/c.ts" },
    ]);
    const patch = await diffTreePatch(repo, before, after, ["a.ts"]);
    expect(patch).toContain("-one\n+two\n");
    expect(patch).not.toContain("b.ts");
  });

  it("detects renames only when asked", async () => {
    const body = "line\n".repeat(20);
    const r = makeRepo({ "old.ts": body });
    const repo = await openRepo(r.dir);
    const before = r.git("rev-parse", "HEAD^{tree}").trim();
    r.git("mv", "old.ts", "new.ts");
    r.commit();
    const after = r.git("rev-parse", "HEAD^{tree}").trim();
    expect(await diffTree(repo, before, after)).toEqual([
      { status: "A", path: "new.ts" },
      { status: "D", path: "old.ts" },
    ]);
    expect(await diffTree(repo, before, after, { renames: true })).toEqual([
      { status: "R", from: "old.ts", path: "new.ts", score: 100 },
    ]);
  });

  it("reads blobs as raw bytes", async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 10]);
    const r = makeRepo({});
    r.write("bin.dat", bytes);
    r.commit();
    const repo = await openRepo(r.dir);
    const hash = r.git("rev-parse", "HEAD:bin.dat").trim();
    expect(await readBlob(repo, hash)).toEqual(bytes);
  });

  it("hashes work-tree files like git add does, without writing objects", async () => {
    const r = makeRepo({ "a.ts": "committed\n" });
    const repo = await openRepo(r.dir);
    r.write("a.ts", "edited\n");
    r.write("untracked.ts", "new\n");
    const [a, u] = await hashFiles(repo, ["a.ts", "untracked.ts"]);
    expect(a).toBe(r.git("hash-object", "a.ts").trim());
    expect(() => r.git("cat-file", "-e", u as string)).toThrow();
    expect(await hashFiles(repo, [])).toEqual([]);
  });

  it("knows the empty tree", async () => {
    const repo = await openRepo(makeRepo().dir);
    expect(await emptyTree(repo)).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });
});
