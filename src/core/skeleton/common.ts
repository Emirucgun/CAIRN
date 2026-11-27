// Shared machinery for the per-language extractors: collecting symbols with
// line ranges (including leading doc comments), signatures and imports.
import type { Node } from "web-tree-sitter";
import type { SkeletonSymbol, SymbolKind } from "../types.js";

export interface Extracted {
  skeleton: SkeletonSymbol[];
  /** Raw import specifiers, in source order, deduplicated. */
  imports: string[];
}

export const MAX_SIG_CHARS = 200;

const COMMENT_TYPES = new Set(["comment", "line_comment", "block_comment", "multiline_comment", "documentation_comment"]);

/** Collapses whitespace, drops a trailing body opener, caps the length. */
export function cleanSig(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/\s*(?:=>|[:={;]|->)\s*$/u, "").trim();
  if (s.length > MAX_SIG_CHARS) s = s.slice(0, MAX_SIG_CHARS - 1).trimEnd() + "…";
  return s;
}

export function unquote(text: string): string {
  const m = /^(?:r|b|u|f|rb|br)?("""|'''|"|'|`)([\s\S]*)\1$/i.exec(text);
  return m ? (m[2] ?? "") : text;
}

export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

export function childOfType(node: Node, ...types: string[]): Node | null {
  return namedChildren(node).find((c) => types.includes(c.type)) ?? null;
}

export interface AddOptions {
  sym: string;
  kind: SymbolKind;
  /** The node whose extent is the symbol's line range (outermost wrapper, e.g. export or decorator). */
  range: Node;
  /** Signature is the source between these offsets. */
  sigFrom: number;
  sigTo: number;
  exported: boolean;
  /** Extend the range to this node's end (Dart: the body is a sibling of the signature). */
  rangeEnd?: Node | null;
}

export class Collector {
  private readonly bySym = new Map<string, SkeletonSymbol>();
  private readonly importSet = new Set<string>();

  constructor(readonly src: string) {}

  add(o: AddOptions): void {
    const start = leadingCommentStart(o.range).startPosition.row + 1;
    const end = endRow(o.rangeEnd ?? o.range) + 1;
    const key = `${o.kind}:${o.sym}`;
    const existing = this.bySym.get(key);
    if (existing) {
      // Overloads and re-declarations: one symbol spanning all of them.
      existing.lines = [Math.min(existing.lines[0], start), Math.max(existing.lines[1], end)];
      existing.exported ||= o.exported;
      return;
    }
    this.bySym.set(key, {
      sym: o.sym,
      kind: o.kind,
      sig: cleanSig(this.src.slice(o.sigFrom, Math.max(o.sigFrom, o.sigTo))),
      lines: [start, Math.max(start, end)],
      exported: o.exported,
    });
  }

  /** Marks already-collected top-level symbols as exported (e.g. `export { a, b }`, `__all__`). */
  markExported(names: Iterable<string>): void {
    const set = new Set(names);
    for (const s of this.bySym.values()) if (set.has(s.sym)) s.exported = true;
  }

  /** Overrides export flags for top-level symbols (Python `__all__`). */
  setExportedExactly(names: ReadonlySet<string>): void {
    for (const s of this.bySym.values()) if (!s.sym.includes(".")) s.exported = names.has(s.sym);
  }

  import(spec: string): void {
    if (spec) this.importSet.add(spec);
  }

  result(): Extracted {
    const skeleton = [...this.bySym.values()].sort((a, b) => a.lines[0] - b.lines[0] || a.sym.localeCompare(b.sym));
    return { skeleton, imports: [...this.importSet] };
  }
}

/** The node or the first of the comments directly above it (no blank line between). */
function leadingCommentStart(node: Node): Node {
  let first = node;
  let prev = node.previousNamedSibling;
  while (prev && COMMENT_TYPES.has(prev.type) && prev.endPosition.row >= first.startPosition.row - 1) {
    // A trailing comment on the previous statement's line is not ours.
    const before = prev.previousSibling;
    if (before && before.endPosition.row === prev.startPosition.row && !COMMENT_TYPES.has(before.type)) break;
    first = prev;
    prev = prev.previousNamedSibling;
  }
  return first;
}

/** Last row the node occupies (tree-sitter end positions are exclusive). */
function endRow(node: Node): number {
  const { row, column } = node.endPosition;
  return column === 0 && row > node.startPosition.row ? row - 1 : row;
}
