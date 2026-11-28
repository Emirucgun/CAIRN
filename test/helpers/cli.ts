import { execFileSync } from "node:child_process";
import { expect } from "vitest";
import { main } from "../../src/cli/main.js";
import type { Summarizer } from "../../src/summarizers/index.js";
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
  return cliWith({}, cwd, ...argv);
}

export interface CliOptions {
  /** Pretend stdin/stdout are a terminal. */
  interactive?: boolean;
  /** Answers to yes/no questions, in order (missing answers are "no"). */
  answers?: boolean[];
  summarizer?: Summarizer;
  env?: NodeJS.ProcessEnv;
}

/** Like cli(), with terminal, answers, an injected summarizer or extra env. */
export async function cliWith(o: CliOptions, cwd: string, ...argv: string[]): Promise<CliResult & { asked: string[] }> {
  const root = repoRoot(cwd);
  const before = root ? protectedStateOf(root) : null;
  let out = "";
  let err = "";
  const asked: string[] = [];
  const answers = [...(o.answers ?? [])];
  const summarizer = o.summarizer;
  const code = await main(argv, {
    cwd,
    env: { ...process.env, CAIRN_AGENT: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, ...o.env },
    out: (t) => (out += t),
    err: (t) => (err += t),
    interactive: o.interactive ?? false,
    ask: (q) => (asked.push(q), Promise.resolve(answers.shift() ?? false)),
    ...(summarizer ? { summarizerFactory: () => summarizer } : {}),
  });
  if (root && before) expect(protectedStateOf(root), `safety rule violated by: cairn ${argv.join(" ")}`).toEqual(before);
  return { code, out, err, asked, json: () => JSON.parse(out) as unknown };
}
