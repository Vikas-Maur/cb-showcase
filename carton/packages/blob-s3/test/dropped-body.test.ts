// CI #29: a server that ends the connection while the reader has paused the body. Through the global fetch, Node's
// built-in undici meets a paused parser in its socket end handler: in CI it threw an uncaught
// `AssertionError: assert(!this.paused)` (Parser.finish ← onHttpSocketEnd) and crashed the process, and here
// (Node 24.21 and 24.22.1) the read never settles. blob-s3 on Node goes through node:http, so the read rejects and
// nothing escapes to the process.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createS3BlobStore } from "../src/index.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An S3 stand-in whose every GET promises twice `sent` bytes on a `Connection: close` response, sends `sent`, then
 * ends the connection (`end`, a FIN, as in CI #29) or resets it (`destroy`).
 */
async function droppingServer(sent: number, how: "end" | "destroy" = "end") {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-length": String(sent * 2), "content-type": "application/octet-stream", etag: '"e"', "last-modified": new Date().toUTCString(), connection: "close" });
    res.write(Buffer.alloc(sent, 7), () => (how === "end" ? res.socket?.end() : res.socket?.destroy()));
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return createS3BlobStore({ endpoint: `http://127.0.0.1:${port}`, bucket: "b", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s" });
}

const uncaught: unknown[] = [];
process.on("uncaughtException", (e) => uncaught.push(e));
/** The outcome of reading `body` to its end, or "never settled" after `ms`. */
async function readAll(body: ReadableStream<Uint8Array>, ms = 5000): Promise<string> {
  const reader = body.getReader();
  const read = (async () => {
    for (;;) if ((await reader.read()).done) return "ended";
  })().then(
    (v) => v,
    () => "rejected",
  );
  return Promise.race([read, sleep(ms).then(() => "never settled")]);
}

test("a body cut while nothing reads it (the FIN arrives with the reader paused) rejects the read; nothing reaches the process (CI #29)", async () => {
  for (const sent of [64 << 10, 1 << 20]) {
    uncaught.length = 0;
    const store = await droppingServer(sent);
    const body = await store.getStream("clip.mp4");
    await sleep(300); // nothing reads: the body is paused when the connection ends
    assert.equal(await readAll(body!), "rejected", `${sent} bytes of ${sent * 2}`);
    await sleep(50);
    assert.deepEqual(uncaught, [], "an error escaped to the process");
  }
});

test("a whole-object read over a reset connection rejects too", async () => {
  uncaught.length = 0;
  const store = await droppingServer(1 << 20, "destroy");
  await assert.rejects(store.get("clip.mp4"));
  await sleep(50);
  assert.deepEqual(uncaught, []);
});
