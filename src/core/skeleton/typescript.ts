// TypeScript, TSX and JavaScript (the JS grammar is a subset of these shapes).
// "Exported" means visible outside the file: `export`, `export default`, or
// listed in an `export { … }` clause.
import type { Node } from "web-tree-sitter";
import type { SymbolKind } from "../types.js";
import { Collector, type Extracted, namedChildren, unquote } from "./common.js";

const FUNCTION_DECLS = new Set(["function_declaration", "generator_function_declaration", "function_signature"]);
const CLASS_DECLS = new Set(["class_declaration", "abstract_class_declaration"]);
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const MEMBER_METHODS = new Set(["method_definition", "abstract_method_signature", "method_signature"]);
const MEMBER_FIELDS = new Set(["public_field_definition", "field_definition"]);

export function extractTypeScript(root: Node, src: string): Extracted {
  const c = new Collector(src);
  const exportedNames: string[] = [];
  for (const stmt of namedChildren(root)) statement(c, stmt, stmt, false, "", exportedNames, true);
  c.markExported(exportedNames);
  // Walking every node is ~17% of extraction time; most files have no dynamic imports.
  if (src.includes("require") || src.includes("import(")) collectDynamicImports(c, root);
  return c.result();
}

/**
 * @param scopeExported whether `export` in this scope makes a symbol visible
 *   outside the file (false inside a namespace that is not itself exported).
 */
function statement(
  c: Collector,
  node: Node,
  range: Node,
  exported: boolean,
  prefix: string,
  exportedNames: string[],
  scopeExported: boolean,
): void {
  const name = (n: Node | null) => (n ? prefix + n.text : null);
  switch (node.type) {
    case "import_statement": {
      const source = node.childForFieldName("source");
      if (source) c.import(unquote(source.text));
      return;
    }
    case "export_statement": {
      const source = node.childForFieldName("source");
      if (source) c.import(unquote(source.text));
      const decl = node.childForFieldName("declaration");
      if (decl) return statement(c, decl, node, scopeExported, prefix, exportedNames, scopeExported);
      const value = node.childForFieldName("value");
      if (value) return exportDefault(c, node, value, prefix, exportedNames);
      const clause = namedChildren(node).find((n) => n.type === "export_clause");
      if (clause && !source) {
        for (const spec of namedChildren(clause)) {
          const local = spec.childForFieldName("name");
          if (local && scopeExported) exportedNames.push(prefix + local.text);
        }
      }
      return;
    }
    case "ambient_declaration":
      for (const child of namedChildren(node)) statement(c, child, range, exported, prefix, exportedNames, scopeExported);
      return;
    case "expression_statement": {
      const inner = node.namedChild(0);
      if (inner?.type === "internal_module" || inner?.type === "module") statement(c, inner, range, exported, prefix, exportedNames, scopeExported);
      return;
    }
    case "internal_module":
    case "module": {
      const n = node.childForFieldName("name");
      const body = node.childForFieldName("body");
      if (n && body && n.type === "identifier") {
        for (const stmt of namedChildren(body)) statement(c, stmt, stmt, false, `${prefix}${n.text}.`, exportedNames, exported);
      }
      return;
    }
    case "lexical_declaration":
    case "variable_declaration": {
      const isConst = node.child(0)?.text === "const";
      for (const decl of namedChildren(node)) {
        if (decl.type !== "variable_declarator") continue;
        const n = decl.childForFieldName("name");
        if (n?.type !== "identifier") continue; // destructuring patterns are skipped
        const value = decl.childForFieldName("value");
        if (value && FUNCTION_VALUES.has(value.type)) {
          const body = value.childForFieldName("body");
          c.add({ sym: prefix + n.text, kind: "function", range, sigFrom: value.startIndex, sigTo: body?.startIndex ?? value.endIndex, exported });
        } else if (value?.type === "class") {
          classLike(c, value, range, prefix + n.text, exported, n.endIndex);
        } else {
          const type = decl.childForFieldName("type");
          c.add({
            sym: prefix + n.text,
            kind: isConst ? "const" : "variable",
            range,
            sigFrom: type?.startIndex ?? n.endIndex,
            sigTo: type?.endIndex ?? n.endIndex,
            exported,
          });
        }
      }
      return;
    }
  }

  const n = node.childForFieldName("name");
  const sym = name(n);
  if (!n || !sym) return;
  if (FUNCTION_DECLS.has(node.type)) {
    const body = node.childForFieldName("body");
    c.add({ sym, kind: "function", range, sigFrom: n.endIndex, sigTo: body?.startIndex ?? node.endIndex, exported });
  } else if (CLASS_DECLS.has(node.type)) {
    classLike(c, node, range, sym, exported, n.endIndex);
  } else if (node.type === "interface_declaration") {
    const body = node.childForFieldName("body");
    c.add({ sym, kind: "interface", range, sigFrom: n.endIndex, sigTo: body?.startIndex ?? node.endIndex, exported });
  } else if (node.type === "type_alias_declaration") {
    c.add({ sym, kind: "type", range, sigFrom: n.endIndex, sigTo: node.endIndex, exported });
  } else if (node.type === "enum_declaration") {
    c.add({ sym, kind: "enum", range, sigFrom: n.endIndex, sigTo: n.endIndex, exported });
  }
}

