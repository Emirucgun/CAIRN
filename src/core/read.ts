// `cairn read <path>[#symbol]` (SPEC §CLI) and the MCP tool cairn_read_symbol:
// exact source of one symbol by its skeleton line range, or the whole file.
// Content comes from the snapshot blob, so line ranges always match it.
import { lsTree } from "../git/index.js";
import { checkIndexable, MAX_INDEXABLE_BYTES } from "./ignore.js";
import { PathNotInSnapshotError } from "./map.js";
import { langForPath, skeletonFor } from "./skeleton/index.js";
import { snapshot } from "./snapshot.js";
import { estimateTokens } from "./tokens.js";
import type { SkeletonSymbol } from "./types.js";
import { PathOutsideRepoError, toRepoPath, type Workspace } from "./workspace.js";

export interface ReadResult {
  path: string;
  /** Blob hash of the content served. */
  hash: string;
  symbol: SkeletonSymbol | null;
  /** 1-based inclusive range served. */
  lines: [number, number];
  totalLines: number;
  source: string;
  /** Estimated tokens served and for the whole file. */
  tokens: { served: number; file: number };
}

export class SymbolNotFoundError extends Error {
  constructor(
    readonly path: string,
    readonly symbol: string,
    readonly suggestions: string[],
  ) {
    super(
      `no symbol ${symbol} in ${path}` +
        (suggestions.length ? `. Did you mean: ${suggestions.join(", ")}?` : `. Run \`cairn map ${path} --all\` to list its symbols.`),
    );
    this.name = "SymbolNotFoundError";
  }
}

export class AmbiguousSymbolError extends Error {
  constructor(
    readonly path: string,
    readonly symbol: string,
    readonly candidates: SkeletonSymbol[],
  ) {
    super(`${symbol} is ambiguous in ${path}; use one of: ${candidates.map((c) => `${path}#${c.sym}`).join(", ")}`);
    this.name = "AmbiguousSymbolError";
  }
}

export class UnreadableFileError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`cairn will not serve ${path}: ${reason}`);
    this.name = "UnreadableFileError";
  }
}

/** Splits `path#symbol`. A `#` is part of the path if the whole string is a path in the snapshot. */
export function splitTarget(target: string, exists: (path: string) => boolean): { path: string; symbol: string | null } {
  const hash = target.lastIndexOf("#");
  if (hash <= 0 || exists(target)) return { path: target, symbol: null };
  const symbol = target.slice(hash + 1);
  return { path: target.slice(0, hash), symbol: symbol === "" ? null : symbol };
}

/** Exact name first, then a dotted suffix (`refresh` finds `Session.refresh`). */
export function findSymbol(symbols: readonly SkeletonSymbol[], name: string): SkeletonSymbol[] {
  const exact = symbols.filter((s) => s.sym === name);
  if (exact.length) return exact;
  return symbols.filter((s) => s.sym.endsWith(`.${name}`));
}

function suggest(symbols: readonly SkeletonSymbol[], name: string): string[] {
  const lower = name.toLowerCase();
  return symbols
    .map((s) => s.sym)
    .filter((sym) => sym.toLowerCase().includes(lower) || lower.includes(sym.toLowerCase().split(".").pop() ?? ""))
    .slice(0, 8);
}

export async function readTarget(ws: Workspace, target: string): Promise<ReadResult> {
  const snap = await snapshot(ws.repo, { paths: ws.paths });
  const resolve = (p: string) => {
    const rel = toRepoPath(ws.repo, p, ws.cwdInRepo);
    if (rel === null) throw new PathOutsideRepoError(p);
    return rel;
  };
  const blobs = await lsTree(ws.repo, snap.tree, { recursive: true });
  const known = new Map(blobs.filter((e) => e.type === "blob").map((e) => [e.path, e]));
  const { path: rawPath, symbol } = splitTarget(target, (p) => {
    const rel = toRepoPath(ws.repo, p, ws.cwdInRepo);
    return rel !== null && known.has(rel);
  });
  const path = resolve(rawPath);
  const entry = known.get(path);
  if (!entry) throw new PathNotInSnapshotError(path);

  const content = await ws.blobs.read(entry.hash);
  // Whole-file reads of big files are allowed; secrets and binaries never are.
  const verdict = checkIndexable(Math.min(content.length, MAX_INDEXABLE_BYTES), content);
  if (!verdict.ok && verdict.reason === "secret") {
    ws.warnings.push(`refused ${path}: looks like it contains a secret (${verdict.pattern}, line ${verdict.line})`);
    throw new UnreadableFileError(path, "it looks like it contains a secret (a private key)");
  }
  if (!verdict.ok && verdict.reason === "binary") throw new UnreadableFileError(path, "it is a binary file");

  const text = content.toString("utf8");
  // Blobs normally hold LF (git's clean filter converts CRLF with autocrlf),
  // but a repo without autocrlf can store CRLF: don't serve stray \r.
  const allLines = text.split(/\r?\n/);
  if (allLines.length > 1 && allLines[allLines.length - 1] === "") allLines.pop();
  const totalLines = allLines.length;

  let sym: SkeletonSymbol | null = null;
  let range: [number, number] = [1, Math.max(1, totalLines)];
  if (symbol !== null) {
    if (!langForPath(path)) throw new UnreadableFileError(path, "symbols are not supported for this file type; read the whole file instead");
    const sk = await skeletonFor({ path, hash: entry.hash, size: entry.size }, ws.skeletonDeps);
    if (sk.status !== "ok") throw new UnreadableFileError(path, `no skeleton (${sk.reason}); read the whole file instead`);
    const symbols = sk.entry.skeleton ?? [];
    const matches = findSymbol(symbols, symbol);
    if (matches.length === 0) throw new SymbolNotFoundError(path, symbol, suggest(symbols, symbol));
    if (matches.length > 1) throw new AmbiguousSymbolError(path, symbol, matches);
    sym = matches[0] ?? null;
    if (sym) range = [sym.lines[0], Math.min(sym.lines[1], totalLines)];
  }

  const source = allLines.slice(range[0] - 1, range[1]).join("\n") + "\n";
  return {
    path,
    hash: entry.hash,
    symbol: sym,
    lines: range,
    totalLines,
    source,
    tokens: { served: estimateTokens(source), file: estimateTokens(text) },
  };
}

/** `  12 | code` lines, width-aligned. */
export function numberLines(source: string, firstLine: number): string {
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  const width = String(firstLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(firstLine + i).padStart(width)} | ${l}`).join("\n") + "\n";
}
