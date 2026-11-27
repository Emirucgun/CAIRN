// Parse worker: parses, builds and stores skeleton cache entries off the main
// thread. Inherits the process-wide V8 flags (--liftoff-only) set by the
// entry point. Cache writes are atomic and content-addressed, so workers can
// write concurrently.
import { parentPort } from "node:worker_threads";
import { Cache } from "../cache.js";
import { buildAndStore, type FileRef } from "./index.js";
import type { Lang } from "./loader.js";

export interface BuildRequest {
  id: number;
  cacheDir: string;
  file: FileRef;
  lang: Lang;
  src: string;
  created: string;
}

if (!parentPort) throw new Error("worker.ts must run as a worker thread");
const port = parentPort;
const caches = new Map<string, Cache>();
port.on("message", (req: BuildRequest) => {
  let cache = caches.get(req.cacheDir);
  if (!cache) {
    cache = new Cache(req.cacheDir);
    caches.set(req.cacheDir, cache);
  }
  buildAndStore(cache, req.file, req.lang, req.src, req.created).then(
    (entry) => port.postMessage({ id: req.id, entry }),
    (e: unknown) => port.postMessage({ id: req.id, error: (e as Error).message ?? String(e) }),
  );
});
