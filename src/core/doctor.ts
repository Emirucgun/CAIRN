// `cairn doctor` (SPEC §CLI): check git, config, cache integrity and grammars.
// Every check reports a fix. Adapters are checked from v0.3.
import { access, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertGitVersion, GitTooOldError, isIgnored, openRepo, type Repo } from "../git/index.js";
import { Cache } from "./cache.js";
import { ConfigError, loadConfig } from "./config.js";
import { CAIRN_DIR, cairnPaths } from "./paths.js";
import { LANGS, loadLanguage } from "./skeleton/loader.js";
import { snapshot } from "./snapshot.js";
import { parseVersioned, SCHEMA, SessionCursor } from "./types.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

export interface DoctorReport {
  root: string | null;
  checks: Check[];
  /** True if no check failed (warnings are allowed). */
  healthy: boolean;
}

export interface DoctorOptions {
  /** Delete corrupt cache entries and unreadable session cursors. */
  fix?: boolean;
}

export async function runDoctor(cwd: string, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const done = (root: string | null) => ({ root, checks, healthy: !checks.some((c) => c.status === "fail") });

  try {
    const v = await assertGitVersion(cwd);
    add({ id: "git", status: "ok", message: `git ${v.join(".")}` });
  } catch (e) {
    add({
      id: "git",
      status: "fail",
      message: (e as Error).message,
      fix: e instanceof GitTooOldError ? "Upgrade git to 2.38 or newer" : "Install git 2.38 or newer",
    });
    return done(null);
  }

  let repo: Repo;
  try {
    repo = await openRepo(cwd);
    add({ id: "repo", status: "ok", message: repo.root });
  } catch (e) {
    add({ id: "repo", status: "fail", message: (e as Error).message, fix: "Run cairn inside a git work tree" });
    return done(null);
  }

  const paths = cairnPaths(repo);
  const initialized = await exists(paths.dir);
  add(
    initialized
      ? { id: "init", status: "ok", message: `${CAIRN_DIR}/ exists` }
      : { id: "init", status: "fail", message: `${CAIRN_DIR}/ is missing`, fix: "Run `cairn init`" },
  );

  add(
    (await isIgnored(repo, `${CAIRN_DIR}/`))
      ? { id: "gitignore", status: "ok", message: `${CAIRN_DIR}/ is ignored by git` }
      : {
          id: "gitignore",
          status: "warn",
          message: `${CAIRN_DIR}/ is not ignored by git, so it shows up in \`git status\``,
          fix: "Run `cairn init`, or add `.cairn/` to .gitignore",
        },
  );

  try {
    const config = await loadConfig(paths.config);
    const where = (await exists(paths.config)) ? "config.toml" : "defaults (no config.toml)";
    add({ id: "config", status: "ok", message: `${where}; summarizer: ${config.summarizer.provider}` });
  } catch (e) {
    add({
      id: "config",
      status: "fail",
      message: e instanceof ConfigError ? e.message : `cannot read config: ${(e as Error).message}`,
      fix: `Fix the file, or delete ${CAIRN_DIR}/config.toml and run \`cairn init\` to restore defaults`,
    });
  }

  const failed: string[] = [];
  for (const lang of LANGS) {
    try {
      await loadLanguage(lang);
    } catch {
      failed.push(lang);
    }
  }
  add(
    failed.length === 0
      ? { id: "grammars", status: "ok", message: `${LANGS.length} grammars load (${LANGS.join(", ")})` }
      : {
          id: "grammars",
          status: "fail",
          message: `grammars failed to load: ${failed.join(", ")}`,
          fix: "Reinstall CAIRN; web-tree-sitter must stay on 0.25.x",
        },
  );

  if (!initialized) {
    for (const id of ["cache", "sessions", "snapshot"]) add({ id, status: "skip", message: "not initialized" });
    return done(repo.root);
  }

  const scan = await new Cache(paths.cache).scan({ fix: opts.fix ?? false });
  if (scan.corrupt.length === 0) {
    add({ id: "cache", status: "ok", message: `${scan.ok} entries, none corrupt` });
  } else if (opts.fix) {
    add({ id: "cache", status: "ok", message: `${scan.ok} entries; removed ${scan.corrupt.length} corrupt` });
  } else {
    const reasons = [...new Set(scan.corrupt.map((c) => c.reason))].join(", ");
    add({
      id: "cache",
      status: "warn",
      message: `${scan.corrupt.length} corrupt of ${scan.ok + scan.corrupt.length} entries (${reasons}); they are rebuilt on next use`,
      fix: "Run `cairn doctor --fix` to remove them now",
    });
  }

  add(await checkSessions(paths.sessions, opts.fix ?? false));

  try {
    const t0 = performance.now();
    const s = await snapshot(repo, { paths });
    add({ id: "snapshot", status: "ok", message: `tree ${s.tree.slice(0, 12)} in ${Math.round(performance.now() - t0)} ms` });
  } catch (e) {
    add({ id: "snapshot", status: "fail", message: (e as Error).message, fix: "Report this with the message above" });
  }

  return done(repo.root);
}

async function checkSessions(dir: string, fix: boolean): Promise<Check> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const bad: string[] = [];
  for (const f of files) {
    try {
      const cursor = parseVersioned("session cursor", SessionCursor, SCHEMA.sessionCursor, JSON.parse(await readFile(join(dir, f), "utf8")));
      if (`${cursor.agent}.json` !== f) throw new Error("agent does not match file name");
    } catch {
      bad.push(f);
      if (fix) await rm(join(dir, f), { force: true });
    }
  }
  if (bad.length === 0) return { id: "sessions", status: "ok", message: `${files.length} session cursor(s)` };
  if (fix) return { id: "sessions", status: "ok", message: `removed ${bad.length} unreadable cursor(s): ${bad.join(", ")}` };
  return {
    id: "sessions",
    status: "warn",
    message: `unreadable session cursor(s): ${bad.join(", ")}; those agents will get a full repo map next time`,
    fix: "Run `cairn doctor --fix` to remove them",
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
