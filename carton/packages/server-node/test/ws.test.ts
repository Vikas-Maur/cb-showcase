// Tests for the zero-dependency WebSocket server (src/ws.ts): interop with Node's own WebSocket
// client (undici, an independent implementation), protocol edge cases over raw TCP sockets, and the
// frame parser fed through an in-memory stream so every chunk boundary is exercised exactly.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { acceptWebSocket, rejectUpgrade, ServerWebSocket, WsError } from "../src/ws.ts";
import type { WsOptions } from "../src/ws.ts";
import { clientFrame, closePayload, OP, RawClient, rawExchange } from "./ws-raw.ts";
import type { ConnectOptions } from "./ws-raw.ts";

const TIMEOUT = 3000;

interface Accepted {
  ws: ServerWebSocket;
  /** Bytes that came with the upgrade request. */
  head: number;
  /** TCP reads the server socket has seen so far. */
  chunks: () => number;
}

interface ServerSetup {
  ws?: WsOptions;
  onAccept?: (ws: ServerWebSocket) => void;
  /** Runs before accepting; return false when it answered the request itself. */
  onUpgrade?: (req: IncomingMessage, socket: Duplex) => boolean;
}

interface TestServer {
  port: number;
  url: string;
  accepted: number;
  /** The next accepted connection, in accept order. */
  next(): Promise<Accepted>;
}

/** An http server on 127.0.0.1:0 that accepts WebSocket upgrades; closed with every socket after the test. */
async function startServer(t: TestContext, setup: ServerSetup = {}): Promise<TestServer> {
  const server = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const sockets = new Set<Duplex>();
  const ready: Accepted[] = [];
  const waiting: Array<(a: Accepted) => void> = [];
  const result: TestServer = {
    port: 0,
    url: "",
    accepted: 0,
    next() {
      const a = ready.shift();
      if (a) return Promise.resolve(a);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no connection was accepted")), TIMEOUT);
        waiting.push((accepted) => {
          clearTimeout(timer);
          resolve(accepted);
        });
      });
    },
  };
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let chunks = 0;
    socket.on("data", () => chunks++);
    if (setup.onUpgrade && !setup.onUpgrade(req, socket)) return;
    const ws = acceptWebSocket(req, socket, head, { idleTimeoutMs: 0, ...setup.ws });
    if (!ws) return;
    result.accepted++;
    setup.onAccept?.(ws);
    const accepted: Accepted = { ws, head: head.length, chunks: () => chunks };
    const waiter = waiting.shift();
    if (waiter) waiter(accepted);
    else ready.push(accepted);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  result.port = (server.address() as AddressInfo).port;
  result.url = `ws://127.0.0.1:${result.port}/`;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, "close");
  });
  return result;
}

const echo = (ws: ServerWebSocket): void => {
  ws.on("message", (data) => ws.send(data));
};

function waitEvent(target: EventTarget, name: string, ms = TIMEOUT): Promise<any[]> {
  return once(target, name, { signal: AbortSignal.timeout(ms) });
}

// Not events.once: it listens for "error" too, which would both reject on the server's informational
// errors and hide whether the server copes with nobody listening for them.
function serverClose(ws: ServerWebSocket, ms = TIMEOUT): Promise<[number, string, boolean]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the server socket did not close")), ms);
    ws.once("close", (code, reason, wasClean) => {
      clearTimeout(timer);
      resolve([code, reason, wasClean]);
    });
  });
}

async function openClient(t: TestContext, url: string, protocols?: string[]): Promise<WebSocket> {
  const client = new WebSocket(url, protocols);
  client.binaryType = "arraybuffer";
  t.after(() => {
    if (client.readyState === WebSocket.CONNECTING || client.readyState === WebSocket.OPEN) client.close();
  });
  await waitEvent(client, "open");
  return client;
}

