// Prompt p1 (SPEC §Algorithm 2 steps 4-5). Bump PROMPT_VERSION when the text
// changes: it is part of the summary generator id, so old summaries rebuild.
import { renderSymbol } from "../skeleton/index.js";
import type { SkeletonSymbol } from "../types.js";

export const PROMPT_VERSION = 1;

export const SYSTEM_PROMPT = [
  "You write short summaries of source files and folders for a code index that other AI agents read before they open any code.",
  "Write one to three plain sentences: what this file or folder is for and the main things it provides.",
  "Describe only what the given text shows. Do not guess, do not give advice, and do not repeat the path.",
  "No Markdown, no lists, no code, no preamble.",
].join(" ");

export interface FilePromptInput {
  path: string;
  lang: string;
  skeleton: readonly SkeletonSymbol[] | null;
  /** The first `sourceLines` lines of the file. */
  head: string;
  totalLines: number;
  sourceLines: number;
}

export function filePrompt(f: FilePromptInput): string {
  const symbols = f.skeleton?.length ? f.skeleton.map((s) => renderSymbol(s)).join("\n") : "(none)";
  const shown = Math.min(f.totalLines, f.sourceLines);
  return [
    `Path: ${f.path}`,
    `Language: ${f.lang}`,
    "",
    "Symbols:",
    symbols,
    "",
    `First ${shown} of ${f.totalLines} lines:`,
    "<<<",
    f.head,
    ">>>",
    "",
    "Summarize this file.",
  ].join("\n");
}

export interface FolderChildInput {
  name: string;
  kind: "blob" | "tree";
  summary: string | null;
  /** Exported symbol names, for files with a skeleton. */
  symbols?: readonly string[];
  /** Why there is no summary, e.g. "not summarized", "binary". */
  note?: string;
}

/** A folder prompt never contains source: only names, skeleton names and child summaries. */
export function folderPrompt(path: string, children: readonly FolderChildInput[]): string {
  const lines = children.map((c) => {
    const label = c.kind === "tree" ? `folder ${c.name}/` : `file ${c.name}`;
    const syms = c.symbols?.length ? ` [${c.symbols.slice(0, 12).join(", ")}${c.symbols.length > 12 ? ", …" : ""}]` : "";
    const body = c.summary ?? `(${c.note ?? "no summary"})`;
    return `- ${label}${syms}: ${body}`;
  });
  return [`Path: ${path === "" ? "." : path}/`, "", "Contents:", ...lines, "", "Summarize what this folder is for."].join("\n");
}

/** Plain, single-paragraph, bounded: summaries are shown inline in maps. */
export function cleanSummary(text: string): string {
  let s = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[#>*\-\s]+/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 600) s = `${s.slice(0, 599).trimEnd()}…`;
  return s;
}
