// Runs a summary plan bottom-up with bounded concurrency. Every request is
// secret-scanned right before it is sent; each finished entry is written at
// once, so an interrupted run resumes from the cache. A folder is never
// cached while one of its summarizable children failed.
import type { Cache } from "../cache.js";
import { scanForSecrets, SECRET_PATTERNS } from "../secrets.js";
import { renderSkeleton } from "../skeleton/index.js";
import { estimateTokens } from "../tokens.js";
import type { CacheEntry } from "../types.js";
import type { Summarizer, SummaryUsage } from "../../summarizers/index.js";
import { SummarizerError } from "../../summarizers/index.js";
import { fileSummaryKey, folderSummaryKey, type FolderNode, type Plan, type PlanNode } from "./plan.js";
import { cleanSummary, type FolderChildInput, folderPrompt, SYSTEM_PROMPT } from "./prompts.js";

export class CallCapError extends Error {
  constructor(
    readonly needed: number,
    readonly cap: number,
  ) {
    super(`this run needs ${needed} summary calls, over the cap of ${cap}. Summarize a narrower path, or pass --max-calls ${needed} to allow it.`);
    this.name = "CallCapError";
  }
}

/** SPEC: a run over the cap is refused before it starts; a partial tree is never summarized. */
export function checkCap(plan: Plan, cap: number): void {
  if (plan.estimate.calls > cap) throw new CallCapError(plan.estimate.calls, cap);
}

export interface CallRecord {
  path: string;
  usage: SummaryUsage;
}

export interface RunResult {
  done: string[];
  failed: { path: string; kind: SummarizerError["kind"] | "secret"; message: string }[];
  /** Folders not built because a child failed. */
  blocked: string[];
  calls: CallRecord[];
  usage: SummaryUsage;
}

export interface RunOptions {
  concurrency: number;
  now?: () => Date;
  /** Called after each node finishes or fails (progress display). */
  onProgress?: (finished: number, total: number, path: string) => void;
}

export async function runPlan(plan: Plan, summarizer: Summarizer, cache: Cache, opts: RunOptions): Promise<RunResult> {
  const result: RunResult = { done: [], failed: [], blocked: [], calls: [], usage: { input_tokens: 0, output_tokens: 0 } };
  const byPath = new Map<string, PlanNode>(plan.nodes.map((n) => [n.path, n]));
  /** Summary text and exported symbol names of everything finished in this run, by path. */
  const fresh = new Map<string, { summary: string; symbols: string[] }>();
  const state = new Map<string, Promise<"ok" | "failed">>();
  const now = () => (opts.now?.() ?? new Date()).toISOString();
  let finished = 0;
  const total = plan.nodes.length;

  // A small semaphore: at most `concurrency` calls in flight.
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = async () => {
    if (active < Math.max(1, opts.concurrency)) {
      active++;
      return;
    }
    await new Promise<void>((r) => waiting.push(r));
    active++;
  };
  const release = () => {
    active--;
    waiting.shift()?.();
  };

  const call = async (node: PlanNode, prompt: string): Promise<string | null> => {
    const [hit] = scanForSecrets(`${SYSTEM_PROMPT}\n${prompt}`, SECRET_PATTERNS);
    if (hit) {
      result.failed.push({ path: node.path, kind: "secret", message: `not sent: looks like it contains a secret (${hit.pattern})` });
      return null;
    }
    await acquire();
    try {
      const r = await summarizer.summarize({ system: SYSTEM_PROMPT, prompt });
      result.calls.push({ path: node.path, usage: r.usage });
      result.usage.input_tokens += r.usage.input_tokens;
      result.usage.output_tokens += r.usage.output_tokens;
      const text = cleanSummary(r.text);
      if (!text) throw new SummarizerError("empty", `${summarizer.model} returned an empty summary`);
      return text;
    } catch (e) {
      const err = e instanceof SummarizerError ? e : new SummarizerError("bad-response", (e as Error).message ?? String(e));
      result.failed.push({ path: node.path, kind: err.kind, message: err.message });
      return null;
    } finally {
      release();
    }
  };

  const exportedNames = (e: Pick<CacheEntry, "skeleton"> | null) => (e?.skeleton ?? []).filter((x) => x.exported && !x.sym.includes(".")).map((x) => x.sym);

  const childInfo = async (c: FolderNode["children"][number]): Promise<{ summary: string | null; symbols: string[] }> => {
    const f = fresh.get(c.path);
    if (f !== undefined) return f;
    if (!c.summarizable) return { summary: null, symbols: [] };
    const key = c.kind === "tree" ? folderSummaryKey(c.hash, plan.generator) : fileSummaryKey(c.hash, plan.generator);
    const e = await cache.get({ kind: c.kind, hash: c.hash, layer: "summary", generator: plan.generator });
    return e && e.key === key ? { summary: e.summary, symbols: exportedNames(e) } : { summary: null, symbols: [] };
  };

  const process = (node: PlanNode): Promise<"ok" | "failed"> => {
    const existing = state.get(node.path);
    if (existing) return existing;
    const p = (async (): Promise<"ok" | "failed"> => {
      let entry: CacheEntry;
      if (node.kind === "file") {
        const summary = await call(node, node.prompt);
        if (summary === null) return "failed";
        entry = {
          schema: 3,
          key: node.key,
          object: { kind: "blob", hash: node.hash },
          layer: "summary",
          path_hint: node.path,
          lang: node.lang,
          skeleton: node.skeleton,
          imports: null,
          summary,
          children: null,
          files: null,
          tokens: { source: node.sourceTokens, skeleton: node.skeleton ? estimateTokens(renderSkeleton(node.skeleton)) : null, summary: estimateTokens(summary) },
          generator: plan.generator,
          created: now(),
        };
      } else {
        // Wait for this folder's planned children; any failure blocks it.
        const deps = node.children.map((c) => byPath.get(c.path)).filter((n): n is PlanNode => n !== undefined);
        const outcomes = await Promise.all(deps.map(process));
        if (outcomes.includes("failed")) {
          result.blocked.push(node.path);
          return "failed";
        }
        const children: FolderChildInput[] = [];
        const stored: NonNullable<CacheEntry["children"]> = [];
        for (const c of node.children) {
          const { summary, symbols } = await childInfo(c);
          children.push({ name: c.name, kind: c.kind, summary, symbols, ...(c.summarizable ? {} : { note: "not summarized" }) });
          stored.push({ name: c.name, kind: c.kind, hash: c.hash, summary });
        }
        const summary = await call(node, folderPrompt(node.path, children));
        if (summary === null) return "failed";
        entry = {
          schema: 3,
          key: node.key,
          object: { kind: "tree", hash: node.hash },
          layer: "summary",
          path_hint: node.path,
          lang: null,
          skeleton: null,
          imports: null,
          summary,
          children: stored,
          files: null,
          tokens: { source: 0, skeleton: null, summary: estimateTokens(summary) },
          generator: plan.generator,
          created: now(),
        };
      }
      await cache.put(entry);
      fresh.set(node.path, { summary: entry.summary as string, symbols: exportedNames(entry) });
      result.done.push(node.path);
      return "ok";
    })().then((outcome) => {
      opts.onProgress?.(++finished, total, node.path);
      return outcome;
    });
    state.set(node.path, p);
    return p;
  };

  await Promise.all(plan.nodes.map(process));
  return result;
}
