// A small pool of parse workers for large runs (a cold `cairn map` of 10k
// files). Each worker parses, builds and writes the cache entry, so the main
// thread only reads blobs and dispatches. Started lazily on first use.
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { CacheEntry } from "../types.js";
import type { FileRef } from "./index.js";
import type { Lang } from "./loader.js";
import type { BuildRequest } from "./worker.js";

type Reply = { id: number; entry: CacheEntry } | { id: number; error: string };

interface Slot {
  worker: Worker;
  busy: number;
}

export class ParsePool {
  private slots: Slot[] | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (r: CacheEntry) => void; reject: (e: Error) => void; slot: Slot }>();

  constructor(readonly size = Math.max(1, Math.min(4, availableParallelism()))) {}

  /** Parses, builds and writes the cache entry in a worker; resolves with the entry. */
  build(cacheDir: string, file: FileRef, lang: Lang, src: string, created: string): Promise<CacheEntry> {
    const slots = this.start();
    const slot = slots.reduce((a, b) => (b.busy < a.busy ? b : a));
    const id = this.nextId++;
    slot.busy++;
    return new Promise<CacheEntry>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, slot });
      slot.worker.postMessage({ id, cacheDir, file, lang, src, created } satisfies BuildRequest);
    });
  }

  async close(): Promise<void> {
    const slots = this.slots;
    this.slots = null;
    if (slots) await Promise.all(slots.map((s) => s.worker.terminate()));
  }

  private start(): Slot[] {
    if (this.slots) return this.slots;
    // Under vitest/tsx this module is .ts and so is the worker; tsx loads it.
    const fromSource = import.meta.url.endsWith(".ts");
    const url = new URL(fromSource ? "./worker.ts" : "./worker.js", import.meta.url);
    this.slots = Array.from({ length: this.size }, () => {
      const worker = new Worker(url, fromSource ? { execArgv: ["--import", "tsx"] } : {});
      const slot: Slot = { worker, busy: 0 };
      worker.on("message", (reply: Reply) => {
        const p = this.pending.get(reply.id);
        if (!p) return;
        this.pending.delete(reply.id);
        p.slot.busy--;
        if ("error" in reply) p.reject(new Error(reply.error));
        else p.resolve(reply.entry);
      });
      worker.on("error", (e) => this.failSlot(slot, e));
      worker.on("exit", (code) => {
        if (this.slots) this.failSlot(slot, new Error(`parse worker exited (${code})`));
      });
      return slot;
    });
    return this.slots;
  }

  private failSlot(slot: Slot, e: Error): void {
    for (const [id, p] of this.pending) {
      if (p.slot !== slot) continue;
      this.pending.delete(id);
      p.reject(e);
    }
  }
}
