import type { Command } from "commander";
import { initRepo } from "../core/init.js";
import { assertGitVersion, openRepo } from "../git/index.js";
import { emit, type GlobalOptions, type Io } from "./io.js";

export function registerInit(program: Command, io: Io): void {
  program
    .command("init")
    .description("create .cairn/, add it to .gitignore, write the default config")
    .action(async (_opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      await assertGitVersion(io.cwd);
      const result = await initRepo(await openRepo(io.cwd));
      emit(io, g, result, () => {
        if (result.alreadyInitialized) return `CAIRN is already set up in ${result.root}\n`;
        const lines = result.changed.map((c) => `  ${c.action.padEnd(7)} ${c.path}`);
        return `Set up CAIRN in ${result.root}\n${lines.join("\n")}\n\nNext: \`cairn map\` for an overview, \`cairn context\` at the start of each agent session.\n`;
      });
    });
}
