import { execFileSync } from "node:child_process";
import { expect } from "vitest";
import { main } from "../../src/cli/main.js";
import { protectedStateOf } from "./repo.js";

export interface CliResult {
  code: number;
  out: string;
  err: string;
  /** stdout parsed as JSON (only for --json runs). */
  json: () => unknown;
}

function repoRoot(dir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Runs the CLI in-process with `cwd` as its working directory. Every call is
 * checked against the SPEC safety rule: the user's .git/index, HEAD and all
 * refs except refs/notes/cairn must be byte-identical afterwards.
 */
export async function cli(cwd: string, ...argv: string[]): Promise<CliResult> {
  const root = repoRoot(cwd);
  const before = root ? protectedStateOf(root) : null;
  let out = "";
  let err = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, CAIRN_AGENT: undefined },
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  if (root && before) expect(protectedStateOf(root), `safety rule violated by: cairn ${argv.join(" ")}`).toEqual(before);
  return { code, out, err, json: () => JSON.parse(out) as unknown };
}
