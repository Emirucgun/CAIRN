import type { Command } from "commander";
import { type CheckStatus, runDoctor } from "../core/doctor.js";
import { emit, type GlobalOptions, type Io } from "./io.js";

const MARK: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" };

export function registerDoctor(program: Command, io: Io): void {
  program
    .command("doctor")
    .description("check git version, config, cache integrity and grammars")
    .option("--fix", "remove corrupt cache entries and unreadable session cursors")
    .action(async (opts: { fix?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      const report = await runDoctor(io.cwd, { fix: opts.fix ?? false });
      emit(io, g, report, () => {
        const width = Math.max(...report.checks.map((c) => c.id.length));
        const lines = report.checks.map((c) => {
          const head = `${MARK[c.status]}  ${c.id.padEnd(width)}  ${c.message}`;
          return c.fix && c.status !== "ok" ? `${head}\n      ${" ".repeat(width)}  → ${c.fix}` : head;
        });
        return `${lines.join("\n")}\n\n${report.healthy ? "No problems that stop CAIRN." : "CAIRN cannot run until the FAIL items are fixed."}\n`;
      });
      if (!report.healthy) process.exitCode = 1;
    });
}
