// The Node host's own lifecycle rules: a room closes only once its sequencer work has drained; an expired
// subscriber gets nothing more; messages up to the 32 MiB protocol cap get through; hello checks schemaVersion.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { BlobStore } from "@carton/core/plugins";
import type { sync } from "@carton/core";
import { createHmacAuth } from "@carton/server";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { startNodeHost, webSocketTransport, type NodeHost } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const SECRET = "test-only-secret-test-only-secret-0123";
const auth = createHmacAuth({ secret: SECRET });
const hosts: NodeHost[] = [];
after(async () => {
  for (const h of hosts) await h.close();
});
const tokenFor = (account: string, projectId: string, ttlMs = 60_000) => auth.issue({ account, credential: `${account}/dev`, role: "owner", projectId, ttlMs });
const rec = (id: string) => ({ id, name: "main", forkOf: null, owner: "o", kind: "main", sequencer: { kind: "server", since: 0 } });
const adoptMsg = (branchId: string, doc0: unknown) => ({ type: "adopt", branchId, n: 0, stateHash: "", rows: [], rec: rec(branchId), doc0, closure: [] }) as unknown as sync.ClientMessage;
const until = async (cond: () => boolean, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("a room whose last socket left closes only after its sequencer work has drained", async () => {
  // a blob store whose puts wait for a gate: the adoption's keyframe write blocks
  const inner = createMemoryBlobStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let blocked = 0;
  const slow: BlobStore = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
    kind: "slow",
    put: async (...a: Parameters<BlobStore["put"]>) => {
      blocked++;
      await gate;
      return inner.put(...a);
    },
  });
  for (const k of ["get", "head", "delete", "list", "createMultipart", "resumeMultipart", "getStream"] as const) (slow as unknown as Record<string, unknown>)[k] = (inner as unknown as Record<string, (...x: unknown[]) => unknown>)[k]!.bind(inner);
  const h = await startNodeHost({ dataDir: join(scratch("drain"), "d"), auth, secret: SECRET, blobs: slow, idleCloseMs: 20, durability: "normal" });
  hosts.push(h);
  const c = await webSocketTransport({ keepaliveMs: 0 }).connect(h.urlFor("p"), { token: await tokenFor("o", "p") });
  c.send(adoptMsg("b1", { tracks: [{ id: "V1" }], timelineItems: [] }));
  await until(() => blocked > 0, "the keyframe write started");
  c.close();
  await new Promise((r) => setTimeout(r, 200)); // ten idle periods
  assert.ok(h.room("p"), "the room closed with work in flight");
  release();
  await until(() => h.room("p") === undefined, "the room closes once drained");
  // and the work it finished is there when the project opens again
  const d = await webSocketTransport({ keepaliveMs: 0 }).connect(h.urlFor("p"), { token: await tokenFor("o", "p") });
  const got = new Promise<sync.ServerMessage>((ok) => d.onMessage(ok));
  d.send({ type: "branchStatus", branchId: "b1" } as sync.ClientMessage);
  assert.equal(((await got) as sync.StatusMsg).adopted, true);
  d.close();
});

