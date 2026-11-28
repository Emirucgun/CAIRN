import { describe, expect, it } from "vitest";
import { Config } from "../../src/core/types.js";
import { createSummarizer, OpenAICompatibleSummarizer, SummarizerError } from "../../src/summarizers/index.js";
import { mockServer } from "./mock-server.js";

const ok = (content: string, finish = "stop") => ({
  status: 200,
  body: { choices: [{ message: { role: "assistant", content }, finish_reason: finish }], usage: { prompt_tokens: 120, completion_tokens: 18 } },
});

function make(url: string, over: Partial<ConstructorParameters<typeof OpenAICompatibleSummarizer>[0]> = {}) {
  return new OpenAICompatibleSummarizer({ provider: "openai-compatible", model: "gpt-test", baseUrl: `${url}/v1`, keyEnv: "MY_KEY", apiKey: "test-key-123", backoffMs: 0, ...over });
}

const REQ = { system: "Summarize code.", prompt: "Path: src/a.ts\n..." };

describe("OpenAI-compatible summarizer", () => {
  it("posts a chat completion and returns text and actual usage", async () => {
    const m = await mockServer(ok("  Logs users in.  "));
    const s = make(m.url);
    expect(await s.summarize(REQ)).toEqual({ text: "Logs users in.", usage: { input_tokens: 120, output_tokens: 18 } });
    const [r] = m.requests;
    expect(r?.method).toBe("POST");
    expect(r?.url).toBe("/v1/chat/completions");
    expect(r?.headers.authorization).toBe("Bearer test-key-123");
    expect(r?.body).toEqual({
      model: "gpt-test",
      max_tokens: 300,
      messages: [
        { role: "system", content: "Summarize code." },
        { role: "user", content: "Path: src/a.ts\n..." },
      ],
    });
  });

  it("knows its host, whether it is external, and its generator id", async () => {
    const local = make("http://127.0.0.1:9");
    expect(local.host).toBe("127.0.0.1:9");
    expect(local.external).toBe(false);
    expect(make("https://llm.example.com").external).toBe(true);
    expect(local.generatorId(1)).toBe("openai-compatible/gpt-test@p1");
  });

  it("retries 429 and 5xx using retry-after, then succeeds", async () => {
    const m = await mockServer(
      { status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "0" } },
      { status: 503, body: {}, headers: { "retry-after-ms": "1" } },
      ok("Done."),
    );
    expect((await make(m.url).summarize(REQ)).text).toBe("Done.");
    expect(m.requests).toHaveLength(3);
  });

  it("gives up after maxRetries with the right kind", async () => {
    const m = await mockServer({ status: 500, body: { error: "boom" } });
    const err = await make(m.url, { maxRetries: 2 }).summarize(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SummarizerError);
    expect(err).toMatchObject({ kind: "server", status: 500 });
    expect(m.requests).toHaveLength(3);
  });

  it.each([
    [401, "auth", /check MY_KEY/],
    [403, "auth", /check MY_KEY/],
    [404, "bad-request", /check \[summarizer\] model: no such model/],
    [400, "bad-request", /rejected the request \(400\)/],
  ])("maps HTTP %i to %s without retrying, and never prints the key", async (status, kind, msg) => {
    const m = await mockServer({ status, body: { error: { message: "no such model" } } });
    const err = (await make(m.url).summarize(REQ).catch((e: unknown) => e)) as SummarizerError;
    expect(err).toMatchObject({ kind, status });
    expect(err.message).toMatch(msg);
    expect(err.message).not.toContain("test-key-123");
    expect(m.requests).toHaveLength(1);
  });

  it.each([
    ["truncated", ok("partial", "length")],
    ["refusal", ok("", "content_filter")],
    ["refusal", { status: 200, body: { choices: [{ message: { content: null, refusal: "I can't." }, finish_reason: "stop" }] } }],
    ["empty", ok("   ")],
    ["bad-response", { status: 200, body: { nothing: true } }],
  ])("reports %s", async (kind, reply) => {
    const m = await mockServer(reply);
    await expect(make(m.url).summarize(REQ)).rejects.toMatchObject({ kind });
  });

  it("reports an unreachable server as a network error after retries", async () => {
    const s = make("http://127.0.0.1:1", { maxRetries: 1, timeoutMs: 2000 });
    await expect(s.summarize(REQ)).rejects.toMatchObject({ kind: "network" });
  });

  it("sends no Authorization header without a key", async () => {
    const m = await mockServer(ok("x"));
    await make(m.url, { apiKey: null, keyEnv: null }).summarize(REQ);
    expect(m.requests[0]?.headers.authorization).toBeUndefined();
  });
});

describe("createSummarizer", () => {
  const cfg = (s: Record<string, unknown>) => Config.parse({ summarizer: s }).summarizer;

  it("returns null when summaries are off (the default)", () => {
    expect(createSummarizer(Config.parse({}).summarizer, {})).toBeNull();
  });

  it("reads the key only from the env var named by api_key_env", () => {
    const s = createSummarizer(cfg({ provider: "openai-compatible", model: "m", base_url: "https://llm.example.com/v1", api_key_env: "LLM_KEY" }), { LLM_KEY: "k" });
    expect(s).toMatchObject({ provider: "openai-compatible", host: "llm.example.com", external: true });
    expect(() =>
      createSummarizer(cfg({ provider: "openai-compatible", model: "m", base_url: "https://llm.example.com/v1", api_key_env: "LLM_KEY" }), {}),
    ).toThrow(/set LLM_KEY to use the openai-compatible summarizer at llm.example.com/);
    expect(() => createSummarizer(cfg({ provider: "openai-compatible", model: "m" }), {})).toThrow(/set OPENAI_API_KEY/);
  });

  it("allows a keyless local server, and Ollama needs no key", () => {
    expect(createSummarizer(cfg({ provider: "openai-compatible", model: "m", base_url: "http://localhost:8080/v1" }), {})).toMatchObject({ external: false });
    const o = createSummarizer(cfg({ provider: "ollama", model: "llama3" }), {});
    expect(o).toMatchObject({ provider: "ollama", host: "127.0.0.1:11434", external: false });
    expect(o?.generatorId(1)).toBe("ollama/llama3@p1");
  });

  it("adds /v1 to an Ollama base URL given without a path", async () => {
    const m = await mockServer(ok("x"));
    const o = createSummarizer(cfg({ provider: "ollama", model: "llama3", base_url: m.url }), {});
    await o?.summarize(REQ);
    expect(m.requests[0]?.url).toBe("/v1/chat/completions");
  });

  it("requires ANTHROPIC_API_KEY (or the SDK's ANTHROPIC_AUTH_TOKEN) for anthropic", () => {
    expect(() => createSummarizer(cfg({ provider: "anthropic", model: "claude-haiku-5-5" }), {})).toThrow(/set ANTHROPIC_API_KEY/);
    expect(createSummarizer(cfg({ provider: "anthropic", model: "claude-haiku-5-5" }), { ANTHROPIC_API_KEY: "k" })).toMatchObject({
      provider: "anthropic",
      external: true,
    });
  });
});
