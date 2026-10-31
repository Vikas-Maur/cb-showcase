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
