// Everything a command needs from its environment, injectable for tests.
import { createInterface } from "node:readline/promises";

/** Only an explicit yes counts (SPEC: consent is never assumed). */
export function isYes(answer: string): boolean {
  return /^\s*y(?:es)?\s*$/i.test(answer);
}

export interface Io {
  cwd: string;
  /** stdout is a terminal: pretty-print JSON for a human. */
  isTTY?: boolean;
  /** stdin and stdout are both a terminal, so questions can be asked. */
  interactive?: boolean;
  /** Asks a yes/no question on stderr; true only for an explicit y/yes. */
  ask?(question: string): Promise<boolean>;
  env: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
  /** Resolves once everything written to out() has been handed to the OS. */
  flush?(): Promise<void>;
}

export function processIo(): Io {
  return {
    cwd: process.cwd(),
    env: process.env,
    isTTY: process.stdout.isTTY === true,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return isYes(await rl.question(question));
      } finally {
        rl.close();
      }
    },
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    flush: () =>
      new Promise<void>((resolve, reject) => process.stdout.write("", (e) => (e ? reject(e) : resolve()))),
  };
}

export interface GlobalOptions {
  json?: boolean;
  agent?: string;
}

/**
 * Prints a result as JSON (with --json) or as text. JSON is indented only for
 * a terminal: pretty-printing a 10k-file map cost ~200 ms that tools reading
 * it don't need.
 */
export function emit(io: Io, opts: GlobalOptions, value: unknown, text: () => string): void {
  if (opts.json) io.out(JSON.stringify(value, null, io.isTTY ? 2 : undefined) + "\n");
  else io.out(text());
}

/** A failure the user can act on: printed without a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}
