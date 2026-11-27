// Anthropic Messages API through the official SDK, which sends the API
// version header and retries 408/409/429/5xx/529 with retry-after.
import Anthropic from "@anthropic-ai/sdk";
import { generatorId, isLocalHost, type Summarizer, SummarizerError, type SummaryRequest, type SummaryResult } from "./types.js";

export interface AnthropicOptions {
  model: string;
  /** From ANTHROPIC_API_KEY; null lets the SDK use ANTHROPIC_AUTH_TOKEN. */
  apiKey: string | null;
  /** Tests only; otherwise the SDK uses ANTHROPIC_BASE_URL or the public API. */
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
  private readonly client: Anthropic;

  constructor(private readonly o: AnthropicOptions) {
    this.model = o.model;
    this.client = new Anthropic({
      ...(o.apiKey ? { apiKey: o.apiKey } : {}),
      ...(o.baseURL ? { baseURL: o.baseURL } : {}),
      maxRetries: o.maxRetries ?? 3,
      timeout: o.timeoutMs ?? 60_000,
    });
    const base = new URL(this.client.baseURL);
    this.host = base.host;
    this.external = !isLocalHost(base.hostname);
  }

  generatorId(promptVersion: number): string {
    return generatorId(this.provider, this.model, promptVersion);
  }

  async summarize(req: SummaryRequest): Promise<SummaryResult> {
    let msg: Anthropic.Message;
    try {
      msg = await this.client.messages.create({
        model: this.model,
        max_tokens: this.o.maxTokens ?? 2048,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        // Summaries are routine work: keep thinking (billed as output) small.
        ...(supportsEffort(this.model) ? { output_config: { effort: "low" as const } } : {}),
      });
    } catch (e) {
      throw this.mapError(e);
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

  private mapError(e: unknown): SummarizerError {
    // Most specific first (SDK error classes, never message matching).
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return new SummarizerError("auth", `${this.host} rejected the API key (${e.status}); check ANTHROPIC_API_KEY`, e.status);
    }
    if (e instanceof Anthropic.RateLimitError) return new SummarizerError("rate-limit", `${this.host} is rate limiting (429): ${e.message}`, 429);
    if (e instanceof Anthropic.APIConnectionError) return new SummarizerError("network", `cannot reach ${this.host}: ${e.message}`);
    if (e instanceof Anthropic.InternalServerError) return new SummarizerError("server", `${this.host} failed (${e.status})`, e.status);
    if (e instanceof Anthropic.APIError) {
      const status = e.status ?? 0;
      if (status >= 500) return new SummarizerError("server", `${this.host} failed (${status})`, status);
      return new SummarizerError("bad-request", `${this.host} rejected the request (${status}); check [summarizer] model: ${e.message}`, status);
    }
    return new SummarizerError("bad-response", (e as Error).message ?? String(e));
  }
}
