import { extractSkeleton } from "../../src/core/skeleton/extract.js";
import type { Lang } from "../../src/core/skeleton/loader.js";

/** Compact form for assertions: "kind sym [start-end] exported? | sig". */
export async function sk(lang: Lang, src: string) {
  const { skeleton, imports } = await extractSkeleton(lang, src);
  return {
    symbols: skeleton.map((s) => `${s.exported ? "+" : "-"}${s.kind} ${s.sym} ${s.lines[0]}-${s.lines[1]} | ${s.sig}`),
    imports,
  };
}
