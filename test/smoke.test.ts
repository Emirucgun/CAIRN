import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("cli smoke", () => {
  it("prints its version", () => {
    // Not `pnpm cairn`: on Windows pnpm is pnpm.cmd, which needs a shell.
    const out = execFileSync(process.execPath, ["--import", "tsx", "src/cli/index.ts", "--version"], { cwd: root, encoding: "utf8" });
    expect(out.trim()).toBe(VERSION);
  });
});
