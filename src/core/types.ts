// Every on-disk format (SPEC §Data model), defined once with zod. TS types
// are derived from these schemas; nothing else declares these shapes.
import { z } from "zod";

/** Highest `schema` this build knows for each versioned JSON format. */
export const SCHEMA = { cacheEntry: 3, sessionCursor: 1, consent: 1, stats: 1 } as const;

const gitHash = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a git object hash");
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a sha256 hex digest");
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative();

export const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const AgentId = z.string().regex(AGENT_ID_PATTERN, "agent id must be 1-64 of A-Z a-z 0-9 . _ - and start with a letter or digit");
export type AgentId = z.infer<typeof AgentId>;

// ---------------------------------------------------------------- cache entry

export const ObjectKind = z.enum(["blob", "tree"]);
export type ObjectKind = z.infer<typeof ObjectKind>;

export const Layer = z.enum(["skeleton", "summary"]);
export type Layer = z.infer<typeof Layer>;

export const SYMBOL_KINDS = [
  "function",
  "class",
  "method",
  "interface",
  "type",
  "enum",
  "const",
  "variable",
  "property",
  "struct",
  "protocol",
  "extension",
  "mixin",
] as const;
export const SymbolKind = z.enum(SYMBOL_KINDS);
export type SymbolKind = z.infer<typeof SymbolKind>;

export const SkeletonSymbol = z
  .object({
    /** Name; nested symbols are dotted, e.g. `Session.refresh`. */
    sym: z.string().min(1),
    kind: SymbolKind,
    sig: z.string(),
    /** 1-based, inclusive. */
    lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    exported: z.boolean(),
  })
  .refine((s) => s.lines[0] <= s.lines[1], { message: "lines must be [start, end] with start <= end" });
export type SkeletonSymbol = z.infer<typeof SkeletonSymbol>;

export const TreeChild = z.object({
  name: z.string().min(1),
  kind: ObjectKind,
  hash: gitHash,
  /** Summary layer only: the child's own summary text (schema 3); null everywhere else. */
  summary: z.string().nullable(),
});
export type TreeChild = z.infer<typeof TreeChild>;

export const SKIP_REASONS = ["too-large", "binary", "secret"] as const;

/** One direct file in a folder skeleton entry (schema 2). */
export const FolderFile = z.object({
  name: z.string().min(1),
  hash: gitHash,
  lang: z.string(),
  skeleton: z.array(SkeletonSymbol).nullable(),
  imports: z.array(z.string()).nullable(),
  tokens: z.object({ source: count, skeleton: count.nullable() }),
  /** Why the file has no skeleton; the matched text of a secret is never stored. */
  skipped: z.enum(SKIP_REASONS).nullable(),
});
export type FolderFile = z.infer<typeof FolderFile>;

export const CacheEntry = z
  .object({
    schema: z.literal(SCHEMA.cacheEntry),
    key: sha256Hex,
    object: z.object({ kind: ObjectKind, hash: gitHash }),
    layer: Layer,
    path_hint: z.string(),
    lang: z.string().nullable(),
    skeleton: z.array(SkeletonSymbol).nullable(),
    /** Raw import specifiers as written in the source (resolved at read time). */
    imports: z.array(z.string()).nullable(),
    summary: z.string().nullable(),
    children: z.array(TreeChild).nullable(),
    /** Folder skeletons only: the folder's direct files (schema 2). */
    files: z.array(FolderFile).nullable(),
    tokens: z.object({ source: count, skeleton: count.nullable(), summary: count.nullable() }),
    generator: z.string().min(1),
    created: timestamp,
  })
  .superRefine((e, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (e.object.kind === "blob" && e.children !== null) issue("blob entries must have children: null");
    if (e.object.kind === "tree" && e.skeleton !== null) issue("tree entries must have skeleton: null");
    if (e.object.kind === "tree" && e.children === null) issue("tree entries must list children");
    if (e.layer === "skeleton" && e.summary !== null) issue("skeleton entries must have summary: null");
    if (e.layer === "summary" && e.summary === null) issue("summary entries must have a summary");
    const folderSkeleton = e.object.kind === "tree" && e.layer === "skeleton";
    if (folderSkeleton && e.files === null) issue("folder skeleton entries must list files");
    if (!folderSkeleton && e.files !== null) issue("only folder skeleton entries have files");
    if (e.layer === "skeleton" && e.children?.some((c) => c.summary !== null)) issue("skeleton entries' children have summary: null");
  });

/** Cache entry migrations: schema 1 had no `files`; schema 2 children had no `summary`. */
export const CACHE_ENTRY_MIGRATIONS = {
  1: (d: Record<string, unknown>) => ({ ...d, files: null }),
  2: (d: Record<string, unknown>) => ({
    ...d,
    children: Array.isArray(d.children) ? d.children.map((c: Record<string, unknown>) => ({ ...c, summary: null })) : d.children,
  }),
};
export type CacheEntry = z.infer<typeof CacheEntry>;

// ------------------------------------------------------------- session cursor

export const SessionCursor = z.object({
  schema: z.literal(SCHEMA.sessionCursor),
  agent: AgentId,
  last_snapshot_tree: gitHash,
  /** null in a repo with no commits. */
  last_head: gitHash.nullable(),
  last_seen: timestamp,
  active_task: z.string().nullable(),
});
export type SessionCursor = z.infer<typeof SessionCursor>;

