import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findSymbol, numberLines, type ReadResult, splitTarget } from "../../src/core/read.js";
import type { SkeletonSymbol } from "../../src/core/types.js";
import { cli } from "../helpers/cli.js";
import { makeRepo } from "../helpers/repo.js";
import { guard } from "../helpers/safety.js";

const SESSION = `import { db } from "./db";

/** Logs a user in. */
export async function login(email: string): Promise<Session> {
  return new Session(email);
}

export class Session {
  constructor(readonly email: string) {}

  refresh(): void {
    // rotate
  }
}

export class Token {
  refresh(): void {}
}
`;

async function initialized(files: Record<string, string> = { "src/auth/session.ts": SESSION, "README.md": "# hi\nthere\n" }) {
  const r = makeRepo(files);
  await cli(r.dir, "init");
  return r;
}

describe("cairn read", () => {
  it("prints one symbol's source with line numbers, including its doc comment", async () => {
    const r = await initialized();
    guard(r);
    const res = await cli(r.dir, "read", "src/auth/session.ts#login");
    expect(res.code).toBe(0);
    expect(res.out).toBe(
      "src/auth/session.ts#login  L3-6 of 18, ~30 tok (file ~74)  function login(email: string): Promise<Session>\n" +
        "3 | /** Logs a user in. */\n" +
        "4 | export async function login(email: string): Promise<Session> {\n" +
        "5 |   return new Session(email);\n" +
        "6 | }\n",
    );
  });

  it("reads members by dotted name, and by suffix when unambiguous", async () => {
    const r = await initialized();
    const res = await cli(r.dir, "--json", "read", "src/auth/session.ts#Session.refresh");
    const j = res.json() as ReadResult;
    expect(j.lines).toEqual([11, 13]);
    expect(j.source).toBe("  refresh(): void {\n    // rotate\n  }\n");
    const ctor = (await cli(r.dir, "--json", "read", "src/auth/session.ts#constructor")).json() as ReadResult;
    expect(ctor.symbol?.sym).toBe("Session.constructor");
  });

  it("exits 2 and lists candidates for an ambiguous name", async () => {
    const r = await initialized();
    const res = await cli(r.dir, "read", "src/auth/session.ts#refresh");
    expect(res.code).toBe(2);
    expect(res.err).toContain("src/auth/session.ts#Session.refresh, src/auth/session.ts#Token.refresh");
  });

  it("suggests names for a missing symbol", async () => {
    const r = await initialized();
    const res = await cli(r.dir, "read", "src/auth/session.ts#Login");
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/no symbol Login in src\/auth\/session.ts\. Did you mean: login\?/);
    const none = await cli(r.dir, "read", "src/auth/session.ts#zzz");
    expect(none.err).toMatch(/cairn map src\/auth\/session.ts --all/);
  });

  it("reads a whole file, relative to the current directory, and without line numbers on request", async () => {
    const r = await initialized();
    const res = await cli(join(r.dir, "src"), "read", "auth/session.ts");
    expect(res.out.split("\n")[0]).toBe("src/auth/session.ts  L1-18 of 18, ~74 tok");
    expect(res.out).toContain("18 | }\n");
    const plain = await cli(r.dir, "read", "README.md", "--no-line-numbers");
    expect(plain.out).toBe("README.md  L1-2 of 2, ~3 tok\n# hi\nthere\n");
  });

  it("serves the working tree, including uncommitted edits", async () => {
    const r = await initialized();
    r.write("src/auth/session.ts", "export function login(): void {\n  // edited\n}\n");
    guard(r);
    const j = (await cli(r.dir, "--json", "read", "src/auth/session.ts#login")).json() as ReadResult;
    expect(j.source).toBe("export function login(): void {\n  // edited\n}\n");
    expect(j.hash).toBe(r.git("hash-object", "src/auth/session.ts").trim());
  });

  it("refuses denied paths, secret-bearing files and binaries", async () => {
    const r = await initialized({
      "src/keys.ts": "export const k = `\n-----BEGIN EC PRIVATE KEY-----\nMHcC\n`;\n",
      "logo.ts": "\u0000PNG",
    });
    r.write(".env", "TOKEN=abc\n");
    const env = await cli(r.dir, "read", ".env");
    expect(env.code).toBe(1);
    expect(env.err).toMatch(/\.env is not in the snapshot/);
    expect(env.out + env.err).not.toContain("abc");
    for (const target of ["src/keys.ts", "src/keys.ts#k"]) {
      const res = await cli(r.dir, "read", target);
      expect(res.code).toBe(1);
      expect(res.err).toMatch(/will not serve src\/keys\.ts: it looks like it contains a secret/);
      expect(res.out + res.err).not.toContain("MHcC");
    }
    expect((await cli(r.dir, "read", "logo.ts")).err).toMatch(/binary file/);
  });

  it("explains when symbols aren't available", async () => {
    const r = await initialized();
    expect((await cli(r.dir, "read", "README.md#intro")).err).toMatch(/symbols are not supported for this file type/);
  });

  it("treats # as part of the path when that file exists", async () => {
    const r = await initialized({ "notes#1.md": "one\n", "a.ts": "export const x = 1;\n" });
    expect((await cli(r.dir, "read", "notes#1.md")).out).toContain("1 | one");
    expect((await cli(r.dir, "read", "a.ts#")).out).toContain("a.ts  L1-1 of 1");
  });

  it("fails for missing paths and outside the repo", async () => {
    const r = await initialized();
    expect((await cli(r.dir, "read", "nope.ts#x")).err).toMatch(/nope\.ts is not in the snapshot/);
    expect((await cli(r.dir, "read", "../../etc/passwd")).err).toMatch(/outside the repository/);
  });
});

