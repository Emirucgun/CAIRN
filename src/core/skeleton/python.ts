// Python. "Exported" follows the module's public API: names listed in
// `__all__` when it is defined, otherwise names not starting with `_`.
// Members are exported if their class is and they are not `_private`
// (dunders such as __init__ count as public).
import type { Node } from "web-tree-sitter";
import { Collector, type Extracted, namedChildren, unquote } from "./common.js";

export function extractPython(root: Node, src: string): Extracted {
  const c = new Collector(src);
  let all: Set<string> | null = null;
  for (const stmt of namedChildren(root)) {
    const declared = dunderAll(stmt);
    if (declared) all = declared;
    else definition(c, stmt, stmt, "", true);
  }
  if (all) c.setExportedExactly(all);
  for (const imp of root.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (!imp) continue;
    if (imp.type === "import_from_statement") {
      const mod = imp.childForFieldName("module_name");
      if (mod) c.import(mod.text);
    } else {
      for (const n of namedChildren(imp)) {
        const target = n.type === "aliased_import" ? n.childForFieldName("name") : n;
        if (target?.type === "dotted_name") c.import(target.text);
      }
    }
  }
  return c.result();
}

const isPublic = (name: string) => !name.startsWith("_") || /^__.+__$/.test(name);

/** @param parentExported whether the enclosing scope is visible (true at module level). */
function definition(c: Collector, node: Node, range: Node, prefix: string, parentExported: boolean): void {
  if (node.type === "decorated_definition") {
    const inner = node.childForFieldName("definition");
    if (inner) definition(c, inner, node, prefix, parentExported);
    return;
  }
  const inClass = prefix !== "";
  if (node.type === "function_definition") {
    const n = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!n) return;
    c.add({
      sym: prefix + n.text,
      kind: inClass ? "method" : "function",
      range,
      sigFrom: n.endIndex,
      sigTo: body?.startIndex ?? node.endIndex,
      exported: parentExported && isPublic(n.text),
    });
    return;
  }
  if (node.type === "class_definition") {
    const n = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    if (!n) return;
    const sym = prefix + n.text;
    const exported = parentExported && isPublic(n.text);
    c.add({ sym, kind: "class", range, sigFrom: n.endIndex, sigTo: body?.startIndex ?? node.endIndex, exported });
    if (body) for (const member of namedChildren(body)) definition(c, member, member, `${sym}.`, exported);
    return;
  }
  if (node.type === "expression_statement") {
    const assign = node.namedChild(0);
    if (assign?.type !== "assignment") return;
    const left = assign.childForFieldName("left");
    if (left?.type !== "identifier") return;
    const type = assign.childForFieldName("type");
    const name = left.text;
    c.add({
      sym: prefix + name,
      kind: inClass ? "property" : /^[A-Z][A-Z0-9_]*$/.test(name) ? "const" : "variable",
      range,
      sigFrom: left.endIndex,
      sigTo: type?.endIndex ?? left.endIndex,
      exported: parentExported && isPublic(name),
    });
  }
}

/** The names in a top-level `__all__ = [...]` / `(...)`, or null if `stmt` is not one. */
function dunderAll(stmt: Node): Set<string> | null {
  if (stmt.type !== "expression_statement") return null;
  const assign = stmt.namedChild(0);
  if (assign?.type !== "assignment" || assign.childForFieldName("left")?.text !== "__all__") return null;
  const right = assign.childForFieldName("right");
  if (!right || (right.type !== "list" && right.type !== "tuple")) return null;
  return new Set(namedChildren(right).filter((n) => n.type === "string").map((n) => unquote(n.text)));
}
