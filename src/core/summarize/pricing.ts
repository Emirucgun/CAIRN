// Cost estimates (SPEC §Summarizer: bring your own key). Built-in prices
// exist only for current Anthropic models, dated with the price list they
// came from; other providers need price_* settings, else "cost unknown".
import type { Config } from "../types.js";

export const PRICE_TABLE_DATE = "2026-11-03";

/** USD per million tokens [input, output], Anthropic first-party API rates. */
const ANTHROPIC_PRICES: Record<string, [number, number]> = {
  "claude-fable-5-2": [8, 40],
  "claude-mythos-5-2": [8, 40],
  "claude-fable-5-1": [10, 50],
  "claude-mythos-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  // Prompts up to 100K tokens; summary prompts are far below that.
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1, 5],
};

export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
  source: "config" | "built-in";
}

export function priceFor(provider: string, model: string, cfg: Config["summarizer"]): Price | null {
  if (cfg.price_input_per_mtok !== undefined && cfg.price_output_per_mtok !== undefined) {
    return { inputPerMTok: cfg.price_input_per_mtok, outputPerMTok: cfg.price_output_per_mtok, source: "config" };
  }
  if (provider !== "anthropic") return null;
  const p = ANTHROPIC_PRICES[model];
  return p ? { inputPerMTok: p[0], outputPerMTok: p[1], source: "built-in" } : null;
}

export function costUsd(price: Price, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
}

/** Tokenizer correction from [models.factors]: the longest key the model id starts with or contains. */
export function factorFor(model: string, factors: Record<string, number>): number {
  const id = model.toLowerCase();
  let best: [string, number] | null = null;
  for (const [k, v] of Object.entries(factors)) {
    if (id.includes(k.toLowerCase()) && (!best || k.length > best[0].length)) best = [k, v];
  }
  return best ? best[1] : 1;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
