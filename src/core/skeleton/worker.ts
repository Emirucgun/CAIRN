// Parse worker: runs extractSkeleton off the main thread. Inherits the
// process-wide V8 flags (--liftoff-only) set by the entry point.
import { parentPort } from "node:worker_threads";
import { extractSkeleton } from "./extract.js";
import type { Lang } from "./loader.js";

export interface ParseRequest {
  id: number;
  lang: Lang;
  src: string;
}

if (!parentPort) throw new Error("worker.ts must run as a worker thread");
const port = parentPort;
port.on("message", (req: ParseRequest) => {
  extractSkeleton(req.lang, req.src).then(
    (result) => port.postMessage({ id: req.id, result }),
    (e: unknown) => port.postMessage({ id: req.id, error: (e as Error).message ?? String(e) }),
  );
});