function collect(client: WebSocket, count: number, ms = TIMEOUT): Promise<Array<string | ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const got: Array<string | ArrayBuffer> = [];
    const onMessage = (event: MessageEvent): void => {
      got.push(event.data);
      if (got.length < count) return;
      clearTimeout(timer);
      client.removeEventListener("message", onMessage);
      resolve(got);
    };
    const timer = setTimeout(() => {
      client.removeEventListener("message", onMessage);
      reject(new Error(`got ${got.length} of ${count} messages`));
    }, ms);
    client.addEventListener("message", onMessage);
  });
}

async function connectRaw(t: TestContext, port: number, opts?: ConnectOptions): Promise<RawClient> {
  const client = await RawClient.connect(port, opts);
  t.after(() => client.destroy());
  return client;
}

async function waitUntil(check: () => boolean, ms = TIMEOUT): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await delay(5);
  }
}

// ---- interop with Node's WebSocket client ----

test("handshake, text, binary and unicode round trips with Node's WebSocket client", async (t) => {
  const received: Array<string | Buffer> = [];
  const srv = await startServer(t, {
    onAccept: (ws) =>
      ws.on("message", (data) => {
        received.push(data);
        ws.send(data);
      }),
  });
  const client = await openClient(t, srv.url);
  const { ws } = await srv.next();
  assert.equal(ws.readyState, ServerWebSocket.OPEN);
  assert.equal(ws.protocol, "");
  assert.equal(client.protocol, "");

  client.send("hello");
  assert.deepEqual(await collect(client, 1), ["hello"]);
  assert.equal(received[0], "hello");

  client.send(new Uint8Array([0, 1, 2, 255]));
  const [binary] = await collect(client, 1);
  assert.ok(binary instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(binary), new Uint8Array([0, 1, 2, 255]));
  assert.ok(Buffer.isBuffer(received[1]));

  const unicode = "héllo wörld — 日本語 🎬🎞️ \u0000 end";
  client.send(unicode);
  assert.deepEqual(await collect(client, 1), [unicode]);
  assert.equal(received[2], unicode);
});

test("messages across the 7-, 16- and 64-bit length encodings, both ways", async (t) => {
  const received: Array<string | Buffer> = [];
  const srv = await startServer(t, {
    onAccept: (ws) =>
      ws.on("message", (data) => {
        received.push(data);
        ws.send(data);
      }),
  });
  const client = await openClient(t, srv.url);
  const pattern = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(6000); // 216,000 ASCII bytes
  for (const size of [125, 126, 65535, 65536, 200_000]) {
    const text = pattern.slice(0, size);
    client.send(text);
    const [echoed] = await collect(client, 1);
    assert.equal(typeof echoed, "string");
    assert.equal((echoed as string).length, size);
    assert.ok(echoed === text, `text of ${size} bytes came back changed`);

    const bytes = randomBytes(size);
    client.send(bytes);
    const [back] = await collect(client, 1);
    assert.ok(Buffer.from(back as ArrayBuffer).equals(bytes), `binary of ${size} bytes came back changed`);
  }
  assert.deepEqual(
    received.map((m) => (typeof m === "string" ? m.length : m.length)),
    [125, 125, 126, 126, 65535, 65535, 65536, 65536, 200_000, 200_000],
  );
});

test("subprotocol: the server picks one of the client's offers", async (t) => {
  let offered: string[] = [];
  const srv = await startServer(t, {
    ws: {
      protocols: (list) => {
        offered = list;
        return list.includes("carton.v1") ? "carton.v1" : null;
      },
    },
  });
  const client = await openClient(t, srv.url, ["carton.v1", "x"]);
  const { ws } = await srv.next();
  assert.deepEqual(offered, ["carton.v1", "x"]);
  assert.equal(client.protocol, "carton.v1");
  assert.equal(ws.protocol, "carton.v1");

  // A client that offers nothing gets nothing, and the picker isn't asked.
  offered = [];
  const plain = await openClient(t, srv.url);
  const second = await srv.next();
  assert.equal(plain.protocol, "");
  assert.equal(second.ws.protocol, "");
  assert.deepEqual(offered, []);
});

