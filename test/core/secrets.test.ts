import { describe, expect, it } from "vitest";
import { scanForSecrets } from "../../src/core/secrets.js";

describe("scanForSecrets", () => {
  it("reports the pattern and line, not the text", () => {
    const hits = scanForSecrets("a\nb\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n");
    expect(hits).toEqual([{ pattern: "private-key", line: 3 }]);
  });

  it("finds nothing in clean text", () => {
    expect(scanForSecrets("export function f() {}\n")).toEqual([]);
  });
});
