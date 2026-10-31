// @carton/http-node's fetch on Node: what the blob clients need of fetch, and the two failures it exists for. A body
// cut while its reader is paused rejects the read (CI #29: undici behind fetch crashed or hung). A streamed upload is
// held to its content-length and reports success only once the whole body went out (Stage F web-demo round 5: piping
// stored a prefix when a file grew while it was read).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { nodeFetch, platformFetch } from "../src/index.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uncaught: unknown[] = [];
process.on("uncaughtException", (e) => uncaught.push(e));
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const f = nodeFetch()!;
const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    pull(c) {
      const next = chunks.shift();
      if (next) c.enqueue(next);
      else c.close();
    },
  });

test("on Node the platform fetch is the node:http one", () => {
  assert.ok(f);
  assert.equal(platformFetch(), f);
});

test("requests and responses as fetch gives them: headers both ways, status, bodies, HEAD and 204 empty", async () => {
  const got: { method?: string; ct?: string; body?: string }[] = [];
  const origin = await serve((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      got.push({ method: req.method, ct: req.headers["content-type"], body });
      if (req.url === "/none") return res.writeHead(204).end();
      res.writeHead(201, [["content-type", "text/plain"], ["x-two", "a"], ["x-two", "b"]]).end(req.method === "HEAD" ? undefined : `hello ${body}`);
    });
  });
  const r = await f(`${origin}/x`, { method: "POST", body: "there", headers: { "x-one": "1" } });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("x-two"), "a, b");
  assert.equal(await r.text(), "hello there");
  assert.equal(got[0]!.ct, "text/plain;charset=UTF-8", "a string body is typed as fetch types it");
  const j = await f(`${origin}/x`, { method: "PUT", body: JSON.stringify({ a: 1 }), headers: { "content-type": "application/json" } });
  await j.text();
  assert.equal(got[1]!.ct, "application/json");
  assert.equal((await f(`${origin}/x`, { method: "HEAD" })).body, null);
  assert.equal((await f(`${origin}/none`)).body, null);
});

test("a body cut while nothing reads it rejects the read; nothing reaches the process (CI #29)", async () => {
  const origin = await serve((req, res) => {
    res.writeHead(200, { "content-length": String(128 << 10), connection: "close" });
    res.write(Buffer.alloc(64 << 10, 7), () => res.socket?.end());
  });
  uncaught.length = 0;
  const r = await f(`${origin}/clip`);
  await sleep(300);
  const reader = r.body!.getReader();
  const outcome = await Promise.race([
    (async () => {
      for (;;) if ((await reader.read()).done) return "ended";
    })().catch(() => "rejected"),
    sleep(5000).then(() => "never settled"),
  ]);
  assert.equal(outcome, "rejected");
  await sleep(50);
  assert.deepEqual(uncaught, []);
});

test("a streamed upload is held to its content-length: longer or shorter fails, and nothing reports success before the body is out", async () => {
  const received: number[] = [];
  const origin = await serve((req, res) => {
    let n = 0;
    req.on("data", (d: Buffer) => (n += d.length));
    req.on("end", () => {
      received.push(n);
      res.writeHead(200).end("ok");
    });
    req.on("error", () => received.push(-1));
  });
  const put = (chunks: number[], length: number) =>
    f(`${origin}/obj`, { method: "PUT", body: streamOf(chunks.map((n) => new Uint8Array(n))), headers: { "content-length": String(length) }, duplex: "half" });
  const ok = await put([4, 4], 8);
  assert.equal(ok.status, 200);
  await ok.text();
  await assert.rejects(put([4, 4, 4], 8), /longer than its content-length/, "a source that grew past its declared size");
  await assert.rejects(put([4], 8), /not its content-length/, "a source that ended short");
  await sleep(100);
  assert.equal(received[0], 8);
  assert.ok(!received.slice(1).includes(8), "the server never saw a whole object from a mismatched upload");
});