test("server-initiated close: the client sees the code and reason, both sides clean", async (t) => {
  const srv = await startServer(t);
  const client = await openClient(t, srv.url);
  const { ws } = await srv.next();
  const clientClosed = waitEvent(client, "close");
  const serverClosed = serverClose(ws);
  ws.close(4001, "kicked out");
  assert.equal(ws.readyState, ServerWebSocket.CLOSING);
  const [event] = await clientClosed;
  assert.equal(event.code, 4001);
  assert.equal(event.reason, "kicked out");
  assert.equal(event.wasClean, true);
  const [code, , wasClean] = await serverClosed;
  assert.equal(code, 4001); // the client echoes our code
  assert.equal(wasClean, true);
  assert.equal(ws.readyState, ServerWebSocket.CLOSED);
  ws.send("too late"); // dropped, not thrown
  ws.close(); // no-op once closed
});

test("client-initiated close is seen by the server as clean, with code and reason", async (t) => {
  const srv = await startServer(t);
  const client = await openClient(t, srv.url);
  const { ws } = await srv.next();
  const serverClosed = serverClose(ws);
  const clientClosed = waitEvent(client, "close");
  client.close(1000, "bye");
  assert.deepEqual(await serverClosed, [1000, "bye", true]);
  const [event] = await clientClosed;
  assert.equal(event.code, 1000);
  assert.equal(event.wasClean, true);
});

test("2,000 small messages arrive in order, both ways", async (t) => {
  const received: Array<string | Buffer> = [];
  const srv = await startServer(t, {
    onAccept: (ws) =>
      ws.on("message", (data) => {
        received.push(data);
        ws.send(data);
      }),
  });
  const client = await openClient(t, srv.url);
  const expected = Array.from({ length: 2000 }, (_, i) => `{"op":"presence","seq":${i}}`);
  const echoes = collect(client, expected.length, 10_000);
  for (const message of expected) client.send(message);
  assert.deepEqual(await echoes, expected);
  assert.deepEqual(received, expected);
});

test("terminate() drops the connection: abnormal close on both sides", async (t) => {
  const srv = await startServer(t);
  const client = await openClient(t, srv.url);
  const { ws } = await srv.next();
  const clientClosed = waitEvent(client, "close");
  const serverClosed = serverClose(ws);
  ws.terminate();
  const [event] = await clientClosed;
  assert.equal(event.code, 1006);
  assert.equal(event.wasClean, false);
  assert.deepEqual(await serverClosed, [1006, "", false]);
});

test("a client that answers pings stays connected past several idle timeouts", async (t) => {
  const srv = await startServer(t, { ws: { idleTimeoutMs: 100 } });
  const client = await openClient(t, srv.url);
  const { ws } = await srv.next();
  await delay(450);
  assert.equal(client.readyState, WebSocket.OPEN);
  assert.equal(ws.readyState, ServerWebSocket.OPEN);
});

// ---- raw TCP edge cases ----

test("frames split into 1-byte TCP writes are reassembled", async (t) => {
  const srv = await startServer(t, { onAccept: echo });
  const client = await connectRaw(t, srv.port);
  const accepted = await srv.next();

  await client.writeBytewise(clientFrame(OP.TEXT, "hello"));
  let frame = await client.nextFrame();
  assert.deepEqual([frame.opcode, frame.fin, frame.masked, frame.payload.toString()], [OP.TEXT, true, false, "hello"]);

  // 16-bit length: header byte by byte, then the payload in two pieces.
  const medium = randomBytes(300);
  const mediumFrame = clientFrame(OP.BINARY, medium);
  await client.writeBytewise(mediumFrame.subarray(0, 9));
  client.write(mediumFrame.subarray(9, 100));
  await delay(5);
  client.write(mediumFrame.subarray(100));
  frame = await client.nextFrame();
  assert.equal(frame.opcode, OP.BINARY);
  assert.ok(frame.payload.equals(medium));

  // 64-bit length: header byte by byte, then the payload in two pieces.
  const large = randomBytes(70_000);
  const largeFrame = clientFrame(OP.BINARY, large);
  await client.writeBytewise(largeFrame.subarray(0, 15));
  client.write(largeFrame.subarray(15, 30_000));
  await delay(5);
  client.write(largeFrame.subarray(30_000));
  frame = await client.nextFrame();
  assert.ok(frame.payload.equals(large));

  assert.ok(accepted.chunks() >= 20, `the server only saw ${accepted.chunks()} TCP reads`);
});

