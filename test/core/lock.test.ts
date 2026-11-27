import { utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { LockTimeoutError, withLock } from "../../src/core/lock.js";
import { tmpDir } from "../helpers/tmp.js";

describe("withLock", () => {
  it("serializes concurrent holders", async () => {
    const path = join(tmpDir(), "x.lock");
    const events: string[] = [];
    const job = (name: string) =>
      withLock(path, async () => {
        events.push(`${name}:in`);
        await sleep(30);
        events.push(`${name}:out`);
      });
    await Promise.all([job("a"), job("b"), job("c")]);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]?.replace(":in", "")).toBe(events[i + 1]?.replace(":out", ""));
    }
  });

  it("releases the lock when fn throws", async () => {
    const path = join(tmpDir(), "x.lock");
    await expect(withLock(path, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(withLock(path, () => Promise.resolve(1))).resolves.toBe(1);
  });

  it("takes over a lock left by a dead process", async () => {
    const path = join(tmpDir(), "x.lock");
    writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), at: Date.now() }));
    await expect(withLock(path, () => Promise.resolve("ok"), { timeoutMs: 500 })).resolves.toBe("ok");
  });

  it("takes over an old lock even if it is empty", async () => {
    const path = join(tmpDir(), "x.lock");
    writeFileSync(path, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    await expect(withLock(path, () => Promise.resolve("ok"), { timeoutMs: 500, staleMs: 30_000 })).resolves.toBe("ok");
  });

  it("times out on a live lock", async () => {
    const path = join(tmpDir(), "x.lock");
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }));
    await expect(withLock(path, () => Promise.resolve(), { timeoutMs: 100 })).rejects.toBeInstanceOf(LockTimeoutError);
  });
});
