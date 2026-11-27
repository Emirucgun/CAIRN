// Content-addressed cache (SPEC §Cache key, §Cache entry). An entry is only
// ever returned for the exact git object hash it was built from, so a lookup
// can never hand back a stale skeleton or summary.
import { createHash, randomBytes } from "node:crypto";
// File I/O here is synchronous on purpose: entries are small, and sync reads
// measured ~16x faster than fs/promises for 9,000 of them (no thread-pool hop).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CacheEntry, InvalidFormatError, type Layer, type ObjectKind, parseVersioned, SCHEMA, SchemaTooNewError } from "./types.js";

export interface KeyParts {
  kind: ObjectKind;
  hash: string;
  layer: Layer;
  generator: string;
}

/** sha256(object_kind ":" git_object_hash ":" layer ":" generator_id), hex. */
export function cacheKey(p: KeyParts): string {
  return createHash("sha256").update(`${p.kind}:${p.hash}:${p.layer}:${p.generator}`).digest("hex");
}

export type CorruptReason = "unreadable" | "json" | "schema" | "invalid" | "key-mismatch";

export interface CorruptEntry {
  path: string;
  reason: CorruptReason;
  detail: string;
}

export interface ScanResult {
  ok: number;
  corrupt: CorruptEntry[];
}

const KEY_FILE = /^[0-9a-f]{62}\.json$/;
const SHARD_DIR = /^[0-9a-f]{2}$/;

export class Cache {
  /** Shard directories known to exist, so put() doesn't mkdir 10,000 times. */
  private readonly shards = new Set<string>();

  constructor(
    readonly dir: string,
    /** Called when a lookup finds and deletes a bad entry (SPEC §Failure modes). */
    private readonly onCorrupt: (c: CorruptEntry) => void = () => {},
  ) {}

  pathFor(key: string): string {
    return join(this.dir, key.slice(0, 2), `${key.slice(2)}.json`);
  }

  /** The entry for these parts, or null. Corrupt or wrong-schema entries are deleted and reported. */
  async get(parts: KeyParts): Promise<CacheEntry | null> {
    const key = cacheKey(parts);
    const path = this.pathFor(key);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const checked = checkEntry(text, key);
    if ("reason" in checked) {
      rmSync(path, { force: true });
      this.onCorrupt({ path, ...checked });
      return null;
    }
    // The key covers these, but check anyway: correctness before cleverness.
    const e = checked.entry;
    if (e.object.kind !== parts.kind || e.object.hash !== parts.hash || e.layer !== parts.layer || e.generator !== parts.generator) {
      rmSync(path, { force: true });
      this.onCorrupt({ path, reason: "key-mismatch", detail: "entry fields do not match the requested key" });
      return null;
    }
    return e;
  }

  /** Validates and writes an entry atomically. Its `key` must match its fields. */
  async put(entry: CacheEntry): Promise<void> {
    const valid = CacheEntry.parse(entry);
    const key = keyOf(valid);
    if (valid.key !== key) throw new InvalidFormatError("cache entry", `key ${valid.key} does not match its fields (${key})`);
    const path = this.pathFor(key);
    const shard = join(this.dir, key.slice(0, 2));
    if (!this.shards.has(shard)) {
      mkdirSync(shard, { recursive: true });
      this.shards.add(shard);
    }
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(valid) + "\n");
    renameSync(tmp, path);
  }

  /** Checks every entry. With `fix`, deletes corrupt ones and stray temp files. */
  async scan(opts: { fix?: boolean } = {}): Promise<ScanResult> {
    const result: ScanResult = { ok: 0, corrupt: [] };
    for (const shard of await listDir(this.dir)) {
      if (!SHARD_DIR.test(shard)) continue;
      for (const file of await listDir(join(this.dir, shard))) {
        const path = join(this.dir, shard, file);
        let bad: CorruptEntry | null = null;
        if (!KEY_FILE.test(file)) {
          bad = { path, reason: "unreadable", detail: "not a cache entry file name" };
        } else {
          const text = await readFile(path, "utf8").catch(() => null);
          const checked = text === null ? { reason: "unreadable" as const, detail: "cannot read" } : checkEntry(text, shard + file.slice(0, 62));
          if ("reason" in checked) bad = { path, ...checked };
        }
        if (bad) {
          result.corrupt.push(bad);
          if (opts.fix) await rm(path, { force: true });
        } else {
          result.ok++;
        }
      }
    }
    return result;
  }
}

function keyOf(e: CacheEntry): string {
  return cacheKey({ kind: e.object.kind, hash: e.object.hash, layer: e.layer, generator: e.generator });
}

function checkEntry(text: string, expectedKey: string): { entry: CacheEntry } | { reason: CorruptReason; detail: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { reason: "json", detail: (e as Error).message };
  }
  let entry: CacheEntry;
  try {
    entry = parseVersioned("cache entry", CacheEntry, SCHEMA.cacheEntry, data);
  } catch (e) {
    if (e instanceof SchemaTooNewError) return { reason: "schema", detail: e.message };
    if (e instanceof InvalidFormatError) return { reason: "invalid", detail: e.detail };
    throw e;
  }
  if (entry.key !== expectedKey || keyOf(entry) !== expectedKey) {
    return { reason: "key-mismatch", detail: `stored under ${expectedKey} but its fields hash to ${keyOf(entry)}` };
  }
  return { entry };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