test("a fragmented message with an interleaved ping: pong first, then the whole message", async (t) => {
  const srv = await startServer(t, { onAccept: echo });
  const client = await connectRaw(t, srv.port);
  await srv.next();
  client.write(
    Buffer.concat([
      clientFrame(OP.TEXT, "Hel", { fin: false }),
      clientFrame(OP.PING, "p1"),
      clientFrame(OP.CONTINUATION, "lo ", { fin: false }),
      clientFrame(OP.CONTINUATION, "wörld"),
    ]),
  );
  const pong = await client.nextFrame();
  assert.deepEqual([pong.opcode, pong.payload.toString()], [OP.PONG, "p1"]);
  const message = await client.nextFrame();
  assert.deepEqual([message.opcode, message.payload.toString()], [OP.TEXT, "Hello wörld"]);

  // UTF-8 is checked on the whole message: a character split between fragments is fine.
  const e = Buffer.from("é");
  client.write(Buffer.concat([clientFrame(OP.TEXT, e.subarray(0, 1), { fin: false }), clientFrame(OP.CONTINUATION, e.subarray(1))]));
  const split = await client.nextFrame();
  assert.equal(split.payload.toString(), "é");
});

test("data that arrives with the upgrade request is parsed", async (t) => {
  const srv = await startServer(t, { onAccept: echo });
  const client = await connectRaw(t, srv.port, { extra: clientFrame(OP.TEXT, "early") });
  const accepted = await srv.next();
  assert.ok(accepted.head > 0, "the frame did not come as the upgrade's head");
  assert.equal(client.status, 101);
  const frame = await client.nextFrame();
  assert.equal(frame.payload.toString(), "early");
});

test("a message of exactly maxPayload bytes is accepted", async (t) => {
  const srv = await startServer(t, { ws: { maxPayload: 1024 }, onAccept: echo });
  const client = await connectRaw(t, srv.port);
  await srv.next();
  client.write(clientFrame(OP.BINARY, Buffer.alloc(1024, 7)));
  const frame = await client.nextFrame();
  assert.equal(frame.payload.length, 1024);
});

test("protocol violations fail the connection with the right close code", async (t) => {
  const invalidUtf8 = Buffer.from([0x68, 0xc3, 0x28]);
  const cases: Array<[string, Buffer, number]> = [
    ["unmasked client frame", clientFrame(OP.TEXT, "hi", { mask: false }), 1002],
    ["RSV1 set without an extension", clientFrame(OP.TEXT, "hi", { rsv: 4 }), 1002],
    ["reserved data opcode 0x3", clientFrame(0x3, "hi"), 1002],
    ["reserved control opcode 0xB", clientFrame(0xb, ""), 1002],
    ["ping over 125 bytes", clientFrame(OP.PING, Buffer.alloc(126)), 1002],
    ["fragmented ping", clientFrame(OP.PING, "x", { fin: false }), 1002],
    ["continuation without a message", clientFrame(OP.CONTINUATION, "x"), 1002],
    ["new message inside a fragmented one", Buffer.concat([clientFrame(OP.TEXT, "a", { fin: false }), clientFrame(OP.TEXT, "b")]), 1002],
    ["64-bit length with the top bit set", Buffer.from([0x82, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 1, 1, 2, 3, 4]), 1002],
    ["close frame with a 1-byte payload", clientFrame(OP.CLOSE, Buffer.from([3])), 1002],
    ...[0, 999, 1004, 1005, 1006, 1015, 1016, 2999, 5000, 65535].map(
      (code): [string, Buffer, number] => [`close code ${code}`, clientFrame(OP.CLOSE, closePayload(code)), 1002],
    ),
    ["invalid UTF-8 text", clientFrame(OP.TEXT, invalidUtf8), 1007],
    ["overlong UTF-8", clientFrame(OP.TEXT, Buffer.from([0xc0, 0xaf])), 1007],
    ["UTF-8-encoded surrogate", clientFrame(OP.TEXT, Buffer.from([0xed, 0xa0, 0x80])), 1007],
    ["invalid UTF-8 in a later fragment", Buffer.concat([clientFrame(OP.TEXT, "ok", { fin: false }), clientFrame(OP.CONTINUATION, invalidUtf8)]), 1007],
    ["invalid UTF-8 close reason", clientFrame(OP.CLOSE, Buffer.concat([closePayload(1000), Buffer.from([0xff])])), 1007],
    // Only the header and 100 bytes of a claimed 10 MB are ever sent: the server must refuse on the header.
    ["10 MB message (header only)", clientFrame(OP.BINARY, Buffer.alloc(100), { declaredLength: 10_000_000 }), 1009],
    ["fragments adding up past maxPayload", Buffer.concat([clientFrame(OP.TEXT, "a".repeat(600), { fin: false }), clientFrame(OP.CONTINUATION, "a".repeat(600))]), 1009],
  ];
  // No "error" listener on purpose: a misbehaving client must not crash the host.
  const srv = await startServer(t, { ws: { maxPayload: 1024 } });
  for (const [name, bytes, expected] of cases) {
    await t.test(name, async () => {
      const client = await RawClient.connect(srv.port);
      try {
        const { ws } = await srv.next();
        const closed = serverClose(ws);
        client.write(bytes);
        const { code } = await client.nextClose();
        assert.equal(code, expected);
        await client.waitClosed(); // the server ends TCP after failing
        assert.deepEqual(await closed, [1006, "", false]);
      } finally {
        client.destroy();
      }
    });
  }
});

