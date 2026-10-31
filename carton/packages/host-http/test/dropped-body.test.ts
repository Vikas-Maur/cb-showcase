// CI #29 through the host's media API: a download whose connection ends while the reader has paused the body. Through
// the global fetch, Node's built-in undici could crash the process (an uncaught `assert(!this.paused)`) or leave the
// read hanging; hostMediaBlobs on Node goes through @carton/http-node (node:http), so the read rejects.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { hostMediaBlobs } from "../src/client.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uncaught: unknown[] = [];
process.on("uncaughtException", (e) => uncaught.push(e));

/** A host whose signed GETs promise twice `sent` bytes on a `Connection: close` response, send `sent`, then end. */
async function cuttingHost(sent: number) {
  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (req.method === "POST" && req.url?.endsWith("/blobs/sign")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ url: `${origin}/blob/p/m/clip?exp=1&sig=x` }));
    }
    res.writeHead(200, { "content-length": String(sent * 2), "content-type": "video/mp4", connection: "close" });
    res.write(Buffer.alloc(sent, 7), () => res.socket?.end());
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return hostMediaBlobs({ origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, projectId: "p", token: "t" });
}

test("a media download cut while nothing reads it rejects the read; nothing reaches the process (CI #29)", async () => {
  for (const sent of [64 << 10, 1 << 20]) {
    uncaught.length = 0;
    const media = await cuttingHost(sent);
    const body = (await media.getStream("m/clip"))!;
    await sleep(300); // nothing reads: the body is paused when the connection ends
    const reader = body.getReader();
    const outcome = await Promise.race([
      (async () => {
        for (;;) if ((await reader.read()).done) return "ended";
      })().catch(() => "rejected"),
      sleep(5000).then(() => "never settled"),
    ]);
    assert.equal(outcome, "rejected", `${sent} bytes of ${sent * 2}`);
    await sleep(50);
    assert.deepEqual(uncaught, [], "an error escaped to the process");
  }
});