describe("read helpers", () => {
  const sym = (s: string): SkeletonSymbol => ({ sym: s, kind: "method", sig: "", lines: [1, 1], exported: true });

  it("matches exact names before dotted suffixes", () => {
    const all = [sym("refresh"), sym("Session.refresh"), sym("Session.refreshAll")];
    expect(findSymbol(all, "refresh").map((s) => s.sym)).toEqual(["refresh"]);
    expect(findSymbol(all.slice(1), "refresh").map((s) => s.sym)).toEqual(["Session.refresh"]);
    expect(findSymbol(all, "fresh")).toEqual([]);
  });

  it("splits path#symbol", () => {
    const none = () => false;
    expect(splitTarget("a.ts#f", none)).toEqual({ path: "a.ts", symbol: "f" });
    expect(splitTarget("a.ts#A.b", none)).toEqual({ path: "a.ts", symbol: "A.b" });
    expect(splitTarget("a.ts", none)).toEqual({ path: "a.ts", symbol: null });
    expect(splitTarget("#x", none)).toEqual({ path: "#x", symbol: null });
    expect(splitTarget("n#1.md", (p) => p === "n#1.md")).toEqual({ path: "n#1.md", symbol: null });
  });

  it("aligns line numbers", () => {
    expect(numberLines("a\nb\n", 9)).toBe(" 9 | a\n10 | b\n");
  });
});

describe("cairn read with CRLF content", () => {
  it("serves lines without \\r when the blob itself holds CRLF", async () => {
    const r = makeRepo({});
    r.git("config", "core.autocrlf", "false");
    r.write("win.ts", "/** Doc. */\r\nexport function f(a: number): number {\r\n  return a;\r\n}\r\n");
    r.commit("crlf");
    await cli(r.dir, "init");
    const j = (await cli(r.dir, "--json", "read", "win.ts#f")).json() as ReadResult;
    expect(j.lines).toEqual([1, 4]);
    expect(j.source).toBe("/** Doc. */\nexport function f(a: number): number {\n  return a;\n}\n");
    expect(j.symbol?.sig).toBe("(a: number): number");
  });

  it("matches what git stores when autocrlf converts a CRLF work tree to LF", async () => {
    const r = makeRepo({});
    r.git("config", "core.autocrlf", "true");
    r.write("win.ts", "export function g(): void {\r\n}\r\n");
    await cli(r.dir, "init");
    const j = (await cli(r.dir, "--json", "read", "win.ts#g")).json() as ReadResult;
    expect(j.source).toBe("export function g(): void {\n}\n");
    expect(j.hash).toBe(r.git("hash-object", "win.ts").trim());
  });
});
