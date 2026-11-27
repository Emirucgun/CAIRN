// `cairn init` (SPEC §CLI): create .cairn/, add it to .gitignore, write the
// default config. Idempotent; never overwrites anything the user has.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Repo } from "../git/index.js";
import { writeDefaultConfig } from "./config.js";
import { CAIRN_DIR, cairnPaths } from "./paths.js";

export interface InitResult {
  root: string;
  /** What this run changed, as repo-relative paths with a short note. */
  changed: { path: string; action: "created" | "updated" }[];
  /** True if everything was already in place. */
  alreadyInitialized: boolean;
}

const GITIGNORE_ENTRY = `${CAIRN_DIR}/`;
const IGNORE_FORMS = new Set([CAIRN_DIR, `${CAIRN_DIR}/`, `/${CAIRN_DIR}`, `/${CAIRN_DIR}/`]);

/** True if .gitignore text already has a line that ignores the root .cairn directory. */
export function gitignoreHasCairn(text: string): boolean {
  return text.split(/\r?\n/).some((line) => IGNORE_FORMS.has(line.trim()));
}

export async function initRepo(repo: Repo): Promise<InitResult> {
  const paths = cairnPaths(repo);
  const changed: InitResult["changed"] = [];

  for (const dir of [paths.dir, paths.cache, paths.sessions]) {
    if ((await mkdir(dir, { recursive: true })) !== undefined) {
      changed.push({ path: relative(repo, dir) + "/", action: "created" });
    }
  }

  if (await writeDefaultConfig(paths.config)) changed.push({ path: relative(repo, paths.config), action: "created" });

  const gitignore = join(repo.root, ".gitignore");
  let text: string | null = null;
  try {
    text = await readFile(gitignore, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (text === null) {
    await writeFile(gitignore, `${GITIGNORE_ENTRY}\n`);
    changed.push({ path: ".gitignore", action: "created" });
  } else if (!gitignoreHasCairn(text)) {
    const sep = text === "" || text.endsWith("\n") ? "" : "\n";
    await writeFile(gitignore, `${text}${sep}${GITIGNORE_ENTRY}\n`);
    changed.push({ path: ".gitignore", action: "updated" });
  }

  return { root: repo.root, changed, alreadyInitialized: changed.length === 0 };
}

function relative(repo: Repo, abs: string): string {
  return abs.slice(repo.root.length + 1);
}