// -------------------------------------------------------------------- consent

/** `.cairn/consent.json`: per-repo consent to send code to an external API (SPEC §Summarizer). */
export const ConsentFile = z.object({
  schema: z.literal(SCHEMA.consent),
  grants: z.array(z.object({ provider: z.string().min(1), host: z.string().min(1), granted_at: timestamp })),
});
export type ConsentFile = z.infer<typeof ConsentFile>;

// ---------------------------------------------------------------- stats.jsonl

/** A command served text to an agent (SPEC §stats.jsonl). Token counts are chars/4 estimates. */
export const ServeEvent = z.object({
  schema: z.literal(SCHEMA.stats),
  type: z.literal("serve"),
  ts: timestamp,
  agent: AgentId,
  command: z.enum(["map", "read", "context"]),
  served_tokens: count,
  /** Estimated tokens of reading the covered files whole instead. */
  full_read_tokens: count,
});
export type ServeEvent = z.infer<typeof ServeEvent>;

/** One summarizer call, with the usage the provider reported. Never prompt or source text. */
export const SummarizeEvent = z.object({
  schema: z.literal(SCHEMA.stats),
  type: z.literal("summarize"),
  ts: timestamp,
  agent: AgentId,
  provider: z.string().min(1),
  model: z.string().min(1),
  input_tokens: count,
  output_tokens: count,
  cost_usd: z.number().nonnegative().nullable(),
});
export type SummarizeEvent = z.infer<typeof SummarizeEvent>;

export const StatsEvent = z.discriminatedUnion("type", [ServeEvent, SummarizeEvent]);
export type StatsEvent = z.infer<typeof StatsEvent>;

// --------------------------------------------------------------------- config

export const SUMMARIZER_PROVIDERS = ["off", "anthropic", "openai-compatible", "ollama"] as const;

/** Setting names that look like credentials: keys come only from env vars (SPEC §Summarizer). */
export const KEY_LIKE_SETTINGS = ["api_key", "apikey", "key", "token", "secret", "password"] as const;

export const Config = z.strictObject({
  summarizer: z
    .strictObject({
      provider: z.enum(SUMMARIZER_PROVIDERS).default("off"),
      /** Required when provider is not off; there is no default model. */
      model: z.string().min(1).optional(),
      /** openai-compatible and ollama only. */
      base_url: z.url({ protocol: /^https?$/ }).optional(),
      /** Name of the env var holding the API key. */
      api_key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name").optional(),
      price_input_per_mtok: z.number().nonnegative().optional(),
      price_output_per_mtok: z.number().nonnegative().optional(),
      max_calls_per_run: z.number().int().positive().default(200),
      concurrency: z.number().int().positive().default(4),
      /** Lines of source sent with a file's skeleton (SPEC §Algorithm 2 step 4). */
      source_lines: z.number().int().positive().max(2000).default(200),
    })
    .superRefine((v, ctx) => {
      if (v.provider !== "off" && !v.model) {
        ctx.addIssue({ code: "custom", path: ["model"], message: `model is required when provider is "${v.provider}" (there is no default model)` });
      }
      if (v.base_url && v.provider === "anthropic") {
        ctx.addIssue({ code: "custom", path: ["base_url"], message: "base_url applies to openai-compatible and ollama only" });
      }
    })
    .prefault({}),
  context: z
    .strictObject({
      max_diff_lines: z.number().int().positive().default(150),
    })
    .prefault({}),
  models: z
    .strictObject({
      factors: z.record(z.string(), z.number().positive()).default({ claude: 1.0, gpt: 1.0 }),
    })
    .prefault({}),
  records: z
    .strictObject({
      store_prompts: z.boolean().default(true),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

// ----------------------------------------------------------- schema handling

export class SchemaTooNewError extends Error {
  constructor(
    readonly format: string,
    readonly found: number,
    readonly known: number,
  ) {
    super(`${format} has schema ${found}, but this CAIRN only knows up to ${known}. Upgrade CAIRN.`);
    this.name = "SchemaTooNewError";
  }
}

export class InvalidFormatError extends Error {
  constructor(
    readonly format: string,
    readonly detail: string,
  ) {
    super(`invalid ${format}: ${detail}`);
    this.name = "InvalidFormatError";
  }
}

type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * Parses a versioned JSON value: rejects a higher `schema` than known,
 * migrates lower ones step by step (`migrations[n]` lifts schema n to n+1),
 * then validates.
 */
export function parseVersioned<S extends z.ZodType>(
  format: string,
  schema: S,
  known: number,
  data: unknown,
  migrations: Partial<Record<number, Migration>> = {},
): z.infer<S> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new InvalidFormatError(format, "not a JSON object");
  }
  let obj = data as Record<string, unknown>;
  const version = obj.schema;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new InvalidFormatError(format, "missing or invalid `schema`");
  }
  if (version > known) throw new SchemaTooNewError(format, version, known);
  for (let v = version; v < known; v++) {
    const migrate = migrations[v];
    if (!migrate) throw new InvalidFormatError(format, `no migration from schema ${v}`);
    obj = { ...migrate(obj), schema: v + 1 };
  }
  const result = schema.safeParse(obj);
  if (!result.success) throw new InvalidFormatError(format, z.prettifyError(result.error));
  return result.data;
}
