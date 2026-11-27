// Swift. "Exported" means visible outside the file: anything not `private`
// or `fileprivate` (Swift's default `internal` is module-wide). Members are
// exported if their type is and they are not private themselves.
import type { Node } from "web-tree-sitter";
import type { SymbolKind } from "../types.js";
import { childOfType, Collector, type Extracted, namedChildren } from "./common.js";

/** `class_declaration` covers all of these; the keyword child says which. */
const DECLARATION_KINDS: Record<string, SymbolKind> = {
  class: "class",
  struct: "struct",
  enum: "enum",
  extension: "extension",
  actor: "class",
};

export function extractSwift(root: Node, src: string): Extracted {
  const c = new Collector(src);
  for (const node of namedChildren(root)) {
    if (node.type === "import_declaration") {
      const id = childOfType(node, "identifier");
      if (id) c.import(id.text);
    } else {
      declaration(c, node, "", true);
    }
  }
  return c.result();
}

function isPrivate(node: Node): boolean {
  const mods = childOfType(node, "modifiers");
  return !!mods && namedChildren(mods).some((m) => m.type === "visibility_modifier" && /^(private|fileprivate)\b/.test(m.text));
}

function declaration(c: Collector, node: Node, prefix: string, scopeExported: boolean): void {
  const inType = prefix !== "";
  const exported = scopeExported && !isPrivate(node);
  const body = node.childForFieldName("body");
  switch (node.type) {
    case "function_declaration":
    case "protocol_function_declaration": {
      const n = node.childForFieldName("name");
      if (!n) return;
      c.add({ sym: prefix + n.text, kind: inType ? "method" : "function", range: node, sigFrom: n.endIndex, sigTo: body?.startIndex ?? node.endIndex, exported });
      return;
    }
    case "init_declaration": {
      const open = node.text.indexOf("(");
      c.add({
        sym: `${prefix}init`,
        kind: "method",
        range: node,
        sigFrom: open >= 0 ? node.startIndex + open : node.startIndex,
        sigTo: body?.startIndex ?? node.endIndex,
        exported,
      });
      return;
    }
    case "property_declaration":
    case "protocol_property_declaration": {
      const isLet = node.descendantsOfType("value_binding_pattern")[0]?.text === "let";
      for (const pattern of node.childrenForFieldName("name")) {
        const n = pattern?.childForFieldName("bound_identifier") ?? pattern?.descendantsOfType("simple_identifier")[0] ?? null;
        if (!n) continue;
        const type = childOfType(node, "type_annotation");
        c.add({
          sym: prefix + n.text,
          kind: inType ? "property" : isLet ? "const" : "variable",
          range: node,
          sigFrom: type?.startIndex ?? n.endIndex,
          sigTo: type?.endIndex ?? n.endIndex,
          exported,
        });
      }
      return;
    }
    case "typealias_declaration": {
      const n = node.childForFieldName("name");
      if (n) c.add({ sym: prefix + n.text, kind: "type", range: node, sigFrom: n.endIndex, sigTo: node.endIndex, exported });
      return;
    }
    case "protocol_declaration":
    case "class_declaration": {
      const n = node.childForFieldName("name");
      if (!n) return;
      const keyword = node.childForFieldName("declaration_kind")?.text ?? node.children.find((k) => k && !k.isNamed && k.text in DECLARATION_KINDS)?.text;
      const kind: SymbolKind = node.type === "protocol_declaration" ? "protocol" : (DECLARATION_KINDS[keyword ?? "class"] ?? "class");
      // `extension Array where …` is named by its extended type; generic args aren't part of the name.
      const name = n.type === "user_type" ? (childOfType(n, "type_identifier")?.text ?? n.text) : n.text;
      const sym = prefix + name;
      c.add({ sym, kind, range: node, sigFrom: n.endIndex, sigTo: body?.startIndex ?? node.endIndex, exported });
      if (body) for (const member of namedChildren(body)) declaration(c, member, `${sym}.`, exported);
      return;
    }
  }
}
