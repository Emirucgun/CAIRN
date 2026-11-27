import { describe, expect, it } from "vitest";
import {
  assertGitVersion,
  compareVersions,
  GitError,
  GitTooOldError,
  MIN_GIT_VERSION,
  parseGitVersion,
  runGit,
} from "../../src/git/index.js";
import { makeRepo } from "../helpers/repo.js";

describe("git exec", () => {
  it("parses version strings", () => {
    expect(parseGitVersion("git version 2.43.0\n")).toEqual([2, 43, 0]);
    expect(parseGitVersion("git version 2.39.3 (Apple Git-146)")).toEqual([2, 39, 3]);
    expect(parseGitVersion("git version 2.45.windows.1")).toEqual([2, 45, 0]);
  });

  it("compares versions", () => {
    expect(compareVersions([2, 37, 9], MIN_GIT_VERSION)).toBeLessThan(0);
    expect(compareVersions([2, 38, 0], MIN_GIT_VERSION)).toBe(0);
    expect(compareVersions([3, 0, 0], MIN_GIT_VERSION)).toBeGreaterThan(0);
    expect(new GitTooOldError([2, 30, 1]).message).toMatch(/2\.30\.1 is too old.*2\.38\.0/);
  });

  it("accepts the installed git", async () => {
    await expect(assertGitVersion()).resolves.toBeDefined();
  });

  it("throws GitError with stderr on failure", async () => {
    const repo = makeRepo();
    const err = await runGit(["cat-file", "-t", "deadbeef"], { cwd: repo.dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).exitCode).not.toBe(0);
    expect((err as GitError).stderr).not.toBe("");
  });

  it("ignores inherited GIT_DIR / GIT_INDEX_FILE (e.g. inside a hook)", async () => {
    const a = makeRepo({ "a.txt": "a" });
    const b = makeRepo({ "b.txt": "b" });
    const saved = { dir: process.env.GIT_DIR, idx: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = `${b.dir}/.git`;
    process.env.GIT_INDEX_FILE = `${b.dir}/.git/index`;
    try {
      const out = await runGit(["ls-files"], { cwd: a.dir });
      expect(out.stdout.trim()).toBe("a.txt");
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.idx === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved.idx;
    }
  });
});

describe("spawn errors", () => {
  it("reports a missing working directory as such, not as missing git", async () => {
    const { MissingDirectoryError } = await import("../../src/git/index.js");
    const err = await runGit(["status"], { cwd: "/nonexistent/cairn-test-dir" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingDirectoryError);
    expect((err as Error).message).toBe("directory does not exist: /nonexistent/cairn-test-dir");
  });
});
