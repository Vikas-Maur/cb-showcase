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

// Round 1 review (stage "CI #29 follow-ups"), finding 1: a 205 got a stream body, which Response refuses for it: the
// throw escaped the response callback (an uncaught exception) and the fetch never settled.
test("205 (and 204, 304) come back with no body; nothing escapes to the process", async () => {
  uncaught.length = 0;
  const origin = await serve((req, res) => {
    res.writeHead(Number(req.url!.slice(1)));
    res.end();
  });
  for (const status of [205, 204, 304]) {
    const r = await f(`${origin}/${status}`);
    assert.equal(r.status, status);
    assert.equal(r.body, null);
  }
  await sleep(20);
  assert.deepEqual(uncaught, []);
});

// Finding 2: redirects were handed back, where the global fetch follows them (hostMediaBlobs.head on a 307 failed).
test("redirects are followed as fetch follows them: methods, bodies, Authorization across origins, modes, a limit", async () => {
  const seen: { path: string; method: string; auth?: string; body: string }[] = [];
  let other = "";
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/307now") {
      // answers before the body is in, as a server redirecting an upload does
      res.writeHead(307, { location: "/here" });
      return res.end();
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const path = req.url!;
      seen.push({ path, method: req.method!, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body });
      const to = (status: number, where: string) => {
        res.writeHead(status, { location: where });
        res.end("moved");
      };
      if (path === "/307") return to(307, "/here");
      if (path === "/303") return to(303, "/here");
      if (path === "/302") return to(302, "/here");
      if (path === "/away") return to(302, `${other}/here`);
      if (path.startsWith("/loop")) return to(302, `/loop${Number(path.slice(5) || 0) + 1}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`at ${path}`);
    });
  };
  const origin = await serve(handler);
  other = await serve(handler);
  const auth = { authorization: "Bearer secret" };
  const at = async (r: Response) => [r.status, await r.text()];
  assert.deepEqual(await at(await f(`${origin}/307`, { headers: auth })), [200, "at /here"]);
  assert.equal(seen.at(-1)!.auth, "Bearer secret", "same origin: Authorization kept");
  seen.length = 0;
  assert.deepEqual(await at(await f(`${origin}/away`, { headers: auth })), [200, "at /here"]);
  assert.deepEqual(seen.map((s) => s.auth), ["Bearer secret", undefined], "another origin: Authorization dropped");
  seen.length = 0;
  await f(`${origin}/307`, { method: "PUT", body: new TextEncoder().encode("bytes") });
  assert.deepEqual(seen.map((s) => [s.method, s.body]), [["PUT", "bytes"], ["PUT", "bytes"]], "307 keeps the method and the body");
  seen.length = 0;
  await f(`${origin}/303`, { method: "PUT", body: new TextEncoder().encode("bytes"), headers: { "content-type": "text/plain" } });
  assert.deepEqual(seen.map((s) => [s.method, s.body]), [["PUT", "bytes"], ["GET", ""]], "303 goes on as a GET");
  seen.length = 0;
  await f(`${origin}/302`, { method: "POST", body: new TextEncoder().encode("bytes") });
  assert.deepEqual(seen.map((s) => s.method), ["POST", "GET"], "302 after a POST goes on as a GET");
  const manual = await f(`${origin}/307`, { redirect: "manual" });
  assert.deepEqual([manual.status, manual.headers.get("location")], [307, "/here"]);
  await manual.body?.cancel();
  await assert.rejects(f(`${origin}/307`, { redirect: "error" }), TypeError);
  await assert.rejects(f(`${origin}/loop`), /too many redirects/);
  // a streamed body can't be sent twice: a 307 after one is an error, and the source is cancelled
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(1024)), cancel: () => void (cancelled = true) });
  await assert.rejects(f(`${origin}/307now`, { method: "PUT", body: source, duplex: "half" }), /streamed body/);
  await sleep(50);
  assert.ok(cancelled, "the source was cancelled");
});

// Round 2: credentials beyond Authorization followed a redirect to another origin; a streamed POST was rewritten to
// a GET at a 301/302 where fetch refuses it; a Location with credentials was followed; "error" let a bare 3xx through.
test("redirects as fetch, further: what leaves the origin, streamed POSTs at 301/302, credentials in a Location, a bare 3xx", async () => {
  const seen: { path: string; method: string; headers: IncomingMessage["headers"] }[] = [];
  let other = "";
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const path = req.url!;
      seen.push({ path, method: req.method!, headers: req.headers });
      const to = (status: number, where?: string) => {
        res.writeHead(status, where ? { location: where } : {});
        res.end();
      };
      if (path === "/away") return to(307, `${other}/here`);
      if (path === "/301" || path === "/302") return to(Number(path.slice(1)), "/here");
      if (path === "/creds") return to(302, `${other.replace("://", "://user:pw@")}/here`);
      if (path === "/bare") return to(302);
      res.writeHead(200);
      res.end(`at ${path}`);
    });
  };
  const origin = await serve(handler);
  other = await serve(handler);
  const sent = { authorization: "Bearer a", "proxy-authorization": "Basic b", cookie: "c=1", host: new URL(origin).host, "x-kept": "k" };
  await (await f(`${origin}/away`, { headers: sent })).text();
  const [first, second] = seen.splice(0);
  assert.deepEqual([first!.headers.authorization, first!.headers["proxy-authorization"], first!.headers.cookie], ["Bearer a", "Basic b", "c=1"]);
  assert.deepEqual([second!.headers.authorization, second!.headers["proxy-authorization"], second!.headers.cookie, second!.headers.host, second!.headers["x-kept"]], [undefined, undefined, undefined, new URL(other).host, "k"], "another origin: none of them, and its own Host");
  for (const status of [301, 302]) {
    await assert.rejects(f(`${origin}/${status}`, { method: "POST", body: streamOf([new Uint8Array([1, 2])]), duplex: "half" }), /streamed body/, `${status}`);
    assert.deepEqual(seen.splice(0).map((s) => s.path), [`/${status}`], `nothing followed the ${status}`);
  }
  await assert.rejects(f(`${origin}/creds`), /credentials/);
  assert.deepEqual(seen.splice(0).map((s) => s.path), ["/creds"]);
  await assert.rejects(f(`${origin}/bare`, { redirect: "error" }), TypeError);
  assert.equal((await f(`${origin}/bare`)).status, 302, "when following, a 3xx with no Location is the answer");
});

// Finding 3: a request that failed left its upload waiting on the source, whose cancel never ran.
test("a request that fails while its upload waits on the source cancels the source", async () => {
  const origin = await serve((req) => {
    req.once("data", () => setTimeout(() => req.socket.destroy(), 20)); // the server drops it after the first bytes
  });
  let cancelled: unknown = null;
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(100)); // then nothing more: the upload waits for a read that never comes
    },
    cancel(why) {
      cancelled = why ?? true;
    },
  });
  await assert.rejects(f(origin, { method: "PUT", body: source, duplex: "half", headers: { "content-length": "1000" } }));
  await sleep(50);
  assert.ok(cancelled, "the source's cancel ran");
});
