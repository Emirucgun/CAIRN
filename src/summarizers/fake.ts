// Deterministic summarizer for tests (SPEC §Testing). Never used by the CLI
// unless a test injects it.
import { createHash } from "node:crypto";
import { generatorId, type Summarizer, type SummarizerError, type SummaryRequest, type SummaryResult } from "./types.js";

export class FakeSummarizer implements Summarizer {
  readonly provider = "fake" as const;
  readonly host = "fake.invalid";
  readonly calls: SummaryRequest[] = [];

  constructor(
    readonly model = "fake-1",
    readonly external = true,
    /** Return an error for prompts this matches. */
    private readonly failWhen: (req: SummaryRequest) => SummarizerError | null = () => null,
  ) {}

  generatorId(promptVersion: number): string {
    return generatorId(this.provider, this.model, promptVersion);
  }

  summarize(req: SummaryRequest): Promise<SummaryResult> {
    this.calls.push(req);
    const err = this.failWhen(req);
    if (err) return Promise.reject(err);
    const subject = /^Path: (.+)$/m.exec(req.prompt)?.[1] ?? "input";
    const digest = createHash("sha256").update(req.prompt).digest("hex").slice(0, 8);
    return Promise.resolve({
      text: `Summary of ${subject} (${digest}).`,
      usage: { input_tokens: Math.ceil((req.system.length + req.prompt.length) / 4), output_tokens: 12 },
    });
  }
}
