import type { Node } from "web-tree-sitter";
import type { Extracted } from "./common.js";
import { createParser, type Lang } from "./loader.js";
import { extractDart } from "./dart.js";
import { extractPython } from "./python.js";
import { extractTypeScript } from "./typescript.js";

/**
 * Bump when extraction output changes for the same input: it is part of the
 * skeleton generator id, so every cached skeleton is rebuilt.
 */
export const EXTRACTOR_VERSION = 1;

type Extractor = (root: Node, src: string) => Extracted;

const EXTRACTORS: Partial<Record<Lang, Extractor>> = {
  typescript: extractTypeScript,
  tsx: extractTypeScript,
  javascript: extractTypeScript,
  python: extractPython,
  dart: extractDart,
};

export function isSupported(lang: Lang): boolean {
  return EXTRACTORS[lang] !== undefined;
}

const parsers = new Map<Lang, Promise<Awaited<ReturnType<typeof createParser>>>>();

/** Parses `src` and extracts its skeleton. Syntax errors are tolerated: tree-sitter recovers. */
export async function extractSkeleton(lang: Lang, src: string): Promise<Extracted> {
  const extractor = EXTRACTORS[lang];
  if (!extractor) throw new Error(`no skeleton extractor for ${lang}`);
  let parser = parsers.get(lang);
  if (!parser) {
    parser = createParser(lang);
    parsers.set(lang, parser);
  }
  const tree = (await parser).parse(src);
  if (!tree) throw new Error(`tree-sitter returned no tree for ${lang}`);
  try {
    return extractor(tree.rootNode, src);
  } finally {
    tree.delete();
  }
}
