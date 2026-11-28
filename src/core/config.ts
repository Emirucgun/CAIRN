import { readFile, writeFile } from "node:fs/promises";
import { parse, TomlError } from "smol-toml";
import { z } from "zod";
import { Config, KEY_LIKE_SETTINGS } from "./types.js";

/** Written by `cairn init`. Mirrors SPEC §Config; parses to exactly the zod defaults. */
export const DEFAULT_CONFIG_TOML = `[summarizer]
provider = "off"               # off | anthropic | openai-compatible | ollama (bring your own key)
# model = "claude-haiku-5-5"   # required when provider is not off; no default
# base_url = "https://api.openai.com/v1"   # openai-compatible and ollama only
# api_key_env = "OPENAI_API_KEY"           # API keys come only from env vars, never this file
max_calls_per_run = 200        # a run that needs more is refused before it starts
concurrency = 4
source_lines = 200             # lines of source sent with a file's skeleton

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
  const keyLike = findKeyLike(raw);
  if (keyLike) {
    throw new ConfigError(
      path,
      `${keyLike} looks like a credential. API keys are read only from environment variables (ANTHROPIC_API_KEY, or the variable named by [summarizer] api_key_env), never from config.toml. Remove it.`,
    );
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

/** The first `[section] key` that looks like a credential, at any depth. */
function findKeyLike(value: unknown, prefix = ""): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  for (const [k, v] of Object.entries(value)) {
    const where = prefix ? `${prefix}.${k}` : k;
    const lower = k.toLowerCase();
    if ((KEY_LIKE_SETTINGS as readonly string[]).includes(lower) || /(^|_)(api_?key|secret|token|password)$/.test(lower)) {
      if (lower !== "api_key_env") return where;
    }
    const nested = findKeyLike(v, where);
    if (nested) return nested;
  }
  return null;
}
