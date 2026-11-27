import { renameSync } from "node:fs";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * renameSync that retries briefly on Windows, where replacing a file fails
 * while another process (a parallel cairn, an editor, antivirus) has it open.
 */
export function renameWithRetry(from: string, to: string, attempts = 10): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !RETRYABLE.has(code) || i >= attempts) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (i + 1));
    }
  }
}
