// A local HTTP server that plays an LLM API in tests: no network, no keys.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export type Reply = { status: number; body: unknown; headers?: Record<string, string> };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Serves `replies` in order (the last one repeats) and records every request. */
export async function mockServer(...replies: Reply[]): Promise<{ url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  let i = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const reply = replies[Math.min(i++, replies.length - 1)] as Reply;
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}
