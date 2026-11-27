import type { SkeletonSymbol } from "../types.js";

/** One line per symbol, e.g. `function login(email: string): Promise<Session>  L12-48`. */
export function renderSymbol(s: SkeletonSymbol, opts: { lines?: boolean } = {}): string {
  const joiner = s.sig === "" ? "" : /^[(<[:]/.test(s.sig) ? "" : " ";
  const head = `${s.exported ? "" : "(local) "}${s.kind} ${s.sym}${joiner}${s.sig}`;
  return opts.lines === false ? head : `${head}  L${s.lines[0]}-${s.lines[1]}`;
}

export function renderSkeleton(symbols: readonly SkeletonSymbol[]): string {
  return symbols.map((s) => renderSymbol(s)).join("\n");
}
