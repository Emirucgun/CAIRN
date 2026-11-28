// Anthropic Messages API through the official SDK, which sends the API
// version header and retries 408/409/429/5xx/529 with retry-after.
// The SDK is loaded on the first request, not at startup: importing it costs
// ~55 ms, which every command would pay even with summaries off.
import type Anthropic from "@anthropic-ai/sdk";
import { generatorId, isLocalHost, type Summarizer, SummarizerError, type SummaryRequest, type SummaryResult } from "./types.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";

export interface AnthropicOptions {
  model: string;
  /** From ANTHROPIC_API_KEY; null lets the SDK use ANTHROPIC_AUTH_TOKEN. */
  apiKey: string | null;
  /** ANTHROPIC_BASE_URL from the caller's env, or a mock server in tests; default: the public API. */
  baseURL?: string;
  maxRetries?: number;
  timeoutMs?: number;
  /** Room for thinking plus a 1-3 sentence answer, so thinking can't truncate it. */
  maxTokens?: number;
}

/** Models that take output_config.effort (Opus 4.5+, Sonnet 4.6+, and every 5.x model). */
export function supportsEffort(model: string): boolean {
  return /^claude-(?:(?:fable|mythos|opus|sonnet|haiku)-(?:[5-9]|\d{2})|opus-4-[5-9]|sonnet-4-[6-9])\b/.test(model);
}

export class AnthropicSummarizer implements Summarizer {
  readonly provider = "anthropic" as const;
  readonly model: string;
  readonly host: string;
  readonly external: boolean;
  private readonly baseURL: string;
  private sdk: Promise<{ Anthropic: typeof Anthropic; client: Anthropic }> | null = null;

  constructor(private readonly o: AnthropicOptions) {
    this.model = o.model;
    // Always passed explicitly, so the host named for consent is the one used.
    this.baseURL = o.baseURL ?? DEFAULT_BASE_URL;
    const base = new URL(this.baseURL);
    this.host = base.host;
    this.external = !isLocalHost(base.hostname);
  }

  private load() {
    this.sdk ??= import("@anthropic-ai/sdk").then(({ default: SDK }) => ({
      Anthropic: SDK,
      client: new SDK({
        ...(this.o.apiKey ? { apiKey: this.o.apiKey } : {}),
        baseURL: this.baseURL,
        maxRetries: this.o.maxRetries ?? 3,
        timeout: this.o.timeoutMs ?? 60_000,
      }),
    }));
    return this.sdk;
  }

  generatorId(promptVersion: number): string {
    return generatorId(this.provider, this.model, promptVersion);
  }

  async summarize(req: SummaryRequest): Promise<SummaryResult> {
    const { Anthropic: SDK, client } = await this.load();
    let msg: Anthropic.Message;
    try {
      msg = await client.messages.create({
        model: this.model,
        max_tokens: this.o.maxTokens ?? 2048,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        // Summaries are routine work: keep thinking (billed as output) small.
        ...(supportsEffort(this.model) ? { output_config: { effort: "low" as const } } : {}),
      });
    } catch (e) {
      throw this.mapError(SDK, e);
    }
    if (msg.stop_reason === "refusal") throw new SummarizerError("refusal", `${this.model} declined to summarize this content`);
    if (msg.stop_reason === "max_tokens") throw new SummarizerError("truncated", `${this.model} hit max_tokens before finishing`);
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new SummarizerError("empty", `${this.model} returned an empty summary`);
    return { text, usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens } };
  }

  private mapError(SDK: typeof Anthropic, e: unknown): SummarizerError {
    // Most specific first (SDK error classes, never message matching).
    if (e instanceof SDK.AuthenticationError || e instanceof SDK.PermissionDeniedError) {
      return new SummarizerError("auth", `${this.host} rejected the API key (${e.status}); check ANTHROPIC_API_KEY`, e.status);
    }
    if (e instanceof SDK.RateLimitError) return new SummarizerError("rate-limit", `${this.host} is rate limiting (429): ${e.message}`, 429);
    if (e instanceof SDK.APIConnectionError) return new SummarizerError("network", `cannot reach ${this.host}: ${e.message}`);
    if (e instanceof SDK.InternalServerError) return new SummarizerError("server", `${this.host} failed (${e.status})`, e.status);
    if (e instanceof SDK.APIError) {
      const status = e.status ?? 0;
      if (status >= 500) return new SummarizerError("server", `${this.host} failed (${status})`, status);
      return new SummarizerError("bad-request", `${this.host} rejected the request (${status}); check [summarizer] model: ${e.message}`, status);
    }
    return new SummarizerError("bad-response", (e as Error).message ?? String(e));
  }
}