function exportDefault(c: Collector, node: Node, value: Node, prefix: string, exportedNames: string[]): void {
  if (value.type === "identifier") {
    exportedNames.push(prefix + value.text);
    return;
  }
  const own = value.childForFieldName("name");
  const sym = prefix + (own?.text ?? "default");
  const body = value.childForFieldName("body");
  if (FUNCTION_VALUES.has(value.type) || FUNCTION_DECLS.has(value.type)) {
    const from = value.childForFieldName("parameters")?.startIndex ?? value.startIndex;
    c.add({ sym, kind: "function", range: node, sigFrom: from, sigTo: body?.startIndex ?? value.endIndex, exported: true });
  } else if (value.type === "class" || CLASS_DECLS.has(value.type)) {
    classLike(c, value, node, sym, true, own?.endIndex ?? value.startIndex + "class".length);
  }
}

function classLike(c: Collector, node: Node, range: Node, sym: string, exported: boolean, sigFrom: number): void {
  const body = node.childForFieldName("body");
  c.add({ sym, kind: "class", range, sigFrom, sigTo: body?.startIndex ?? node.endIndex, exported });
  if (!body) return;
  for (const member of namedChildren(body)) {
    const kind: SymbolKind | null = MEMBER_METHODS.has(member.type) ? "method" : MEMBER_FIELDS.has(member.type) ? "property" : null;
    if (!kind) continue;
    const n = member.childForFieldName("name") ?? member.childForFieldName("property");
    if (!n) continue;
    const isPrivate =
      n.type === "private_property_identifier" ||
      namedChildren(member).some((m) => m.type === "accessibility_modifier" && m.text === "private");
    const mBody = member.childForFieldName("body");
    const type = member.childForFieldName("type");
    c.add({
      sym: `${sym}.${n.text}`,
      kind,
      range: member,
      sigFrom: kind === "method" ? n.endIndex : (type?.startIndex ?? n.endIndex),
      sigTo: kind === "method" ? (mBody?.startIndex ?? member.endIndex) : (type?.endIndex ?? n.endIndex),
      exported: exported && !isPrivate,
    });
  }
}

/** `require("x")` and `import("x")` anywhere in the file. */
function collectDynamicImports(c: Collector, root: Node): void {
  for (const call of root.descendantsOfType("call_expression")) {
    if (!call) continue;
    const fn = call.childForFieldName("function");
    if (!fn || !(fn.type === "import" || (fn.type === "identifier" && fn.text === "require"))) continue;
    const arg = call.childForFieldName("arguments")?.namedChild(0);
    if (arg?.type === "string") c.import(unquote(arg.text));
  }
}
