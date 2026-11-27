// Token estimates (SPEC §Data model). Cache entries store a fast chars/4
// estimate: exact tokenization of every file took ~5 s per 10k files, which
// is the whole cold-map budget. Exact counts are for text CAIRN serves (v0.2
// stats and the MCP footer).

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
