// Builds the configured summarizer, reading keys only from env vars (SPEC
// §Summarizer: bring your own key). Returns null when summaries are off.
import type { Config } from "../core/types.js";
import { AnthropicSummarizer } from "./anthropic.js";
import { OpenAICompatibleSummarizer } from "./openai-compatible.js";
import { isLocalHost, type Summarizer, SummarizerError } from "./types.js";

export * from "./types.js";
export { AnthropicSummarizer, supportsEffort } from "./anthropic.js";
export { FakeSummarizer } from "./fake.js";
export { OpenAICompatibleSummarizer } from "./openai-compatible.js";

export const DEFAULT_BASE_URL = {
  "openai-compatible": "https://api.openai.com/v1",
  ollama: "http://127.0.0.1:11434/v1",
} as const;

export function createSummarizer(cfg: Config["summarizer"], env: NodeJS.ProcessEnv): Summarizer | null {
  if (cfg.provider === "off") return null;
  const model = cfg.model;
  if (!model) throw new SummarizerError("bad-request", `[summarizer] model is required when provider is "${cfg.provider}"`);

  if (cfg.provider === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY || null;
    if (!apiKey && !env.ANTHROPIC_AUTH_TOKEN) {
      throw new SummarizerError("missing-key", "set ANTHROPIC_API_KEY to use the anthropic summarizer (keys are never read from config.toml)");
    }
    return new AnthropicSummarizer({ model, apiKey });
  }

  let baseUrl: string = cfg.base_url ?? DEFAULT_BASE_URL[cfg.provider];
  if (cfg.provider === "ollama") {
    // SPEC documents Ollama as http://127.0.0.1:11434; its OpenAI API is under /v1.
    const u = new URL(baseUrl);
    if (u.pathname === "/" || u.pathname === "") baseUrl = `${u.origin}/v1`;
    return new OpenAICompatibleSummarizer({ provider: "ollama", model, baseUrl, keyEnv: null, apiKey: null });
  }
  const keyEnv = cfg.api_key_env ?? "OPENAI_API_KEY";
  const apiKey = env[keyEnv] || null;
  // A server on localhost often needs no key; anything else does.
  if (!apiKey && !isLocalHost(new URL(baseUrl).hostname)) {
    throw new SummarizerError("missing-key", `set ${keyEnv} to use the openai-compatible summarizer at ${new URL(baseUrl).host} (keys are never read from config.toml)`);
  }
  return new OpenAICompatibleSummarizer({ provider: "openai-compatible", model, baseUrl, keyEnv, apiKey });
}
