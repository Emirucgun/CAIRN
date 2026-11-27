import { readFile, writeFile } from "node:fs/promises";
import { parse, TomlError } from "smol-toml";
import { z } from "zod";
import { Config } from "./types.js";

/** Written by `cairn init`. Mirrors SPEC §Config; parses to exactly the zod defaults. */
export const DEFAULT_CONFIG_TOML = `[summarizer]
provider = "ollama"            # ollama | anthropic | openai-compatible | off
model = "qwen2.5-coder:7b"
max_calls_per_run = 200
concurrency = 4

[context]
max_diff_lines = 150

[models.factors]               # tokenizer correction per model family
"claude" = 1.0
"gpt" = 1.0

[records]
store_prompts = true           # false drops prompts from records (refs/notes/cairn is pushed with the repo)
`;

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "ConfigError";
  }
}

export function parseConfig(text: string, path = "config.toml"): Config {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    if (e instanceof TomlError) throw new ConfigError(path, `line ${e.line}, column ${e.column}: ${e.message.split("\n")[0]}`);
    throw e;
  }
  const result = Config.safeParse(raw);
  if (!result.success) throw new ConfigError(path, z.prettifyError(result.error));
  return result.data;
}

/** Loads config, falling back to defaults when the file does not exist. */
export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return Config.parse({});
    throw e;
  }
  return parseConfig(text, path);
}

/** Writes the default config unless one exists. Returns true if it wrote. */
export async function writeDefaultConfig(path: string): Promise<boolean> {
  try {
    await writeFile(path, DEFAULT_CONFIG_TOML, { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}
