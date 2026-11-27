import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("cli smoke", () => {
  it("prints its version", () => {
    const out = execFileSync("pnpm", ["-s", "cairn", "--version"], { cwd: root, encoding: "utf8" });
    expect(out.trim()).toBe(VERSION);
  });
});
