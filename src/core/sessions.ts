// Session cursors (SPEC §Session cursor): .cairn/sessions/<agent>.json, one
// per agent identity, written atomically.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentId, AGENT_ID_PATTERN, InvalidFormatError, parseVersioned, SCHEMA, SchemaTooNewError, SessionCursor } from "./types.js";

export const DEFAULT_AGENT = "default";

export class InvalidAgentIdError extends Error {
  constructor(readonly id: string) {
    super(`invalid agent id ${JSON.stringify(id)}: use 1-64 of A-Z a-z 0-9 . _ - starting with a letter or digit (e.g. claude-code)`);
    this.name = "InvalidAgentIdError";
  }
}

export interface ResolvedAgent {
  id: AgentId;
  source: "flag" | "env" | "default";
}

/** --agent, then CAIRN_AGENT, then "default" (SPEC §Identity and tokens). */
export function resolveAgent(flag: string | undefined, env: NodeJS.ProcessEnv): ResolvedAgent {
  const pick = (id: string, source: ResolvedAgent["source"]): ResolvedAgent => {
    if (!AGENT_ID_PATTERN.test(id)) throw new InvalidAgentIdError(id);
    return { id, source };
  };
  if (flag !== undefined) return pick(flag, "flag");
  const fromEnv = env.CAIRN_AGENT;
  if (fromEnv) return pick(fromEnv, "env");
  return { id: DEFAULT_AGENT, source: "default" };
}

export type CursorRead =
  | { status: "ok"; cursor: SessionCursor }
  | { status: "none" }
  | { status: "unreadable"; detail: string };

export async function readCursor(sessionsDir: string, agent: AgentId): Promise<CursorRead> {
  let text: string;
  try {
    text = await readFile(join(sessionsDir, `${AgentId.parse(agent)}.json`), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "none" };
    throw e;
  }
  try {
    const cursor = parseVersioned("session cursor", SessionCursor, SCHEMA.sessionCursor, JSON.parse(text));
    if (cursor.agent !== agent) return { status: "unreadable", detail: `cursor belongs to ${cursor.agent}` };
    return { status: "ok", cursor };
  } catch (e) {
    if (e instanceof SchemaTooNewError) throw e; // written by a newer CAIRN: don't overwrite it
    if (e instanceof InvalidFormatError || e instanceof SyntaxError) return { status: "unreadable", detail: e.message };
    throw e;
  }
}

export async function writeCursor(sessionsDir: string, cursor: SessionCursor): Promise<void> {
  const valid = SessionCursor.parse(cursor);
  await mkdir(sessionsDir, { recursive: true });
  const path = join(sessionsDir, `${valid.agent}.json`);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(valid, null, 2) + "\n");
  await rename(tmp, path);
}
