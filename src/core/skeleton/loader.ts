// Grammar loading for skeleton extraction.
//
// Pins (verified 2026-11-27, see docs/plans/v0.1.md §7):
// - tree-sitter-wasms 0.1.13 ships prebuilt grammars for all six v0.1 languages.
// - web-tree-sitter must stay on 0.25.x: 0.26+ rejects every grammar in that
//   package, and the Swift grammar is ABI 13, which 0.25 is the last line to accept.
// Bumping either requires re-running test/grammars.test.ts.
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);

export const LANGS = ["typescript", "tsx", "javascript", "python", "dart", "swift"] as const;
export type Lang = (typeof LANGS)[number];

export const GRAMMAR_PKG_VERSION = (
  require("tree-sitter-wasms/package.json") as { version: string }
).version;

let initialized: Promise<void> | undefined;
const languages = new Map<Lang, Promise<Language>>();

function init(): Promise<void> {
  initialized ??= Parser.init();
  return initialized;
}

export async function loadLanguage(lang: Lang): Promise<Language> {
  await init();
  let p = languages.get(lang);
  if (!p) {
    p = Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${lang}.wasm`));
    languages.set(lang, p);
  }
  return p;
}

export async function createParser(lang: Lang): Promise<Parser> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}
