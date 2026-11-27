// A small exclusive lock file, so a CLI run and a long-lived MCP server never
// share the scratch index at the same time.
import { open, readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

export class LockTimeoutError extends Error {
  constructor(
    readonly path: string,
    readonly holder: string,
  ) {
    super(`timed out waiting for ${path} (held by ${holder || "unknown"}). If no other cairn is running, delete it.`);
    this.name = "LockTimeoutError";
  }
}

export interface LockOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** A lock older than this is considered abandoned even if its pid looks alive. */
  staleMs?: number;
}

interface Holder {
  pid: number;
  host: string;
  at: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isStale(path: string, staleMs: number): Promise<{ stale: boolean; text: string }> {
  const [text, info] = await Promise.all([readFile(path, "utf8").catch(() => ""), stat(path).catch(() => null)]);
  if (!info) return { stale: true, text }; // released between our open() and now
  if (Date.now() - info.mtimeMs > staleMs) return { stale: true, text };
  try {
    const h = JSON.parse(text) as Partial<Holder>;
    if (h.host === hostname() && typeof h.pid === "number" && !alive(h.pid)) return { stale: true, text };
  } catch {
    // Empty or half-written: the holder is still writing it, or crashed; age decides.
  }
  return { stale: false, text };
}

/** Runs `fn` while holding the lock at `path`. */
export async function withLock<T>(path: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, pollMs = 25, staleMs = 10 * 60_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fh = await open(path, "wx");
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() } satisfies Holder));
      } finally {
        await fh.close();
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const { stale, text } = await isStale(path, staleMs);
      if (stale) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(path, text);
      await sleep(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}