test("host close waits for sequencer work still writing, however long, before it closes storage", async () => {
  const inner = createMemoryBlobStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let blocked = 0;
  const slow = new Proxy(inner, {
    get(t, prop) {
      if (prop === "put")
        return async (...a: Parameters<BlobStore["put"]>) => {
          blocked++;
          await gate;
          return t.put(...a);
        };
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as BlobStore;
  const dataDir = join(scratch("close-drain"), "d");
  const h = await startNodeHost({ dataDir, auth, secret: SECRET, blobs: slow, durability: "normal" });
  const c = await webSocketTransport({ keepaliveMs: 0 }).connect(h.urlFor("p"), { token: await tokenFor("o", "p") });
  c.send(adoptMsg("b1", { tracks: [{ id: "V1" }], timelineItems: [] }));
  await until(() => blocked > 0, "the keyframe write started");
  let closed = false;
  const closing = h.close().then(() => (closed = true));
  // past the 10 s an earlier version waited before closing the database anyway
  await new Promise((r) => setTimeout(r, 10_500));
  assert.equal(closed, false, "close resolved while the sequencer was still writing");
  release();
  await closing;
  // the held write finished on its own database: a host restarted on the same data has the adopted cut
  const again = await startNodeHost({ dataDir, auth, secret: SECRET, blobs: slow, durability: "normal" });
  hosts.push(again);
  const d = await webSocketTransport({ keepaliveMs: 0 }).connect(again.urlFor("p"), { token: await tokenFor("o", "p") });
  const got = new Promise<sync.ServerMessage>((ok) => d.onMessage(ok));
  d.send({ type: "branchStatus", branchId: "b1" } as sync.ClientMessage);
  assert.equal(((await got) as sync.StatusMsg).adopted, true);
  d.close();
});

test("an expired subscriber gets nothing more and is closed with 4001, even while silent", async () => {
  const h = await startNodeHost({ dataDir: join(scratch("expiry"), "d"), auth, secret: SECRET, durability: "normal" });
  hosts.push(h);
  const t = webSocketTransport({ keepaliveMs: 0 });
  const writer = await t.connect(h.urlFor("q"), { token: await tokenFor("w", "q") });
  const adopted = new Promise((ok) => writer.onMessage((m) => m.type === "adopted" && ok(m)));
  writer.send(adoptMsg("b", { tracks: [{ id: "V1" }], timelineItems: [{ id: "c0", trackId: "V1", startTime: 0, endTime: 5, trimStart: 0, trimEnd: 5 }] }));
  await adopted;
  const shortLived = await t.connect(h.urlFor("q"), { token: await tokenFor("s", "q", 1500) });
  const seen: string[] = [];
  let closed = "";
  shortLived.onMessage((m) => seen.push(m.type));
  shortLived.onClose((why) => (closed = why));
  shortLived.send({ type: "hello", branchId: "b", have: 0, pending: [], rids: [], schemaVersion: 1 } as sync.ClientMessage);
  await until(() => seen.includes("hello"), "welcome");
  await new Promise((r) => setTimeout(r, 2600)); // past the 1.5 s token (whole seconds) and its expiry
  writer.send({ type: "hello", branchId: "b", have: 0, pending: [], rids: [], schemaVersion: 1 } as sync.ClientMessage);
  writer.send({ type: "push", branchId: "b", epoch: 1, changes: [{ id: "wrid.1", hash: "0".repeat(64), author: { kind: "human", id: "w" }, branchId: "b", base: { seq: 0, pending: [] }, ops: [{ op: "set", path: ["timelineItems", "c0", "name"], value: "x" }], intent: null, kinds: null, policy: "merge", at: 0, paths: ["timelineItems/c0/name"], reads: ["timelineItems/c0"], spans: [], trackOrder: [] }] } as unknown as sync.ClientMessage);
  await until(() => closed !== "", "the expired subscriber was closed");
  assert.match(closed, /4001/);
  assert.ok(!seen.includes("changes"), "an expired subscriber still received a row");
  writer.close();
});

test("a message of several MiB (a large adoption) gets through; a newer schemaVersion is refused at hello", async () => {
  const h = await startNodeHost({ dataDir: join(scratch("big"), "d"), auth, secret: SECRET, durability: "normal" });
  hosts.push(h);
  const c = await webSocketTransport({ keepaliveMs: 0 }).connect(h.urlFor("r"), { token: await tokenFor("o", "r") });
  const replies: sync.ServerMessage[] = [];
  c.onMessage((m) => replies.push(m));
  const items = Array.from({ length: 12_000 }, (_, i) => ({ id: `c${i}`, trackId: "V1", startTime: i * 10, endTime: i * 10 + 5, trimStart: 0, trimEnd: 5, name: `clip number ${i} with a longish name`, opacity: 1, notes: "n".repeat(100) }));
  const msg = adoptMsg("big", { tracks: [{ id: "V1" }], timelineItems: items });
  assert.ok(JSON.stringify(msg).length > 2 << 20, "the adoption is over 2 MiB");
  c.send(msg);
  await until(() => replies.some((m) => m.type === "adopted" || m.type === "adoptError"), "adopted", 30_000);
  assert.ok(replies.some((m) => m.type === "adopted"), JSON.stringify(replies).slice(0, 200));
  c.send({ type: "hello", branchId: "big", have: 0, pending: [], rids: [], schemaVersion: 99 } as sync.ClientMessage);
  await until(() => replies.length >= 2, "the hello answer");
  const answer = replies[replies.length - 1]!;
  assert.notEqual(answer.type, "hello", "a hello from a newer schema version was welcomed");
  c.close();
});

test("expired envelope blobs are swept by the host, room open or not, even when no socket ever came", async () => {
  const blobs = createMemoryBlobStore();
  const h = await startNodeHost({ dataDir: join(scratch("sweep"), "d"), auth, secret: SECRET, blobs, idleCloseMs: 20, durability: "normal" });
  hosts.push(h);
  const token = await tokenFor("w", "s");
  const sha = (b: Uint8Array) => crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>).then((d) => [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""));
  const body = new TextEncoder().encode('{"type":"push"}');
  const hour = Math.floor(Date.now() / 3600_000);
  const oldKey = `messages/c/${hour - 30}/${await sha(body)}-00000001`, youngKey = `messages/c/${hour}/${await sha(body)}-00000002`;
  // the young one through the upload route (which registers the project), the old one as left from 30 hours ago
  const r = await fetch(`${h.httpUrl}/api/projects/s/messages/${youngKey}`, { method: "PUT", body, headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  await blobs.put(`projects/s/seq/${oldKey}`, body);
  await until(() => h.room("s") === undefined, "the room the upload opened idled out");
  assert.equal(await h.sweepEnvelopes(), 1);
  assert.equal(await blobs.head(`projects/s/seq/${oldKey}`), null, "the expired envelope is gone");
  assert.ok(await blobs.head(`projects/s/seq/${youngKey}`), "the young one stays");
});

test("an upload still writing when the host closes opens no room afterwards; close waits for it", async () => {
  const inner = createMemoryBlobStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let blocked = 0;
  const slow = new Proxy(inner, {
    get(t, prop) {
      if (prop === "put")
        return async (...a: Parameters<BlobStore["put"]>) => {
          blocked++;
          await gate;
          return t.put(...a);
        };
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as BlobStore;
  const h = await startNodeHost({ dataDir: join(scratch("close-upload"), "d"), auth, secret: SECRET, blobs: slow, durability: "normal" });
  const token = await tokenFor("w", "u");
  const body = new TextEncoder().encode('{"type":"push"}');
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const key = `messages/c/${Math.floor(Date.now() / 3600_000)}/${sha}-00000003`;
  const upload = fetch(`${h.httpUrl}/api/projects/u/messages/${key}`, { method: "PUT", body, headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  await until(() => blocked > 0, "the upload's write started");
  let closed = false;
  const closing = h.close().then(() => (closed = true));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(closed, false, "close resolved with an upload still writing");
  release();
  await closing;
  await upload;
  assert.equal(h.room("u"), undefined, "a room opened after close");
});

test("a project id too long for a readable room file name is still swept", async () => {
  const blobs = createMemoryBlobStore();
  const dataDir = join(scratch("sweep-long"), "d");
  const h = await startNodeHost({ dataDir, auth, secret: SECRET, blobs, idleCloseMs: 20, durability: "normal" });
  hosts.push(h);
  const p = "P".repeat(128); // every capital escaped: its room file name has to be hashed
  const token = await tokenFor("w", p);
  const body = new TextEncoder().encode('{"type":"push"}');
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const hour = Math.floor(Date.now() / 3600_000);
  const r = await fetch(`${h.httpUrl}/api/projects/${p}/messages/messages/c/${hour}/${sha}-00000004`, { method: "PUT", body, headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const oldKey = `projects/${p}/seq/messages/c/${hour - 30}/${sha}-00000005`;
  await blobs.put(oldKey, body);
  assert.equal(await h.sweepEnvelopes(), 1);
  assert.equal(await blobs.head(oldKey), null);
});

test("an upgrade still being authenticated when the host closes is refused, with no error and no room", async () => {
  let atVerify!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => (atVerify = r));
  const gate = new Promise<void>((r) => (release = r));
  const slowAuth = new Proxy(auth, {
    get(t, prop) {
      if (prop === "check" || prop === "verify") {
        const f = Reflect.get(t, prop) as (...a: unknown[]) => Promise<unknown>;
        return async (...a: unknown[]) => {
          atVerify();
          await gate;
          return f.apply(t, a);
        };
      }
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  const errors: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const h = await startNodeHost({ dataDir: join(scratch("close-upgrade"), "d"), auth: slowAuth, durability: "normal", onError: (e) => errors.push(e) });
    const token = await tokenFor("w", "g");
    const connecting = webSocketTransport({ keepaliveMs: 0 }).connect(h.urlFor("g"), { token }).then(
      (c) => (c.close(), "connected"),
      () => "refused",
    );
    await reached;
    const closed = h.close();
    await new Promise((r) => setTimeout(r, 50));
    release();
    await closed;
    assert.equal(await connecting, "refused");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.room("g"), undefined, "a room opened after close");
    assert.deepEqual(errors, []);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("an envelope that lands while the host closes still registers its project: the next start sweeps it", async () => {
  const inner = createMemoryBlobStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let blocked = 0;
  const slow = new Proxy(inner, {
    get(t, prop) {
      if (prop === "put")
        return async (...a: Parameters<BlobStore["put"]>) => {
          blocked++;
          await gate;
          return t.put(...a);
        };
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as BlobStore;
  const dataDir = join(scratch("close-register"), "d");
  const h = await startNodeHost({ dataDir, auth, secret: SECRET, blobs: slow, durability: "normal" });
  const token = await tokenFor("w", "late");
  const body = new TextEncoder().encode('{"type":"push"}');
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const hour = Math.floor(Date.now() / 3600_000);
  const upload = fetch(`${h.httpUrl}/api/projects/late/messages/messages/c/${hour}/${sha}-00000006`, { method: "PUT", body, headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  await until(() => blocked > 0, "the upload's write started");
  const closed = h.close();
  await new Promise((r) => setTimeout(r, 50));
  release();
  await closed;
  await upload;
  assert.equal(h.room("late"), undefined);
  // the project's first and only upload landed during shutdown; an old envelope of it waits in the store
  await inner.put(`projects/late/seq/messages/c/${hour - 30}/${sha}-00000007`, body);
  const again = await startNodeHost({ dataDir, auth, secret: SECRET, blobs: inner, durability: "normal" });
  hosts.push(again);
  assert.equal(await again.sweepEnvelopes(), 1, "the restarted host's sweep never visited the project");
});
