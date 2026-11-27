import type { Command } from "commander";
import { AmbiguousSymbolError, numberLines, readTarget } from "../core/read.js";
import { renderSymbol } from "../core/skeleton/index.js";
import { withWorkspace } from "../core/workspace.js";
import { CliError, emit, type GlobalOptions, type Io } from "./io.js";
import { formatTokens } from "./map.js";
import { logServe } from "./stats-log.js";

export function registerRead(program: Command, io: Io): void {
  program
    .command("read")
    .argument("<target>", "path, or path#symbol (e.g. src/auth.ts#login or src/auth.ts#Session.refresh)")
    .description("source of one symbol by its line range, or the whole file, with line numbers")
    .option("--no-line-numbers", "print the source as is")
    .action(async (target: string, opts: { lineNumbers: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      await withWorkspace(io.cwd, async (ws) => {
        try {
          const r = await readTarget(ws, target);
          const out = emit(io, g, r, () => {
            const what = r.symbol ? `${r.path}#${r.symbol.sym}` : r.path;
            const detail = r.symbol ? `  ${renderSymbol(r.symbol, { lines: false })}` : "";
            const header = `${what}  L${r.lines[0]}-${r.lines[1]} of ${r.totalLines}, ~${formatTokens(r.tokens.served)} tok${r.symbol ? ` (file ~${formatTokens(r.tokens.file)})` : ""}${detail}\n`;
            return header + (opts.lineNumbers ? numberLines(r.source, r.lines[0]) : r.source);
          });
          logServe(ws, g, io, "read", out, r.tokens.file);
        } catch (e) {
          if (e instanceof AmbiguousSymbolError) throw new CliError(e.message, 2);
          throw e;
        } finally {
          for (const w of ws.warnings) io.err(`cairn: ${w}\n`);
        }
      });
    });
}
