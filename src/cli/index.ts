import { Command } from "commander";
import { VERSION } from "../version.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("cairn")
    .description("Git-native memory layer for AI coding agents.")
    .version(VERSION)
    .option("--json", "machine-readable output")
    .option("--agent <id>", "agent identity (default: $CAIRN_AGENT or 'default')");
  return program;
}

await buildProgram().parseAsync(process.argv);
