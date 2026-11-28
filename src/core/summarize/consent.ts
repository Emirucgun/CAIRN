// Per-repo consent to send source to an external API (SPEC §Summarizer):
// asked once per (provider, host); localhost needs none; deleting .cairn/
// revokes it.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { renameWithRetry } from "../fsutil.js";
import { ConsentFile, InvalidFormatError, parseVersioned, SCHEMA } from "../types.js";

export interface ConsentTarget {
  provider: string;
  host: string;
  external: boolean;
}

function read(path: string): ConsentFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { schema: 1, grants: [] };
    throw e;
  }
  try {
    return parseVersioned("consent file", ConsentFile, SCHEMA.consent, JSON.parse(text));
  } catch (e) {
    // An unreadable consent file grants nothing: ask again rather than guess.
    if (e instanceof InvalidFormatError || e instanceof SyntaxError) return { schema: 1, grants: [] };
    throw e;
  }
}

export function hasConsent(path: string, t: ConsentTarget): boolean {
  if (!t.external) return true;
  return read(path).grants.some((g) => g.provider === t.provider && g.host === t.host);
}

export function grantConsent(path: string, t: ConsentTarget, now = new Date()): void {
  const file = read(path);
  if (file.grants.some((g) => g.provider === t.provider && g.host === t.host)) return;
  file.grants.push({ provider: t.provider, host: t.host, granted_at: now.toISOString() });
  const valid = ConsentFile.parse(file);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2) + "\n");
  renameWithRetry(tmp, path);
}
