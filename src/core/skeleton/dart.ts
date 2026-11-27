// Dart. "Exported" means not library-private (no leading `_`). The Dart
// grammar keeps a function's body as the *next sibling* of its signature, and
// splits top-level variable declarations across sibling nodes (keyword, type,
// names), so ranges are stitched from siblings here.
import type { Node } from "web-tree-sitter";
import type { SymbolKind } from "../types.js";
import { childOfType, Collector, type Extracted, namedChildren, unquote } from "./common.js";

const SIGNATURES = new Set(["function_signature", "getter_signature", "setter_signature"]);
const VAR_LISTS = new Set(["static_final_declaration_list", "initialized_identifier_list"]);
const VAR_ITEMS = new Set(["static_final_declaration", "initialized_identifier"]);
const KEYWORDS = new Set(["const_builtin", "final_builtin", "late_builtin", "static", "covariant", "external_builtin", "abstract"]);
const BOUNDARIES = new Set([";", "}", "comment", "documentation_comment"]);

const isPublic = (name: string) => !name.startsWith("_");

export function extractDart(root: Node, src: string): Extracted {
  const c = new Collector(src);
  const top = root.children.filter((n): n is Node => n !== null);
  top.forEach((node, i) => {
    switch (node.type) {
      case "import_or_export":
        for (const uri of node.descendantsOfType("uri")) if (uri) c.import(unquote(uri.text));
        return;
      case "part_directive": {
        const uri = childOfType(node, "uri");
        if (uri) c.import(unquote(uri.text));
        return;
      }
    }
    if (SIGNATURES.has(node.type)) {
      const n = node.childForFieldName("name");
      if (n) {
        const next = top[i + 1];
        const body = next?.type === "function_body" ? next : null;
        c.add({ sym: n.text, kind: "function", range: node, rangeEnd: body, sigFrom: n.endIndex, sigTo: node.endIndex, exported: isPublic(n.text) });
      }
    } else if (VAR_LISTS.has(node.type)) {
      variables(c, top, i, "", true, "variable");
    } else {
      typeDeclaration(c, node);
    }
  });
  return c.result();
}

function typeDeclaration(c: Collector, node: Node): void {
  const declared: Partial<Record<string, SymbolKind>> = {
    class_definition: "class",
    mixin_declaration: "mixin",
    extension_declaration: "extension",
    enum_declaration: "enum",
    type_alias: "type",
  };
  const kind = declared[node.type];
  if (!kind) return;
  const n =
    node.childForFieldName("name") ??
    (kind === "extension" ? node.childForFieldName("class") : childOfType(node, "identifier", "type_identifier"));
  if (!n) return;
  const body = node.childForFieldName("body") ?? childOfType(node, "class_body", "extension_body", "enum_body");
  const exported = isPublic(n.text);
  c.add({ sym: n.text, kind, range: node, sigFrom: n.endIndex, sigTo: body?.startIndex ?? node.endIndex, exported });
  if (body && kind !== "enum") members(c, body, n.text, exported);
}

function members(c: Collector, body: Node, owner: string, ownerExported: boolean): void {
  const items = body.children.filter((n): n is Node => n !== null);
  items.forEach((item, i) => {
    if (item.type !== "declaration" && item.type !== "method_signature") return;
    const next = items[i + 1];
    const fnBody = next?.type === "function_body" ? next : null;
    const sig = namedChildren(item).find((n) => n.type.endsWith("signature")) ?? null;
    if (sig) {
      const name = memberName(sig, owner);
      if (!name) return;
      c.add({
        sym: `${owner}.${name.sym}`,
        kind: "method",
        range: item,
        rangeEnd: fnBody,
        sigFrom: name.after,
        sigTo: sig.endIndex,
        exported: ownerExported && isPublic(name.sym),
      });
      return;
    }
    // Fields: `final double w;`, `static const x = 1;`, `int _n = 0;`
    const list = namedChildren(item).find((n) => VAR_LISTS.has(n.type));
    if (list) {
      const parts = namedChildren(item);
      variables(c, parts, parts.indexOf(list), `${owner}.`, ownerExported, "property", item);
    }
  });
}

/** Constructor names follow Dart's tear-off convention: `Owner.new` for the unnamed one. */
function memberName(sig: Node, owner: string): { sym: string; after: number } | null {
  if (sig.type === "constructor_signature" || sig.type === "factory_constructor_signature") {
    const ids = namedChildren(sig).filter((n) => n.type === "identifier");
    const last = ids[ids.length - 1];
    if (!last) return null;
    return { sym: ids.length > 1 ? last.text : "new", after: last.endIndex };
  }
  const n = sig.childForFieldName("name") ?? childOfType(sig, "identifier");
  if (!n) return null;
  return { sym: n.text === owner ? "new" : n.text, after: n.endIndex };
}

/**
 * Declares every name in the variable list at `siblings[i]`. The keyword and
 * type are the siblings before it, back to the previous statement boundary.
 */
function variables(
  c: Collector,
  siblings: readonly Node[],
  i: number,
  prefix: string,
  scopeExported: boolean,
  kind: "variable" | "property",
  rangeNode?: Node,
): void {
  const list = siblings[i];
  if (!list) return;
  let start = i;
  while (start > 0) {
    const prev = siblings[start - 1];
    if (!prev || BOUNDARIES.has(prev.type) || !prev.isNamed || VAR_LISTS.has(prev.type) || prev.type.endsWith("_declaration") || prev.type === "class_definition") break;
    start--;
  }
  const prefixNodes = siblings.slice(start, i);
  const isConst = prefixNodes.some((n) => n.type === "const_builtin" || n.type === "final_builtin");
  const types = prefixNodes.filter((n) => !KEYWORDS.has(n.type) && n.type !== "inferred_type");
  const firstType = types[0];
  const lastType = types[types.length - 1];
  for (const item of namedChildren(list)) {
    if (!VAR_ITEMS.has(item.type)) continue;
    const n = childOfType(item, "identifier");
    if (!n) continue;
    c.add({
      sym: prefix + n.text,
      kind: kind === "property" ? "property" : isConst ? "const" : "variable",
      range: rangeNode ?? siblings[start] ?? list,
      rangeEnd: rangeNode ? null : list,
      sigFrom: firstType?.startIndex ?? n.startIndex,
      sigTo: lastType?.endIndex ?? n.startIndex,
      exported: scopeExported && isPublic(n.text),
    });
  }
}
