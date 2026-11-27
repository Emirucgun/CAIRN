import { describe, expect, it } from "vitest";
import { buildIgnoreRules, isIndexableContent, MAX_INDEXABLE_BYTES } from "../../src/core/ignore.js";

describe("ignore rules", () => {
  const rules = buildIgnoreRules("generated/\n*.snap\n!keep.snap\n!.env\n");

  it.each([".env", ".env.local", "app/.env.production", "certs/server.pem", "a/b/tls.key", "id_rsa", "home/id_ed25519.pub", "keys/cert.p12", "config/secrets.yaml", "secrets.json", ".cairn/cache/ab/x.json"])(
    "denies %s",
    (p) => expect(rules.excludes(p)).toBe(true),
  );

  it.each(["src/env.ts", "src/keyboard.ts", "docs/secrets-handling.md", "src/environment/config.ts"])("allows %s", (p) => {
    expect(rules.excludes(p)).toBe(false);
  });

  it("denies by file name at any depth, including look-alikes the SPEC patterns catch", () => {
    // SPEC denies `.env*` and `id_*` literally; see SPEC §Open questions about `id_*`.
    expect(rules.excludes("src/.envrc")).toBe(true);
    expect(rules.excludes("src/id_generator.ts")).toBe(true);
  });

  it("applies .cairnignore, including negation, but negation can't re-include a built-in deny", () => {
    expect(rules.excludes("generated/types.ts")).toBe(true);
    expect(rules.excludes("src/__tests__/a.snap")).toBe(true);
    expect(rules.excludes("src/keep.snap")).toBe(false);
    expect(rules.excludes(".env")).toBe(true);
  });

  it("detects oversized and binary content", () => {
    expect(isIndexableContent(10, Buffer.from("export const a = 1;\n"))).toBe(true);
    expect(isIndexableContent(MAX_INDEXABLE_BYTES + 1, Buffer.from("x"))).toBe(false);
    expect(isIndexableContent(4, Buffer.from([0x89, 0x50, 0x00, 0x47]))).toBe(false);
    expect(isIndexableContent(0, Buffer.alloc(0))).toBe(true);
  });
});