test("valid close codes are echoed and the close is clean", async (t) => {
  const srv = await startServer(t);
  for (const code of [1000, 1001, 1003, 1007, 1011, 1014, 3000, 4999, 1005]) {
    await t.test(code === 1005 ? "empty close frame" : `close code ${code}`, async () => {
      const client = await RawClient.connect(srv.port);
      try {
        const { ws } = await srv.next();
        const closed = serverClose(ws);
        client.write(clientFrame(OP.CLOSE, code === 1005 ? "" : closePayload(code, "reason ✓")));
        const echoed = await client.nextClose();
        assert.equal(echoed.code, code);
        await client.waitClosed();
        assert.deepEqual(await closed, [code, code === 1005 ? "" : "reason ✓", true]);
      } finally {
        client.destroy();
      }
    });
  }
});

test("bad upgrade requests get an HTTP error and a closed socket", async (t) => {
  const srv = await startServer(t, {
    onUpgrade: (req, socket) => {
      if (req.url !== "/private") return true;
      rejectUpgrade(socket, 401, "token required");
      return false;
    },
  });
  const request = (headers: Record<string, string | null>, method = "GET", path = "/"): string => {
    const all: Record<string, string | null> = {
      Host: "127.0.0.1",
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
      ...headers,
    };
    let text = `${method} ${path} HTTP/1.1\r\n`;
    for (const [name, value] of Object.entries(all)) if (value !== null) text += `${name}: ${value}\r\n`;
    return text + "\r\n";
  };

  let response = await rawExchange(srv.port, request({ "Sec-WebSocket-Key": null }));
  assert.match(response, /^HTTP\/1\.1 400 /);
  response = await rawExchange(srv.port, request({ "Sec-WebSocket-Key": "c2hvcnQ=" })); // 5 bytes, not 16
  assert.match(response, /^HTTP\/1\.1 400 /);
  response = await rawExchange(srv.port, request({ "Sec-WebSocket-Version": "8" }));
  assert.match(response, /^HTTP\/1\.1 426 /);
  assert.match(response, /\r\nSec-WebSocket-Version: 13\r\n/);
  response = await rawExchange(srv.port, request({}, "POST"));
  assert.match(response, /^HTTP\/1\.1 400 /);
  response = await rawExchange(srv.port, request({}, "GET", "/private"));
  assert.match(response, /^HTTP\/1\.1 401 Unauthorized\r\n/);
  assert.match(response, /\r\n\r\ntoken required$/);
  assert.equal(srv.accepted, 0);

  // The RFC 6455 §1.3 sample key gives the sample accept value.
  const client = await connectRaw(t, srv.port, { headers: { "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
  assert.equal(client.status, 101);
  assert.equal(client.headers["sec-websocket-accept"], "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  assert.equal(client.headers["sec-websocket-extensions"], undefined);
});

test("permessage-deflate offers are ignored, not negotiated", async (t) => {
  const srv = await startServer(t, { onAccept: echo });
  const client = await connectRaw(t, srv.port, { headers: { "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits" } });
  assert.equal(client.status, 101);
  assert.equal(client.headers["sec-websocket-extensions"], undefined);
  client.write(clientFrame(OP.TEXT, "plain"));
  assert.equal((await client.nextFrame()).payload.toString(), "plain");
});

test("a client that never answers pings is cut off after about two idle timeouts", async (t) => {
  const srv = await startServer(t, { ws: { idleTimeoutMs: 100 } });
  // Lower bounds are loose: Windows timers tick at ~15.6 ms and libuv caches the loop time.
  const started = performance.now();
  const silent = await connectRaw(t, srv.port);
  const { ws } = await srv.next();
  const errors: Error[] = [];
  ws.on("error", (err) => errors.push(err));
  const closed = serverClose(ws);
  const ping = await silent.nextFrame();
  const pingAt = performance.now() - started;
  assert.equal(ping.opcode, OP.PING);
  await silent.waitClosed();
  const closedAt = performance.now() - started;
  assert.ok(pingAt >= 60 && pingAt < 1000, `ping after ${pingAt.toFixed(0)} ms`);
  assert.ok(closedAt >= 150 && closedAt < 2000, `cut off after ${closedAt.toFixed(0)} ms`);
  assert.deepEqual(await closed, [1006, "", false]);
  assert.ok(errors[0] instanceof WsError && errors[0].closeCode === 1006);

  // One that answers is pinged again and again and stays.
  const answering = await connectRaw(t, srv.port);
  const second = await srv.next();
  let pings = 0;
  const until = performance.now() + 450;
  for (;;) {
    const left = until - performance.now();
    if (left <= 0) break;
    const frame = await answering.nextFrame(left).catch(() => null);
    if (frame === null) break;
    assert.equal(frame.opcode, OP.PING);
    pings++;
    answering.write(clientFrame(OP.PONG, frame.payload));
  }
  assert.ok(pings >= 2, `only ${pings} pings`);
  assert.equal(second.ws.readyState, ServerWebSocket.OPEN);
});

test("a client that stops reading is terminated by maxBufferedBytes", async (t) => {
  const limit = 256 * 1024;
  const srv = await startServer(t, { ws: { maxBufferedBytes: limit } });
  const client = await connectRaw(t, srv.port);
  const { ws } = await srv.next();
  client.socket.pause();
  const errors: Error[] = [];
  ws.on("error", (err) => errors.push(err));
  const closed = serverClose(ws);
  const chunk = Buffer.alloc(64 * 1024, 1);
  let sends = 0;
  let peak = 0;
  // Synchronous on purpose: the paused client shares this thread, so nothing drains meanwhile but the kernel.
  while (ws.readyState === ServerWebSocket.OPEN && sends < 1024) {
    ws.send(chunk);
    sends++;
    peak = Math.max(peak, ws.bufferedAmount);
  }
  assert.notEqual(ws.readyState, ServerWebSocket.OPEN, `still open after ${sends} sends of 64 KiB`);
  assert.ok(peak > limit && peak <= limit + chunk.length + 14, `peak backlog ${peak}`);
  assert.deepEqual(await closed, [1006, "", false]);
  assert.ok(errors[0] instanceof WsError && errors[0].closeCode === 1008);
});

test("a peer that never answers our close frame is destroyed after closeTimeoutMs", async (t) => {
  const srv = await startServer(t, { ws: { closeTimeoutMs: 100 } });
  const client = await connectRaw(t, srv.port);
  const { ws } = await srv.next();
  const closed = serverClose(ws);
  const started = performance.now();
  ws.close(1001, "going away");
  assert.deepEqual(await client.nextClose(), { code: 1001, reason: "going away" });
  const [code, reason, wasClean] = await closed;
  const elapsed = performance.now() - started;
  assert.deepEqual([code, reason, wasClean], [1006, "", false]);
  assert.ok(elapsed >= 60 && elapsed < 2000, `destroyed after ${elapsed.toFixed(0)} ms`);
  await client.waitClosed();
});

test("an abrupt disconnect mid-frame emits exactly one close", async (t) => {
  // No "error" listener on purpose: the reset must not become an unhandled error.
  const srv = await startServer(t, { ws: { idleTimeoutMs: 1000 } });
  for (const how of ["end", "destroy", "reset"] as const) {
    const client = await RawClient.connect(srv.port);
    const { ws } = await srv.next();
    const closes: unknown[][] = [];
    ws.on("close", (...args) => closes.push(args));
    client.write(clientFrame(OP.TEXT, "partial message").subarray(0, 9));
    await delay(20);
    if (how === "end") client.socket.end();
    else if (how === "destroy") client.destroy();
    else client.socket.resetAndDestroy();
    await waitUntil(() => closes.length > 0);
    await delay(30);
    assert.deepEqual(closes, [[1006, "", false]], how);
    assert.equal(ws.readyState, ServerWebSocket.CLOSED);
    client.destroy();
  }
});

// ---- parser, fed through an in-memory stream ----

function memorySocket(): { socket: Duplex; written: Buffer[] } {
  const written: Buffer[] = [];
  const socket = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk);
      callback();
    },
  });
  return { socket, written };
}

