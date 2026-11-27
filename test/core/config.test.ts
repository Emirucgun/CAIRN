import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG_TOML, loadConfig, parseConfig, writeDefaultConfig } from "../../src/core/config.js";
import { Config } from "../../src/core/types.js";
import { tmpDir } from "../helpers/tmp.js";

const DEFAULTS = {
  summarizer: { provider: "ollama", model: "qwen2.5-coder:7b", max_calls_per_run: 200, concurrency: 4 },
  context: { max_diff_lines: 150 },
  models: { factors: { claude: 1.0, gpt: 1.0 } },
  records: { store_prompts: true },
};

describe("config", () => {
  it("has the SPEC defaults", () => {
    expect(Config.parse({})).toEqual(DEFAULTS);
  });

  it("default file parses to exactly the defaults", () => {
    expect(parseConfig(DEFAULT_CONFIG_TOML)).toEqual(DEFAULTS);
  });

  it("fills missing keys from defaults", () => {
    const c = parseConfig('[summarizer]\nprovider = "off"\n[models.factors]\n"gemini" = 1.1\n');
    expect(c.summarizer).toEqual({ ...DEFAULTS.summarizer, provider: "off" });
    expect(c.context.max_diff_lines).toBe(150);
    expect(c.models.factors).toEqual({ gemini: 1.1 });
  });

  it("reports TOML syntax errors with a line number", () => {
    expect(() => parseConfig("[context\nmax_diff_lines = 1\n", "/r/.cairn/config.toml")).toThrow(
      /\/r\/\.cairn\/config\.toml: line 1/,
    );
  });

  it.each([
    ['[summarizer]\nprovider = "gpt-pigeon"\n', /provider/],
    ["[context]\nmax_diff_lines = -1\n", /max_diff_lines/],
    ["[context]\nmax_diff_line = 10\n", /max_diff_line/],
    ["[nonsense]\nx = 1\n", /nonsense/],
  ])("rejects invalid config %#", (toml, msg) => {
    expect(() => parseConfig(toml)).toThrow(ConfigError);
    expect(() => parseConfig(toml)).toThrow(msg);
  });

  it("loads defaults when the file is missing, and the file when present", async () => {
    const dir = tmpDir();
    const path = join(dir, "config.toml");
    expect(await loadConfig(path)).toEqual(DEFAULTS);
    writeFileSync(path, "[context]\nmax_diff_lines = 40\n");
    expect((await loadConfig(path)).context.max_diff_lines).toBe(40);
  });

  it("writes the default config once and never overwrites", async () => {
    const path = join(tmpDir(), "config.toml");
    expect(await writeDefaultConfig(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(DEFAULT_CONFIG_TOML);
    writeFileSync(path, "# mine\n");
    expect(await writeDefaultConfig(path)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("# mine\n");
  });
});
