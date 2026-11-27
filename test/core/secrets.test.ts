import { describe, expect, it } from "vitest";
import { scanForSecrets, SECRET_PATTERNS } from "../../src/core/secrets.js";

// Samples are assembled at runtime so no complete credential-shaped string
// ever appears in the repository (GitHub push protection would flag it).
const j = (...parts: string[]) => parts.join("");
const rep = (c: string, n: number) => c.repeat(n);

const scan = (text: string) => scanForSecrets(text, SECRET_PATTERNS).map((h) => h.pattern);

describe("scanForSecrets", () => {
  it("reports the pattern and line, not the text", () => {
    const hits = scanForSecrets("a\nb\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n");
    expect(hits).toEqual([{ pattern: "private-key", line: 3 }]);
  });

  it("finds nothing in clean text", () => {
    expect(scanForSecrets("export function f() {}\n")).toEqual([]);
  });

  it("only checks private keys by default (v0.1 behaviour for skeletons, read and context)", () => {
    expect(scanForSecrets(`const k = "${j("AKIA", rep("Q", 16))}";`)).toEqual([]);
  });

  it.each([
    ["aws-access-key", `const id = "${j("AKIA", "IOSFODNN7", "EXAMPLX")}";`],
    ["aws-access-key", `key=${j("ASIA", rep("Z", 16))}`],
    ["github-token", `token: ${j("ghp", "_", rep("a1B2", 9))}`],
    ["github-token", `GH=${j("github", "_pat_", rep("A1b_", 16))}`],
    ["slack-token", `const hook = "${j("xox", "b-", "1234567890-abcdefghij")}";`],
    ["stripe-live-key", `stripe(${JSON.stringify(j("sk", "_live_", rep("x9", 12)))})`],
    ["anthropic-api-key", `ANTHROPIC_API_KEY=${j("sk", "-ant-", "api03-", rep("Ab9_", 10))}`],
    ["openai-api-key", `OPENAI_API_KEY=${j("sk", "-proj-", rep("Ab9_", 10))}`],
    ["google-api-key", `const maps = "${j("AIza", rep("Sy0-", 8), "abc")}";`],
    ["jwt", `Authorization: Bearer ${j("eyJ", rep("hbGc", 4), ".eyJ", rep("zdWI", 4), ".", rep("SflK", 4))}`],
    ["url-with-password", `DATABASE_URL=postgres://admin:${j("hunter", "2Xy")}@db.internal:5432/app`],
  ])("catches %s", (pattern, text) => {
    expect(scan(text)).toContain(pattern);
    // The hit never carries the secret itself.
    expect(JSON.stringify(scanForSecrets(text, SECRET_PATTERNS))).not.toMatch(/hunter|AKIA|ASIA|ghp_|sk_live|eyJ/);
  });

  it("reports the right line and one hit per pattern", () => {
    const text = `line one\nconst a = "${j("AKIA", rep("B", 16))}";\nconst b = "${j("AKIA", rep("C", 16))}";\n`;
    expect(scanForSecrets(text, SECRET_PATTERNS)).toEqual([{ pattern: "aws-access-key", line: 2 }]);
  });

  it.each([
    "export function handle(req: Request): Response { return new Response('ok'); }",
    "const AKIA = 'short'; // AKIAEXAMPLE is too short",
    "const sk = 'sk-short'; const task = 'sk-1234';",
    "id: 3f2c9a1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b",
    "const b64 = 'aGVsbG8gd29ybGQgdGhpcyBpcyBqdXN0IHNvbWUgYmFzZTY0IGRhdGE=';",
    "url = 'https://example.com/path?x=1'",
    "DATABASE_URL=postgres://user:password@localhost:5432/app",
    "DATABASE_URL=postgres://user:${DB_PASSWORD}@localhost/app",
    "REDIS_URL=redis://default:<password>@host:6379",
    "mongodb://root:****@cluster0.example.net",
    "git clone https://github.com/owner/repo.git",
    "-----BEGIN PUBLIC KEY-----",
  ])("does not flag ordinary code or placeholders: %s", (text) => {
    expect(scan(text)).toEqual([]);
  });
});
