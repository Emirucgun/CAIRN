// Temp git repo fixtures. Tests may call git directly to *set up* state;
// code under test must go through src/git/.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

export interface TempRepo {
  dir: string;
  git(...args: string[]): string;
  write(path: string, content: string | Buffer): void;
  remove(path: string): void;
  commit(message?: string): string;
}

const created: string[] = [];

afterEach(() => {
  while (created.length) rmSync(created.pop() as string, { recursive: true, force: true });
});

const fixtureEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

/** Isolate the code under test from the developer's git config too. */
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

export function makeRepo(files: Record<string, string> = {}, opts: { commit?: boolean } = {}): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), "cairn-test-"));
  created.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env: fixtureEnv, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const repo: TempRepo = {
    dir,
    git,
    write(path, content) {
      const abs = join(dir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    remove(path) {
      rmSync(join(dir, path), { recursive: true, force: true });
    },
    commit(message = "commit") {
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD").trim();
    },
  };
  for (const [path, content] of Object.entries(files)) repo.write(path, content);
  if (opts.commit ?? Object.keys(files).length > 0) repo.commit("initial");
  return repo;
}

/**
 * Everything the safety rule protects: the user's index bytes, HEAD, and
 * every ref except refs/notes/cairn. Compare before and after a command.
 */
export function protectedState(repo: TempRepo): Record<string, string> {
  const gitDir = join(repo.dir, ".git");
  const read = (p: string) => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
  const refs = repo
    .git("for-each-ref", "--format=%(refname) %(objectname)")
    .split("\n")
    .filter((l) => l && !l.startsWith("refs/notes/cairn "))
    .join("\n");
  return {
    index: createHash("sha256").update(read(join(gitDir, "index"))).digest("hex"),
    HEAD: read(join(gitDir, "HEAD")).toString(),
    packedRefs: read(join(gitDir, "packed-refs"))
      .toString()
      .split("\n")
      .filter((l) => !l.includes("refs/notes/cairn"))
      .join("\n"),
    refs,
  };
}
