import { Command, CommanderError } from "commander";
import { ConfigError } from "../core/config.js";
import { PathNotInSnapshotError } from "../core/map.js";
import { SymbolNotFoundError, UnreadableFileError } from "../core/read.js";
import { NotInitializedError } from "../core/snapshot.js";
import { PathOutsideRepoError } from "../core/workspace.js";
import { InvalidFormatError, SchemaTooNewError } from "../core/types.js";
import { GitNotFoundError, GitTooOldError, NotARepoError } from "../git/index.js";
import { VERSION } from "../version.js";
import { registerDoctor } from "./doctor.js";
import { registerInit } from "./init.js";
import { registerMap } from "./map.js";
import { registerRead } from "./read.js";
import { CliError, type Io } from "./io.js";

/** Errors whose message already tells the user what to do. */
const EXPECTED = [CliError, NotARepoError, GitTooOldError, GitNotFoundError, NotInitializedError, ConfigError, SchemaTooNewError, InvalidFormatError, PathNotInSnapshotError, PathOutsideRepoError, SymbolNotFoundError, UnreadableFileError];

export function buildProgram(io: Io): Command {
  const program = new Command()
    .name("cairn")
    .description("Git-native memory layer for AI coding agents.")
    .version(VERSION)
    .option("--json", "machine-readable output")
    .option("--agent <id>", "agent identity (default: $CAIRN_AGENT, else 'default')")
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => io.err(s) });
  registerInit(program, io);
  registerDoctor(program, io);
  registerMap(program, io);
  registerRead(program, io);
  for (const cmd of program.commands) cmd.exitOverride();
  return program;
}

/** Runs the CLI with `argv` (without node and script) and returns the exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await buildProgram(io).parseAsync([...argv], { from: "user" });
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    const json = argv.includes("--json");
    const expected = EXPECTED.some((cls) => e instanceof cls);
    const message = (e as Error).message ?? String(e);
    if (json) io.out(JSON.stringify({ error: { name: (e as Error).name, message } }, null, 2) + "\n");
    io.err(`cairn: ${message}\n`);
    if (!expected && io.env.CAIRN_DEBUG) io.err(`${(e as Error).stack ?? ""}\n`);
    return e instanceof CliError ? e.exitCode : 1;
  } finally {
    process.exitCode = previous;
  }
}
