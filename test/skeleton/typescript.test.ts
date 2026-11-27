import { describe, expect, it } from "vitest";
import { cleanSig, MAX_SIG_CHARS } from "../../src/core/skeleton/common.js";
import { langForPath } from "../../src/core/skeleton/langs.js";
import { sk } from "./helpers.js";

const SESSION_TS = `import { createClient } from "@supabase/supabase-js";
import type { User } from "../types";
import * as log from "./log";
export * from "./errors";

/** Session lifetime in ms. */
export const TTL = 60_000;
let refreshes = 0;

/**
 * Creates a session.
 * Throws AuthError on invalid credentials.
 */
export async function login(email: string, pw: string): Promise<Session> {
  return new Session(email);
}

// overloads
export function parse(raw: string): Session;
export function parse(raw: Buffer): Session;
export function parse(raw: unknown): Session {
  return raw as Session;
}

export class Session<T = unknown> extends Base implements Disposable {
  private token = "";
  readonly user: User | null = null;
  #secret = 1;

  constructor(readonly email: string) {
    super();
  }

  static restore(json: string): Session {
    return JSON.parse(json);
  }

  get expired(): boolean {
    return false;
  }

  private rotate(): void {}
}

export interface Store {
  get(id: string): Session | undefined;
}

export type SessionId = string & { readonly brand: unique symbol };

export enum State { Active, Expired }

const helper = (a: number, b = 2): number => a + b;
function internal() {}

export { helper };
export default class extends Session {}

namespace Legacy {
  export function old(): void {}
}

const lazy = () => import("./lazy");
const cjs = require("./cjs");
`;

describe("typescript skeleton", () => {
  it("extracts symbols with kinds, export flags, signatures and line ranges", async () => {
    const { symbols } = await sk("typescript", SESSION_TS);
    expect(symbols).toEqual([
      "+const TTL 6-7 | ",
      "-variable refreshes 8-8 | ",
      "+function login 10-16 | (email: string, pw: string): Promise<Session>",
      "+function parse 18-23 | (raw: string): Session",
      "+class Session 25-43 | <T = unknown> extends Base implements Disposable",
      "-property Session.token 26-26 | ",
      "+property Session.user 27-27 | : User | null",
      "-property Session.#secret 28-28 | ",
      "+method Session.constructor 30-32 | (readonly email: string)",
      "+method Session.restore 34-36 | (json: string): Session",
      "+method Session.expired 38-40 | (): boolean",
      "-method Session.rotate 42-42 | (): void",
      "+interface Store 45-47 | ",
      "+type SessionId 49-49 | = string & { readonly brand: unique symbol }",
      "+enum State 51-51 | ",
      "+function helper 53-53 | (a: number, b = 2): number",
      "-function internal 54-54 | ()",
      "+class default 57-57 | extends Session",
      "-function Legacy.old 60-60 | (): void",
      "-function lazy 63-63 | ()",
      "-const cjs 64-64 | ",
    ]);
  });

  it("collects static, re-export and dynamic import specifiers raw", async () => {
    const { imports } = await sk("typescript", SESSION_TS);
    expect(imports).toEqual(["@supabase/supabase-js", "../types", "./log", "./errors", "./lazy", "./cjs"]);
  });

  it("handles anonymous default exports and default-exported identifiers", async () => {
    expect((await sk("typescript", "export default function () {}\n")).symbols).toEqual(["+function default 1-1 | ()"]);
    expect((await sk("typescript", "function app() {}\nexport default app;\n")).symbols).toEqual(["+function app 1-1 | ()"]);
    expect((await sk("typescript", "export default class Foo {}\n")).symbols).toEqual(["+class Foo 1-1 | "]);
  });

  it("exports from an exported namespace are visible; from a private one are not", async () => {
    const src = "export namespace Pub { export function a() {} function b() {} }\nnamespace Priv { export function c() {} }\n";
    expect((await sk("typescript", src)).symbols).toEqual([
      "+function Pub.a 1-1 | ()",
      "-function Pub.b 1-1 | ()",
      "-function Priv.c 2-2 | ()",
    ]);
  });

  it("handles declare and abstract", async () => {
    const src = "declare function d(x: number): string;\nexport abstract class A {\n  abstract run(n: number): void;\n}\n";
    expect((await sk("typescript", src)).symbols).toEqual([
      "-function d 1-1 | (x: number): string",
      "+class A 2-4 | ",
      "+method A.run 3-3 | (n: number): void",
    ]);
  });

  it("parses TSX components", async () => {
    const src = 'import React from "react";\nexport const Button = ({ label }: Props) => <button>{label}</button>;\n';
    const r = await sk("tsx", src);
    expect(r.symbols).toEqual(["+function Button 2-2 | ({ label }: Props)"]);
    expect(r.imports).toEqual(["react"]);
  });

  it("parses plain JavaScript, including private fields and CommonJS", async () => {
    const src = `const fs = require("node:fs");
class Queue {
  #items = [];
  push(x) { this.#items.push(x); }
}
export function make() { return new Queue(); }
module.exports = { Queue };
`;
    const r = await sk("javascript", src);
    expect(r.symbols).toEqual([
      "-const fs 1-1 | ",
      "-class Queue 2-5 | ",
      "-property Queue.#items 3-3 | ",
      "-method Queue.push 4-4 | (x)",
      "+function make 6-6 | ()",
    ]);
    expect(r.imports).toEqual(["node:fs"]);
  });

  it("survives syntax errors", async () => {
    const r = await sk("typescript", "export function ok(a: number) {}\nexport function broken( {\n");
    expect(r.symbols[0]).toBe("+function ok 1-1 | (a: number)");
  });

  it("caps and cleans signatures", () => {
    expect(cleanSig("(a:   number,\n   b: string)  {")).toBe("(a: number, b: string)");
    expect(cleanSig("(x) =>")).toBe("(x)");
    const long = cleanSig(`(${"a: number, ".repeat(40)})`);
    expect(long.length).toBeLessThanOrEqual(MAX_SIG_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("maps file extensions to grammars", () => {
    expect(langForPath("src/a.ts")).toBe("typescript");
    expect(langForPath("src/a.d.ts")).toBe("typescript");
    expect(langForPath("App.TSX")).toBe("tsx");
    expect(langForPath("x.mjs")).toBe("javascript");
    expect(langForPath("x.jsx")).toBe("javascript");
    expect(langForPath("a/b.py")).toBe("python");
    expect(langForPath("main.dart")).toBe("dart");
    expect(langForPath("App.swift")).toBe("swift");
    expect(langForPath("README.md")).toBeNull();
    expect(langForPath(".ts")).toBeNull();
    expect(langForPath("Makefile")).toBeNull();
  });
});
