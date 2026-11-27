import { describe, expect, it } from "vitest";
import { buildIgnoreRules, checkIndexable, MAX_INDEXABLE_BYTES } from "../../src/core/ignore.js";

describe("ignore rules", () => {
  const rules = buildIgnoreRules("generated/\n*.snap\n!keep.snap\n!.env\n");

  it.each([
    ".env",
    ".env.local",
    "app/.env.production",
    "src/.envrc",
    "certs/server.pem",
    "a/b/tls.key",
    "keys/cert.p12",
    "config/secrets.yaml",
    "secrets.json",
    ".cairn/cache/ab/x.json",
  ])("denies %s", (p) => expect(rules.excludes(p)).toBe(true));

  const sshNames = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
  it.each(sshNames.flatMap((n) => [n, `${n}.pub`, `${n}-cert.pub`, `home/.ssh/${n}`, `deploy/${n}-cert.pub`]))(
    "denies SSH key file %s",
    (p) => expect(rules.excludes(p)).toBe(true),
  );

  it.each([
    "src/id_generator.ts",
    "id_utils.py",
    "src/ids/id_map.dart",
    "id_rsa.ts",
    "id_ed25519_test.go",
    "src/env.ts",
    "src/keyboard.ts",
    "docs/secrets-handling.md",
    "src/environment/config.ts",
  ])("allows %s", (p) => expect(rules.excludes(p)).toBe(false));

  it("applies .cairnignore, including negation, but negation can't re-include a built-in deny", () => {
    expect(rules.excludes("generated/types.ts")).toBe(true);
    expect(rules.excludes("src/__tests__/a.snap")).toBe(true);
    expect(rules.excludes("src/keep.snap")).toBe(false);
    expect(rules.excludes(".env")).toBe(true);
  });
});

describe("checkIndexable", () => {
  const ok = (s: string) => checkIndexable(Buffer.byteLength(s), Buffer.from(s));

  it("accepts ordinary source", () => {
    expect(ok("export const a = 1;\n")).toEqual({ ok: true });
    expect(checkIndexable(0, Buffer.alloc(0))).toEqual({ ok: true });
  });

  it("rejects oversized and binary content", () => {
    expect(checkIndexable(MAX_INDEXABLE_BYTES + 1, Buffer.from("x"))).toEqual({ ok: false, reason: "too-large" });
    expect(checkIndexable(4, Buffer.from([0x89, 0x50, 0x00, 0x47]))).toEqual({ ok: false, reason: "binary" });
  });

  it.each([
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN DSA PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  ])("rejects any file containing %s, wherever it is", (header) => {
    const src = `// test fixture, looks harmless\nexport const KEY = \`\n${header}\nMIIEvQIBADANBg...\n\`;\n`;
    const verdict = ok(src);
    expect(verdict).toEqual({ ok: false, reason: "secret", pattern: "private-key", line: 3 });
    expect(JSON.stringify(verdict)).not.toContain("MIIE"); // never echoes the secret
  });

  it("does not flag public keys or prose about keys", () => {
    expect(ok("-----BEGIN PUBLIC KEY-----\nMFkw...\n")).toEqual({ ok: true });
    expect(ok("-----BEGIN CERTIFICATE-----\n")).toEqual({ ok: true });
    expect(ok("// paste your PRIVATE KEY here\n")).toEqual({ ok: true });
  });
});