test("the parser survives every chunk boundary", async () => {
  const build = (): { bytes: Buffer; expected: Array<string | Buffer> } => {
    const medium = randomBytes(300);
    const large = randomBytes(70_000);
    const tiny = randomBytes(2000);
    const frames = [
      clientFrame(OP.TEXT, "hello"),
      clientFrame(OP.TEXT, "﻿a leading BOM is content"),
      clientFrame(OP.BINARY, medium),
      clientFrame(OP.BINARY, large),
      clientFrame(OP.TEXT, "frag", { fin: false }),
      clientFrame(OP.PING, "in between"),
      clientFrame(OP.CONTINUATION, "mented ✓"),
      clientFrame(OP.TEXT, ""),
      clientFrame(OP.BINARY, ""),
      // 2,000 one-byte fragments: reassembled into one buffer, not kept as 2,000 slices.
      ...Array.from(tiny, (byte, i) => clientFrame(i === 0 ? OP.BINARY : OP.CONTINUATION, Buffer.of(byte), { fin: i === tiny.length - 1 })),
    ];
    return {
      bytes: Buffer.concat(frames),
      expected: ["hello", "﻿a leading BOM is content", medium, large, "fragmented ✓", "", Buffer.alloc(0), tiny],
    };
  };
  const chunkers: Array<[string, () => number]> = [
    ["1-byte chunks", () => 1],
    ["1-40 byte chunks", () => 1 + Math.floor(Math.random() * 40)],
    ["1-5000 byte chunks", () => 1 + Math.floor(Math.random() * 5000)],
  ];
  for (const [name, size] of chunkers) {
    const { bytes, expected } = build();
    const { socket, written } = memorySocket();
    const ws = new ServerWebSocket(socket, Buffer.alloc(0), "", { idleTimeoutMs: 0 });
    const got: Array<string | Buffer> = [];
    ws.on("message", (data) => got.push(data));
    for (let at = 0; at < bytes.length; ) {
      const n = Math.min(size(), bytes.length - at);
      socket.push(bytes.subarray(at, at + n));
      at += n;
    }
    await waitUntil(() => got.length >= expected.length);
    assert.deepEqual(got, expected, name);
    const pong = Buffer.concat(written);
    assert.ok(pong.equals(Buffer.concat([Buffer.of(0x8a, 10), Buffer.from("in between")])), `${name}: pong ${pong.toString("hex")}`);
    ws.terminate();
  }
});
