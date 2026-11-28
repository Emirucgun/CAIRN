// The summarizer interface (SPEC §Summarizer: bring your own key). Providers
// turn one prompt into one short summary and report what the call used.

export interface SummaryRequest {
  system: string;
  prompt: string;
}

export interface SummaryUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface SummaryResult {
  text: string;
  /** Actual usage the provider reported for this call. */
  usage: SummaryUsage;
}

export type SummarizerErrorKind =
  | "missing-key" // the env var holding the key is not set
  | "auth" // 401/403
  | "rate-limit" // 429 after retries
  | "server" // 5xx/529 after retries
  | "network" // connection failure or timeout after retries
  | "bad-request" // 400/404/422: wrong model name, bad settings
  | "refusal" // the model declined
  | "truncated" // hit the output limit before finishing
  | "empty" // no text came back
  | "bad-response"; // unexpected shape

export class SummarizerError extends Error {
  constructor(
    readonly kind: SummarizerErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SummarizerError";
  }
}

export interface Summarizer {
  readonly provider: "anthropic" | "openai-compatible" | "ollama" | "fake";
  readonly model: string;
  /** Host the code is sent to, e.g. "api.anthropic.com" or "127.0.0.1:11434". */
  readonly host: string;
  /** False for localhost: no consent needed (SPEC §Summarizer). */
  readonly external: boolean;
  /** `<provider>/<model>@p<prompt-version>` (SPEC §Cache key). */
  generatorId(promptVersion: number): string;
  summarize(req: SummaryRequest): Promise<SummaryResult>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase()) || hostname.toLowerCase().endsWith(".localhost");
}

export function generatorId(provider: string, model: string, promptVersion: number): string {
  return `${provider}/${model}@p${promptVersion}`;
}
