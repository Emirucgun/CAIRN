import type { Command } from "commander";
import { buildMap, DEFAULT_MAP_DEPTH, DEFAULT_MAX_SYMBOLS, type MapNode } from "../core/map.js";
import { renderSymbol } from "../core/skeleton/index.js";
import { withWorkspace } from "../core/workspace.js";
import { CliError, emit, type GlobalOptions, type Io } from "./io.js";

const SKIP_LABEL = { "too-large": "over 1 MiB", binary: "binary", secret: "skipped: may contain a secret" } as const;

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

export function renderMap(node: MapNode, indent = ""): string[] {
  if (node.kind === "file") {
    const tags = [`~${formatTokens(node.tokens)} tok`];
    if (node.skipped) tags.push(SKIP_LABEL[node.skipped]);
    const lines = [`${indent}${node.name}  (${tags.join(", ")})`];
    for (const s of node.symbols) lines.push(`${indent}  ${renderSymbol(s)}`);
    if (node.hiddenSymbols > 0) lines.push(`${indent}  … ${node.hiddenSymbols} more (--all, or cairn read ${node.path})`);
    return lines;
  }
  const head = `${indent}${node.path === "" ? "." : node.name}/  (${node.files} file${node.files === 1 ? "" : "s"}, ~${formatTokens(node.tokens)} tok)`;
  if (!node.children) return [head];
  return [head, ...node.children.flatMap((c) => renderMap(c, `${indent}  `))];
}

function positiveInt(name: string) {
  return (v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new CliError(`${name} must be a whole number of at least 1`);
    return n;
  };
}

export function registerMap(program: Command, io: Io): void {
  program
    .command("map")
    .argument("[path]", "folder or file, relative to the current directory")
    .description("tree of folders with each file's symbols (exported by default)")
    .option("--depth <n>", `folder levels to expand, counting the start folder (default ${DEFAULT_MAP_DEPTH})`, positiveInt("--depth"))
    .option("--all", "include non-exported symbols")
    .option("--max-symbols <n>", `symbols listed per file (default ${DEFAULT_MAX_SYMBOLS})`, positiveInt("--max-symbols"))
    .action(async (path: string | undefined, opts: { depth?: number; all?: boolean; maxSymbols?: number }, cmd: Command) => {
      const g = cmd.optsWithGlobals<GlobalOptions>();
      await withWorkspace(io.cwd, async (ws) => {
        const result = await buildMap(ws, {
          ...(path !== undefined && { path }),
          ...(opts.depth !== undefined && { depth: opts.depth }),
          ...(opts.all !== undefined && { all: opts.all }),
          ...(opts.maxSymbols !== undefined && { maxSymbols: opts.maxSymbols }),
        });
        emit(io, g, { ...result, warnings: ws.warnings }, () => renderMap(result.root).join("\n") + "\n");
        for (const w of ws.warnings) io.err(`cairn: ${w}\n`);
      });
    });
}
