// Everything a command needs from its environment, injectable for tests.
export interface Io {
  cwd: string;
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

/** Prints a result as JSON (with --json) or as text. */
export function emit(io: Io, opts: GlobalOptions, value: unknown, text: () => string): void {
  if (opts.json) io.out(JSON.stringify(value, null, 2) + "\n");
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
