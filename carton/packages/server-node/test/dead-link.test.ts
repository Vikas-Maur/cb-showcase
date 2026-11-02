// A link that dies without closing (Wi-Fi gone, a NAT that forgot the flow): TCP keeps the socket "open" for many
// minutes, so the transport must notice from its keepalive going unanswered, close, and let the client reconnect.
// cf-lab measured the old behaviour on Cloudflare: through a 5-minute outage the client stayed "online".
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createServer, connect, type Socket } from "node:net";
import http from "node:http";
import { createHmacAuth } from "@carton/server";
import { startNodeHost, webSocketTransport, type NodeHost } from "../src/index.ts";
import { acceptWebSocket, type ServerWebSocket } from "../src/ws.ts";
import { scratch } from "./scratch.ts";

const auth = createHmacAuth({ secret: "test-only-secret-test-only-secret-0123" });
const closers: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of closers.reverse()) await c();
});

/**
 * A TCP proxy in front of the host whose link can go dead: while `dead`, bytes either way are dropped, nothing closes.
 * While `upDead`, only the client's bytes to the host are (a one-way failure).
 */
async function deadableLink(port: number) {
  const link = { dead: false, upDead: false, port: 0 };
  const socks: Socket[] = [];
  const server = createServer((c) => {
    const u = connect(port, "127.0.0.1");
    socks.push(c, u);
    c.on("data", (d) => void (link.dead || link.upDead || u.write(d)));
    u.on("data", (d) => void (link.dead || c.write(d)));
    c.on("error", () => u.destroy());
    u.on("error", () => c.destroy());
    c.on("close", () => u.destroy());
    u.on("close", () => c.destroy());
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  link.port = (server.address() as { port: number }).port;
  closers.push(() => new Promise<void>((ok) => (socks.forEach((s) => s.destroy()), server.close(() => ok()))));
  return link;
}

async function setup() {
  const h: NodeHost = await startNodeHost({ dataDir: join(scratch("dead-link"), "d"), auth, durability: "normal" });
  closers.push(() => h.close());
  const link = await deadableLink(Number(new URL(h.urlFor("p")).port));
  const url = h.urlFor("p").replace(/:\d+\//, `:${link.port}/`);
  const token = await auth.issue({ account: "o", credential: "o/dev", role: "owner", projectId: "p", ttlMs: 60_000 });
  return { link, url, token };
}
const closedWithin = (c: { onClose(f: (why: string) => void): void }, ms: number) =>
  new Promise<string | null>((ok) => {
    const t = setTimeout(() => ok(null), ms);
    c.onClose((why) => (clearTimeout(t), ok(why)));
  });

test("a live link with answered pings stays open", async () => {
  const { url, token } = await setup();
  const c = await webSocketTransport({ keepaliveMs: 100, deadAfterMs: 300 }).connect(url, { token });
  assert.equal(await closedWithin(c, 1200), null, "closed although the host answered every ping");
  assert.ok(c.open);
  c.close();
});

test("a dead link is closed once a keepalive goes unanswered", async () => {
  const { link, url, token } = await setup();
  const c = await webSocketTransport({ keepaliveMs: 150, deadAfterMs: 300 }).connect(url, { token });
  const t0 = Date.now();
  link.dead = true;
  const why = await closedWithin(c, 3000);
  assert.ok(why !== null, "the dead link was never noticed");
  assert.match(why, /dead/);
  assert.ok(Date.now() - t0 < 1000, `noticed after ${Date.now() - t0} ms; keepalive 150 + deadAfter 300`);
  assert.equal(c.open, false);
});

test("a send after silence checks the link at once, not at the next keepalive", async () => {
  const { link, url, token } = await setup();
  const c = await webSocketTransport({ keepaliveMs: 60_000, deadAfterMs: 300 }).connect(url, { token });
  link.dead = true;
  await new Promise((r) => setTimeout(r, 400)); // silent for longer than deadAfterMs
  const t0 = Date.now();
  c.send({ type: "hello", branchId: "b", have: 0, pending: [], rids: [], schemaVersion: 1 } as never);
  const why = await closedWithin(c, 2000);
  assert.ok(why !== null && /dead/.test(why), `a send on a dead link wasn't noticed: ${why}`);
  assert.ok(Date.now() - t0 < 1000);
});

test("deadAfterMs 0, or no keepalive, never closes a silent link on its own", async () => {
  const { link, url, token } = await setup();
  const a = await webSocketTransport({ keepaliveMs: 100, deadAfterMs: 0 }).connect(url, { token });
  const b = await webSocketTransport({ keepaliveMs: 0 }).connect(url, { token });
  link.dead = true;
  assert.equal(await closedWithin(a, 700), null);
  assert.equal(await closedWithin(b, 10), null);
  a.close();
  b.close();
});

/** A WebSocket that opens at once and keeps what the transport sends; the test plays the host. */
class FakeSocket {
  static last: FakeSocket;
  readonly protocol = "carton.v1";
  readonly sent: string[] = [];
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor() {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.({}));
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
  pings() {
    return this.sent.filter((d) => d === "ping").length;
  }
}
const fakeTransport = (o: { keepaliveMs: number; deadAfterMs: number }) => webSocketTransport({ ...o, WebSocket: FakeSocket as unknown as typeof WebSocket });
const hello = { type: "hello", branchId: "b", have: 0, pending: [], rids: [], schemaVersion: 1 } as never;

test("a burst of sends after a silence sends one ping, not one per send", async () => {
  const c = await fakeTransport({ keepaliveMs: 60_000, deadAfterMs: 200 }).connect("ws://h/api/projects/p/ws", { token: "t" });
  const ws = FakeSocket.last;
  await new Promise((r) => setTimeout(r, 250)); // silent for longer than deadAfterMs
  for (let i = 0; i < 20; i++) c.send(hello);
  assert.equal(ws.pings(), 1, `${ws.pings()} pings for one silence`);
  // answered: the next silence asks again, once
  ws.onmessage?.({ data: "pong" });
  await new Promise((r) => setTimeout(r, 250));
  for (let i = 0; i < 20; i++) c.send(hello);
  assert.equal(ws.pings(), 2);
  c.close();
});

/**
 * A host that answers `ping` with `pong` (as server-node and the Worker do) and sends every socket an application
 * message every 25 ms, as teammates' presence and changes arrive: the client hears from it all the time.
 */
async function chattyHost() {
  const socks = new Set<ServerWebSocket>();
  const server = http.createServer((_q, r) => void r.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head, { protocols: () => "carton.v1", idleTimeoutMs: 0 });
    if (!ws) return;
    socks.add(ws);
    ws.on("message", (d) => void (d === "ping" && ws.send("pong")));
    ws.on("close", () => socks.delete(ws));
  });
  let seq = 0;
  const tick = setInterval(() => {
    for (const ws of socks) ws.send(JSON.stringify({ type: "presence", branchId: "b", actor: { kind: "human", id: "teammate" }, state: { seq: seq++ } }));
  }, 25);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  closers.push(() => new Promise<void>((ok) => (clearInterval(tick), socks.forEach((s) => s.terminate()), server.closeAllConnections(), server.close(() => ok()))));
  const link = await deadableLink((server.address() as { port: number }).port);
  return { link, url: `ws://127.0.0.1:${link.port}/api/projects/p/ws` };
}
const counting = (c: { onMessage(f: () => void): void }) => {
  const n = { messages: 0 };
  c.onMessage(() => n.messages++);
  return n;
};

test("a link whose client-to-host direction died is closed, though the host's messages keep arriving", async () => {
  const { link, url } = await chattyHost();
  const c = await webSocketTransport({ keepaliveMs: 150, deadAfterMs: 300 }).connect(url, { token: "t" });
  const n = counting(c);
  assert.equal(await closedWithin(c, 700), null, "closed while the link worked both ways");
  const t0 = Date.now(), before = n.messages;
  link.upDead = true;
  const why = await closedWithin(c, 3000);
  assert.ok(why !== null, `never noticed: ${n.messages - before} messages arrived in the meantime`);
  assert.match(why, /dead/);
  assert.ok(n.messages - before >= 5, `only ${n.messages - before} messages arrived after the cut: not a one-way failure`);
  assert.ok(Date.now() - t0 < 1000, `noticed after ${Date.now() - t0} ms; keepalive 150 + deadAfter 300`);
});

test("a send on a link whose client-to-host direction died finds out at once, though the host's messages keep arriving", async () => {
  const { link, url } = await chattyHost();
  const c = await webSocketTransport({ keepaliveMs: 60_000, deadAfterMs: 300 }).connect(url, { token: "t" });
  const n = counting(c);
  link.upDead = true;
  await new Promise((r) => setTimeout(r, 400)); // no round trip for longer than deadAfterMs, messages arriving all along
  const t0 = Date.now(), before = n.messages;
  c.send(hello);
  const why = await closedWithin(c, 2000);
  assert.ok(why !== null && /dead/.test(why), `a send on a one-way dead link wasn't noticed: ${why}`);
  assert.ok(n.messages > before, "no message arrived after the send: not a one-way failure");
  assert.ok(Date.now() - t0 < 1000);
});
