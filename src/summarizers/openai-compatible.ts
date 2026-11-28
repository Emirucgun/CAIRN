// OpenAI-compatible chat completions (also Ollama, via its /v1 endpoint), with
// Node's built-in fetch. Retries 408/409/429/5xx with retry-after.
import { setTimeout as sleep } from "node:timers/promises";
import { isLocalHost, generatorId, type Summarizer, SummarizerError, type SummaryRequest, type SummaryResult } from "./types.js";

export interface OpenAICompatibleOptions {
  provider: "openai-compatible" | "ollama";
  model: string;
  baseUrl: string;
  /** Name of the env var the key came from, for error messages. Never the key. */
  keyEnv: string | null;
  apiKey: string | null;
  maxTokens?: number;
  maxRetries?: number;
  timeoutMs?: number;
  /** Base backoff; tests set it to 0. */
  backoffMs?: number;
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export class OpenAICompatibleSummarizer implements Summarizer {
  readonly provider: "openai-compatible" | "ollama";
  readonly model: string;
  readonly host: string;
  readonly external: boolean;
  private readonly url: string;

  constructor(private readonly o: OpenAICompatibleOptions) {
    this.provider = o.provider;
    this.model = o.model;
    const base = new URL(o.baseUrl);
    this.host = base.host;
    this.external = !isLocalHost(base.hostname);
    this.url = `${o.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  generatorId(promptVersion: number): string {
    return generatorId(this.provider, this.model, promptVersion);
  }

  async summarize(req: SummaryRequest): Promise<SummaryResult> {
    const maxRetries = this.o.maxRetries ?? 3;
    const body = JSON.stringify({
      model: this.model,
      max_tokens: this.o.maxTokens ?? 300,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.o.apiKey) headers.authorization = `Bearer ${this.o.apiKey}`;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.url, { method: "POST", headers, body, signal: AbortSignal.timeout(this.o.timeoutMs ?? 60_000) });
      } catch (e) {
        if (attempt < maxRetries) {
          await sleep(this.backoff(attempt, null));
          continue;
        }
        throw new SummarizerError("network", `cannot reach ${this.host}: ${(e as Error).message}`);
      }
      if (res.ok) return this.parse(await res.text());
      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
        await res.body?.cancel();
        await sleep(this.backoff(attempt, res.headers));
        continue;
      }
      throw await this.httpError(res);
    }
  }

  private backoff(attempt: number, headers: Headers | null): number {
    const base = this.o.backoffMs ?? 500;
    const ms = headers?.get("retry-after-ms");
    if (ms && Number.isFinite(Number(ms))) return Math.min(Number(ms), 60_000);
    const after = headers?.get("retry-after");
    if (after) {
      const secs = Number(after);
      if (Number.isFinite(secs)) return Math.min(secs * 1000, 60_000);
      const when = Date.parse(after);
      if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), 60_000);
    }
    return base * 2 ** attempt;
  }

  private async httpError(res: Response): Promise<SummarizerError> {
    const detail = await res
      .text()
      .then((t) => {
        try {
          const j = JSON.parse(t) as { error?: { message?: string } | string };
          return typeof j.error === "string" ? j.error : (j.error?.message ?? "");
        } catch {
          return "";
        }
      })
      .catch(() => "");
    const suffix = detail ? `: ${detail.slice(0, 200)}` : "";
    if (res.status === 401 || res.status === 403) {
      const where = this.o.keyEnv ? `check ${this.o.keyEnv}` : "this server needs an API key: set [summarizer] api_key_env";
      return new SummarizerError("auth", `${this.host} rejected the API key (${res.status}); ${where}${suffix}`, res.status);
    }
    if (res.status === 429) return new SummarizerError("rate-limit", `${this.host} is rate limiting (429)${suffix}`, 429);
    if (res.status >= 500) return new SummarizerError("server", `${this.host} failed (${res.status})${suffix}`, res.status);
    return new SummarizerError("bad-request", `${this.host} rejected the request (${res.status}); check [summarizer] model${suffix}`, res.status);
  }

  private parse(text: string): SummaryResult {
    let j: {
      choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      j = JSON.parse(text) as typeof j;
    } catch {
      throw new SummarizerError("bad-response", `${this.host} returned something that isn't JSON`);
    }
    const choice = j.choices?.[0];
    if (!choice) throw new SummarizerError("bad-response", `${this.host} returned no choices`);
    if (choice.finish_reason === "content_filter" || choice.message?.refusal) {
      throw new SummarizerError("refusal", `${this.model} declined to summarize this content`);
    }
    if (choice.finish_reason === "length") throw new SummarizerError("truncated", `${this.model} hit the output limit before finishing`);
    const out = (choice.message?.content ?? "").trim();
    if (!out) throw new SummarizerError("empty", `${this.model} returned an empty summary`);
    return {
      text: out,
      usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 },
    };
  }
}
