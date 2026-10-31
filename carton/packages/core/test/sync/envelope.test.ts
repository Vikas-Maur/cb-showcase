// The oversized-message envelope (sync/envelope.ts): the size bound never under-counts, seal/unseal round-trip and
// refuse anything tampered, and both sides keep message order around uploads and fetches.
import test from "node:test";
import assert from "node:assert/strict";
import {
  Inbox,
  Outbox,
  clientEnvelopeKey,
  envelopeExpired,
  envelopeKeyOk,
  jsonBytesBound,
  oversized,
  seal,
  serverEnvelopeKey,
  unseal,
  type BlobRef,
  type EnvelopeMsg,
} from "../../src/sync/index.ts";
import type { BlobInfo, BlobStore } from "../../src/plugins.ts";

const enc = new TextEncoder();
const utf8 = (v: unknown) => enc.encode(JSON.stringify(v)).byteLength;

/** A Map-backed BlobStore with the calls the envelope uses. */
function blobs(): BlobStore & { map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  const info = (key: string, d: Uint8Array): BlobInfo => ({ key, size: d.byteLength });
  return {
    kind: "test",
    map,
    async put(key, data, o) {
      if (!(o?.ifAbsent && map.has(key))) map.set(key, data.slice());
      return info(key, map.get(key)!);
    },
    async get(key) {
      return map.get(key)?.slice() ?? null;
    },
    async head(key) {
      return map.has(key) ? info(key, map.get(key)!) : null;
    },
    async delete(key) {
      map.delete(key);
    },
    async list(prefix) {
      return { blobs: [...map].filter(([k]) => k.startsWith(prefix)).map(([k, d]) => info(k, d)) };
    },
    async createMultipart() {
      throw new Error("unused");
    },
    async resumeMultipart() {
      throw new Error("unused");
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("envelope: the size bound is never below the real UTF-8 JSON size, and stops early once past the cap", () => {
  const values: unknown[] = [
    { type: "ack", branchId: "b", id: "r.1", seq: 1, epoch: 2 },
    { s: "plain", ctl: "\u0000\u001f\n\t\"\\", bmp: "日本語 éà", astral: "😀🎬", lone: "\ud800x" },
    [1, -1.7976931348623157e308, 5e-324, NaN, Infinity, true, false, null, undefined, () => 1],
    { a: undefined, b: () => 1, c: [undefined, { d: [[]] }], e: {} },
    { rows: Array.from({ length: 200 }, (_, i) => ({ id: `r.${i}`, ops: [{ op: "set", path: ["timelineItems", `c${i}`, "name"], value: "x".repeat(i) }] })) },
  ];
  for (const v of values) assert.ok(jsonBytesBound(v, Infinity) >= utf8(v), JSON.stringify(v).slice(0, 60));
  let reads = 0;
  const row = (i: number) => ({
    get id() {
      reads++;
      return `r.${i}`;
    },
  });
  assert.ok(jsonBytesBound({ rows: Array.from({ length: 100 }, (_, i) => row(i)) }, 1000) > 1000);
  assert.ok(reads < 30, `early exit: stops a little past the cap (${reads} of 100 rows read)`);
});

test("envelope: oversized() gives the JSON and bytes only over the threshold", () => {
  assert.equal(oversized({ type: "ack", seq: 1 }, 1024), null);
  const maybe = { type: "x", s: "é".repeat(200) };
  assert.ok(jsonBytesBound(maybe, Infinity) > 1024 && utf8(maybe) < 1024);
  assert.equal(oversized(maybe, 1024), null, "the bound says maybe; the real size decides");
  assert.ok(oversized({ type: "x", s: "\u0000".repeat(200) }, 1024), "escapes count: 200 NULs are 1,200 bytes");
  const m = { type: "changes", s: "é".repeat(1000) };
  const big = oversized(m, 1024)!;
  assert.equal(big.text, JSON.stringify(m));
  assert.equal(big.bytes.byteLength, utf8(m));
});

test("envelope: seal then unseal round-trips; the server's key is content-addressed, the client's unique", async () => {
  const store = blobs();
  const msg = { type: "push", branchId: "b", epoch: 1, changes: [{ id: "r.1", ops: [{ op: "set", path: ["t", "c", "name"], value: "ü".repeat(5000) }] }] };
  const env = await seal(oversized(msg, 1024)!, store, (sha) => clientEnvelopeKey(sha, Date.now()));
  assert.equal(env.type, "blob");
  assert.equal(env.ref.size, utf8(msg));
  assert.ok(envelopeKeyOk(env.ref, "client") && !envelopeKeyOk(env.ref, "server"));
  assert.deepEqual(await unseal(env.ref, store, { from: "client", maxBytes: 1 << 20 }), msg);
  const k1 = clientEnvelopeKey("a".repeat(64), 0), k2 = clientEnvelopeKey("a".repeat(64), 0);
  assert.notEqual(k1, k2, "two uploads of one message never share a key (the server deletes after reading)");
  assert.equal(serverEnvelopeKey("a".repeat(64), 7_200_000), `messages/s/2/${"a".repeat(64)}`);
});

test("envelope: unseal refuses a foreign key, a wrong size, a wrong digest, a missing blob, an oversize and a nested envelope", async () => {
  const store = blobs();
  const env = await seal(oversized({ type: "push", s: "x".repeat(3000) }, 1024)!, store, (sha) => serverEnvelopeKey(sha, Date.now()));
  const open = (ref: BlobRef, maxBytes = 1 << 20) => unseal(ref, store, { from: "server", maxBytes });
  await assert.rejects(open({ ...env.ref, key: `changes/b/${env.ref.sha256}` }), /isn't an envelope's/);
  await assert.rejects(open({ ...env.ref, sha256: "0".repeat(64) }), /isn't an envelope's/, "the key must name the digest");
  await assert.rejects(open({ ...env.ref, size: env.ref.size + 1 }), /bytes, not/);
  await assert.rejects(open(env.ref, 100), /the limit is 100/);
  const tampered = store.map.get(env.ref.key)!;
  tampered[20] ^= 1;
  await assert.rejects(open(env.ref), /digest doesn't match/);
  store.map.delete(env.ref.key);
  await assert.rejects(open(env.ref), /missing/);
  const inner = await seal(oversized({ type: "blob", ref: env.ref, pad: "x".repeat(3000) }, 1024)!, store, (sha) => serverEnvelopeKey(sha, Date.now()));
  await assert.rejects(open(inner.ref), /envelope inside an envelope/);
});

test("envelope: blobs expire by hour bucket (server's after 2 hours, a client's after a day); other keys never", () => {
  const H = 3_600_000, now = 100 * H;
  assert.equal(envelopeExpired(serverEnvelopeKey("a".repeat(64), 98 * H), now), false);
  assert.equal(envelopeExpired(serverEnvelopeKey("a".repeat(64), 97 * H), now), true);
  assert.equal(envelopeExpired(clientEnvelopeKey("a".repeat(64), 97 * H), now), false);
  assert.equal(envelopeExpired(clientEnvelopeKey("a".repeat(64), 75 * H), now), true);
  assert.equal(envelopeExpired("changes/b/xyz", now), false);
});

test("envelope: the outbox keeps order around an upload, sends synchronously when idle, and falls back inline on a failed upload", async () => {
  const got: unknown[] = [];
  const out = new Outbox<{ n: number }>((m) => got.push(m));
  out.push({ n: 1 });
  assert.deepEqual(got, [{ n: 1 }], "idle: synchronous");
  let release!: (e: EnvelopeMsg) => void;
  const env: EnvelopeMsg = { type: "blob", ref: { key: "k", size: 1, sha256: "s" } };
  out.push({ n: 2 }, new Promise((r) => (release = r)));
  out.push({ n: 3 });
  await tick();
  assert.deepEqual(got, [{ n: 1 }], "3 waits behind 2's upload");
  assert.equal(out.pending, 2);
  release(env);
  await out.flushed();
  assert.deepEqual(got, [{ n: 1 }, env, { n: 3 }]);
  out.push({ n: 4 }, Promise.reject(new Error("upload failed")));
  out.push({ n: 5 });
  await out.flushed();
  assert.deepEqual(got.slice(3), [{ n: 4 }, { n: 5 }], "a failed upload sends the message inline, in its place");
});

test("envelope: the inbox keeps order around a fetch, and a failed fetch fails once and delivers nothing after it", async () => {
  const got: unknown[] = [];
  const fails: unknown[] = [];
  let release!: (m: unknown) => void;
  const inbox = new Inbox<{ n: number }>({ deliver: (m) => got.push(m), open: () => new Promise((r) => (release = r)), fail: (e) => fails.push(e) });
  inbox.receive({ n: 1 });
  assert.deepEqual(got, [{ n: 1 }], "idle: synchronous");
  inbox.receive({ type: "blob", ref: { key: "k", size: 1, sha256: "s" } });
  inbox.receive({ n: 3 });
  await tick();
  assert.deepEqual(got, [{ n: 1 }]);
  release({ n: 2 });
  await tick();
  await tick();
  assert.deepEqual(got, [{ n: 1 }, { n: 2 }, { n: 3 }]);

  const bad = new Inbox<{ n: number }>({ deliver: (m) => got.push(m), open: async () => Promise.reject(new Error("digest")), fail: (e) => fails.push(e) });
  got.length = 0;
  bad.receive({ type: "blob", ref: { key: "k", size: 1, sha256: "s" } });
  bad.receive({ n: 9 });
  for (let i = 0; i < 4; i++) await tick();
  bad.receive({ n: 10 });
  assert.deepEqual(got, [], "nothing after a lost message");
  assert.equal(fails.length, 1);
});
