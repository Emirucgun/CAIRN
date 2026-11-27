import { main } from "../../src/cli/main.js";

export interface CliResult {
  code: number;
  out: string;
  err: string;
  /** stdout parsed as JSON (only for --json runs). */
  json: () => unknown;
}

/** Runs the CLI in-process with `cwd` as its working directory. */
export async function cli(cwd: string, ...argv: string[]): Promise<CliResult> {
  let out = "";
  let err = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, CAIRN_AGENT: undefined },
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { code, out, err, json: () => JSON.parse(out) as unknown };
}
