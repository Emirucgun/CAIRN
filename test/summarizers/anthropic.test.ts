import { describe, expect, it } from "vitest";
import { AnthropicSummarizer, supportsEffort } from "../../src/summarizers/index.js";
import { mockServer } from "./mock-server.js";

const msg = (text: string, stop = "end_turn") => ({
  status: 200,
  body: {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
});

const REQ = { system: "Summarize code.", prompt: "Path: src/a.ts\n..." };
const make = (url: string, model = "claude-haiku-5-5", maxRetries = 2) => new AnthropicSummarizer({ model, apiKey: "test-ant-key", baseURL: url, maxRetries });

describe("Anthropic summarizer (SDK against a mock server)", () => {
  it("sends a Messages request with low effort and returns only the text and actual usage", async () => {
    const m = await mockServer(msg("Creates and refreshes sessions."));
    const s = make(m.url);
    expect(await s.summarize(REQ)).toEqual({ text: "Creates and refreshes sessions.", usage: { input_tokens: 900, output_tokens: 40 } });
    const [r] = m.requests;
    expect(r?.url).toBe("/v1/messages");
    // SDK 1.x sends the API key as a bearer token, not x-api-key.
    expect(r?.headers.authorization).toBe("Bearer test-ant-key");
    expect(r?.headers["anthropic-version"]).toBe("2026-10-21");
    expect(r?.body).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 2048,
      system: "Summarize code.",
      messages: [{ role: "user", content: "Path: src/a.ts\n..." }],
      output_config: { effort: "low" },
    });
    expect(s.generatorId(1)).toBe("anthropic/claude-haiku-5-5@p1");
    expect(s.host).toBe(new URL(m.url).host);
  });

  it("omits effort for models that don't take it", async () => {
    const m = await mockServer(msg("ok"));
    await make(m.url, "claude-haiku-4-5").summarize(REQ);
    expect((m.requests[0]?.body as Record<string, unknown>).output_config).toBeUndefined();
  });

  it("knows which models take effort", () => {
    for (const id of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2", "claude-opus-4-8", "claude-sonnet-4-6"]) {
      expect(supportsEffort(id), id).toBe(true);
    }
    for (const id of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-3-5-haiku-latest"]) expect(supportsEffort(id), id).toBe(false);
  });

  it.each([
    ["refusal", msg("", "refusal")],
    ["truncated", msg("Creates and", "max_tokens")],
    ["empty", msg("  ")],
  ])("reports %s", async (kind, reply) => {
    const m = await mockServer(reply);
    await expect(make(m.url).summarize(REQ)).rejects.toMatchObject({ kind });
  });

  it("retries 429 via the SDK, then succeeds", async () => {
    const m = await mockServer(
      { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow" } }, headers: { "retry-after-ms": "1" } },
      msg("Done."),
    );
    expect((await make(m.url).summarize(REQ)).text).toBe("Done.");
    expect(m.requests).toHaveLength(2);
  });

  it.each([
    [401, "authentication_error", "auth", /check ANTHROPIC_API_KEY/],
    [404, "not_found_error", "bad-request", /check \[summarizer\] model/],
  ])("maps %i to %s without printing the key", async (status, type, kind, text) => {
    const m = await mockServer({ status, body: { type: "error", error: { type, message: "nope" } } });
    const err = (await make(m.url).summarize(REQ).catch((e: unknown) => e)) as Error & { kind: string };
    expect(err.kind).toBe(kind);
    expect(err.message).toMatch(text);
    expect(err.message).not.toContain("test-ant-key");
  });

  it("maps exhausted 5xx retries to a server error", async () => {
    const m = await mockServer({ status: 529, body: { type: "error", error: { type: "overloaded_error", message: "busy" } }, headers: { "retry-after-ms": "1" } });
    await expect(make(m.url, "claude-haiku-5-5", 1).summarize(REQ)).rejects.toMatchObject({ kind: "server" });
    expect(m.requests).toHaveLength(2);
  });
});
