import { describe, expect, it } from "vitest";
import { createParser, GRAMMAR_PKG_VERSION, type Lang } from "../src/core/skeleton/loader.js";

const samples: Record<Lang, [string, string]> = {
  typescript: ["export function f(a: number): string { return String(a) }", "function_declaration"],
  tsx: ["export const C = () => <div />;", "jsx_self_closing_element"],
  javascript: ["export function f(a) { return a }", "function_declaration"],
  python: ["def f(a):\n    return a\n", "function_definition"],
  dart: ["int f(int a) { return a; }", "function_signature"],
  swift: ["func f(a: Int) -> Int { return a }", "function_declaration"],
};

describe("grammars", () => {
  it("uses the pinned grammar package", () => {
    expect(GRAMMAR_PKG_VERSION).toBe("0.1.13");
  });

  for (const [lang, [src, node]] of Object.entries(samples) as [Lang, [string, string]][]) {
    it(`loads and parses ${lang}`, async () => {
      const tree = (await createParser(lang)).parse(src);
      if (!tree) throw new Error(`no tree for ${lang}`);
      expect(tree.rootNode.hasError).toBe(false);
      expect(tree.rootNode.toString()).toContain(`(${node}`);
    });
  }
});
