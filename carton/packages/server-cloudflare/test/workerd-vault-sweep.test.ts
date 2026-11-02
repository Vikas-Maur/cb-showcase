// The vault's sweep of abandoned uploads (blob-do.ts) in workerd, with the runtime's own alarms. An unfinished upload
// lives VAULT_UPLOAD_TTL_MS untouched (5 s here, so its sweep comes due within the test; it is taken up to TTL/8 later,
// the interval at which parts and listings write its touch), and one sweep alarm deletes at most VAULT_SWEEP_ROWS rows
// (4 here, so a few MiB take several alarms) and reads at most 8 times that. The test worker's `__sweep` route reads the
// vault's tables and alarm without waking its code, and counts the rows it wrote; `__legacy` makes a vault as code from
// before the sweep left it.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHmacAuth } from "@carton/server";
import { mediaApi } from "./media-api.ts";
import { doBlobStore } from "../src/blob-do.ts";
import type { DurableObjectNamespace } from "../src/cf.ts";
import { startDev } from "./dev-server.ts";
import { stateDir } from "./state.ts";

const TTL = 5000;
const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const dev = await startDev({
  config: join(import.meta.dirname, "wrangler.vault.dev.toml"),
  state: stateDir(`dev-vault-sweep-${Date.now()}`),
  vars: { AUTH_SECRET: SECRET, VAULT_UPLOAD_TTL_MS: String(TTL), VAULT_SWEEP_ROWS: "4" },
});
after(() => dev.stop());

const vaultUrl = (name: string, path: string) => `${dev.origin}/__test/vault/${encodeURIComponent(name)}${path}`;
const vaultNs: DurableObjectNamespace = {
  idFromName: (n) => n,
  get: (id) => ({
    fetch: (u: Request | string, init?: RequestInit) => {
      const url = new URL(typeof u === "string" ? u : u.url);
      return fetch(vaultUrl(String(id), `${url.pathname}${url.search}`), init);
    },
  }),
};

interface Sweep {
  alarm: number | null;
  uploads: { id: string; touched: number | null }[];
  parts: Record<string, number>;
  chunks: Record<string, number>;
  rows: number;
  alarmsSet: number;
  passes: number[];
  passReads: number[];
}
const state = async (name: string): Promise<Sweep> => (await fetch(vaultUrl(name, "/__sweep"))).json() as Promise<Sweep>;
const has = (s: Sweep, id: string) => s.uploads.some((u) => u.id === id);
const gone = (s: Sweep, id: string) => !has(s, id) && !s.parts[id] && !s.chunks[id];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bytes = (n: number, seed = 1) => new Uint8Array(n).map((_, i) => (i * 31 + seed) % 251);
const MiB = 1 << 20;

// The Worker's own media API (the production part route: host-http streams the body to the vault as it arrives). The
// vault of a project is named by its id; media keys sit under `media/` in it.
const auth = createHmacAuth({ secret: SECRET });

/** Polls the vault until `ok`, every 100 ms; returns the state that passed. */
async function until(name: string, what: string, ok: (s: Sweep) => boolean, ms = 30_000): Promise<Sweep> {
  const end = Date.now() + ms;
  for (;;) {
    const s = await state(name);
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`timed out: ${what}\n${JSON.stringify(s)}`);
    await sleep(100);
  }
}

// The vaults are separate Durable Objects, so the tests run side by side: their waits overlap.
describe("BlobVault sweeps abandoned uploads", { concurrency: true }, () => {
  test("an upload untouched past the TTL is swept with all its rows; a fresh one and a completed one are kept; the alarm follows the oldest upload and is gone with the last", async () => {
    const name = `sweep-a-${Date.now()}`;
    const v = doBlobStore(vaultNs, name);
    const doneBytes = bytes(MiB + MiB / 2, 7);
    const done = await v.createMultipart("m/done");
    await done.complete([await done.uploadPart(1, doneBytes)]);

    const old = await v.createMultipart("m/old");
    await old.uploadPart(1, bytes(MiB + MiB / 2)); // 2 chunks
    await old.uploadPart(2, bytes(10)); // 1 chunk
    const oldTouched = Date.now(); // its last part was written by now
    let s = await state(name);
    assert.ok(s.alarm !== null && s.alarm <= oldTouched + TTL + TTL / 8, "an alarm is pending, due by the old upload's expiry");
    assert.deepEqual([s.parts[old.uploadId], s.chunks[old.uploadId]], [2, 3]);

    await sleep(TTL * 0.6);
    const freshFrom = Date.now();
    const fresh = await v.createMultipart("m/fresh");
    await fresh.uploadPart(1, bytes(10));
    const freshTouched = Date.now();

    s = await until(name, "the old upload is unlinked", (s) => !has(s, old.uploadId));
    const unlinkedAt = Date.now();
    assert.ok(unlinkedAt >= oldTouched + TTL - 100, `not swept before its time (${unlinkedAt - oldTouched} ms after its last part)`);
    assert.ok(unlinkedAt < freshFrom + TTL, "seen while the fresh upload is still within its TTL");
    assert.ok(has(s, fresh.uploadId), "the fresh upload is kept");
    // a late client finds no upload, never a half-deleted one
    await assert.rejects(old.listParts(), /no multipart upload/);
    await assert.rejects(old.complete([{ partNumber: 1, etag: "x" }]), /no multipart upload/);
    await old.abort(); // still idempotent

    s = await until(name, "the old upload's parts and chunks are deleted", (s) => gone(s, old.uploadId));
    assert.ok(has(s, fresh.uploadId), "the fresh upload is still kept");
    assert.ok(s.alarm !== null && s.alarm >= freshFrom + TTL - 100 && s.alarm <= freshTouched + TTL + 1500, `re-armed for the fresh upload's expiry (alarm ${s.alarm === null ? "none" : s.alarm - freshTouched - TTL} ms from it)`);

    s = await until(name, "the fresh upload is swept", (s) => gone(s, fresh.uploadId) && s.uploads.length === 0);
    assert.ok(Date.now() >= freshTouched + TTL - 100, "the fresh upload was swept only after its TTL");
    s = await until(name, "no alarm is left", (s) => s.alarm === null, 5000);
    const back = await v.get("m/done");
    assert.ok(back && back.byteLength === doneBytes.byteLength && back.every((x, i) => x === doneBytes[i]), "the completed upload's object is whole");

    // an idle vault never wakes: no alarm, nothing set, through a read
    await sleep(1500);
    await v.head("m/done");
    s = await state(name);
    assert.equal(s.alarm, null);
    assert.equal(s.alarmsSet, 0, "no alarm set by an idle vault");
  });

  test("an upload larger than one pass is swept over several alarms, at most VAULT_SWEEP_ROWS rows each", async () => {
    const name = `sweep-b-${Date.now()}`;
    const v = doBlobStore(vaultNs, name);
    const up = await v.createMultipart("m/big");
    await up.uploadPart(1, bytes(5 * MiB + 1)); // 6 chunks
    await up.uploadPart(2, bytes(3 * MiB)); // 3 chunks
    await state(name); // counts from here
    // rows: 1 upload + 9 chunks + 2 parts = 12, so passes of 4: [upload, 3 chunks] and the walk's state row (the upload
    // whose data is left), [4 chunks], [2 chunks, 2 parts], then the walk ends and clears its state row
    const passes: number[] = [];
    let s = await until(name, "the big upload is swept", (s) => (passes.push(...s.passes), gone(s, up.uploadId)));
    s = await until(name, "no alarm is left", (s) => (passes.push(...s.passes), s.alarm === null), 5000);
    passes.push(...(await state(name)).passes);
    // an alarm that deletes nothing: one that found the upload not yet expired, or the last, finding nothing left
    assert.deepEqual(passes.filter((r) => r > 0), [5, 4, 4, 1], `rows written by each alarm: ${passes.join(", ")}`);
  });

  test("a part written or a listing keeps an upload alive past its first expiry", async () => {
    const name = `sweep-t-${Date.now()}`;
    const v = doBlobStore(vaultNs, name);
    const t0 = Date.now();
    const up = await v.createMultipart("m/slow");
    const p1 = await up.uploadPart(1, bytes(100));
    await sleep(TTL * 0.6);
    const listedAt = Date.now();
    assert.equal((await up.listParts()).length, 1); // touches: the upload was last touched more than TTL/8 ago
    await sleep(TTL * 0.6);
    let s = await state(name);
    assert.ok(has(s, up.uploadId), `kept ${Date.now() - t0} ms after it was made, past its first expiry, by the listing`);
    assert.ok(s.alarm !== null && s.alarm >= listedAt + TTL - 100, "the first alarm found it touched and re-armed for the new expiry");
    const p2 = await up.uploadPart(2, bytes(100));
    await sleep(TTL * 0.6);
    s = await state(name);
    assert.ok(has(s, up.uploadId), "kept past the listing's expiry by the part written later");
    // and it completes whole: the sweep never touched it
    const info = await up.complete([p1, p2]);
    assert.equal(info.size, 200);
    s = await until(name, "the alarm runs out with no upload left", (s) => s.alarm === null, TTL + 5000);
    assert.equal((await v.get("m/slow"))?.byteLength, 200);
  });

  test("a vault from before the sweep is armed by its next request, of any kind, and its old upload swept a TTL later", async () => {
    const name = `sweep-l-${Date.now()}`;
    const v = doBlobStore(vaultNs, name);
    await v.put("m/kept", bytes(10)); // a vault with an object, then made legacy
    assert.equal((await fetch(vaultUrl(name, "/__legacy?k=m%2Fold"), { method: "POST" })).status, 204);
    let s = await state(name);
    assert.deepEqual([s.alarm, s.uploads.map((u) => u.id), s.uploads[0]?.touched], [null, ["legacy"], null], "legacy: an upload with no time and no alarm");

    const t0 = Date.now();
    await v.head("m/kept"); // a read: the migration runs, and the sweep is armed
    const t1 = Date.now();
    s = await state(name);
    const touched = s.uploads.find((u) => u.id === "legacy")?.touched ?? 0;
    assert.ok(touched >= t0 - 100 && touched <= t1 + 100, "the old upload counts as touched when the new code first ran");
    assert.ok(s.alarm !== null && s.alarm >= t0 + TTL - 100 && s.alarm <= t1 + TTL + TTL / 8 + 100, `armed for its expiry (${s.alarm === null ? "none" : s.alarm - t0} ms from the read)`);
    assert.equal(s.alarmsSet, 1);

    // the migrated tables take new uploads as before
    const up = await v.createMultipart("m/new");
    await up.complete([await up.uploadPart(1, bytes(10))]);

    s = await until(name, "the legacy upload is swept", (s) => gone(s, "legacy") && s.uploads.length === 0);
    assert.ok(Date.now() >= t0 + TTL - 100, "swept only after a full TTL from the new code's first run");
    await until(name, "no alarm is left", (s) => s.alarm === null, 5000);
    assert.equal((await v.get("m/kept"))?.byteLength, 10);
    assert.equal((await v.get("m/new"))?.byteLength, 10);
  });

  // cf review finding 7: the sweep's row budget bounded what it deleted, not what it read. Its expiry query read every
  // upload's parts (their times), and finding the data of swept uploads read every part in the vault and listed every
  // such upload before the budget applied, on every alarm: a backlog cost rows read in proportion to its size, again
  // and again. Each alarm's reads must stay bounded by the budget, whatever the backlog.
  test("a backlog is swept with each alarm's rows read bounded by its budget, not by the backlog (cf review finding 7)", async (t) => {
    const name = `sweep-r-${Date.now()}`;
    const v = doBlobStore(vaultNs, name);
    const N = 40;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const up = await v.createMultipart(`m/backlog-${i}`);
      await up.uploadPart(1, bytes(100, i));
      ids.push(up.uploadId);
    }
    await state(name); // counts from here
    const passes: number[] = [], reads: number[] = [];
    const take = (s: Sweep) => (passes.push(...s.passes), reads.push(...s.passReads), s);
    await until(name, "the backlog is swept", (s) => (take(s), ids.every((id) => gone(s, id))), 120_000);
    await until(name, "no alarm is left", (s) => (take(s), s.alarm === null), 10_000);
    take(await state(name));
    const deleted = passes.reduce((a, b) => a + b, 0);
    const read = reads.reduce((a, b) => a + b, 0);
    t.diagnostic(`rows written per alarm: ${passes.join(" ")} (total ${deleted}); rows read per alarm: ${reads.join(" ")} (total ${read})`);
    // rows: N uploads × (its row, 1 part, 1 chunk); each alarm deletes at most the budget (4), plus the sweep's own
    // bookkeeping row
    assert.ok(passes.every((w) => w <= 4 + 1), `rows written by each alarm: ${passes.join(", ")}`);
    assert.ok(deleted >= 3 * N, `${deleted} rows written for ${3 * N} rows of backlog`);
    // read: at most 8 × the budget an alarm, and about as many rows as it deletes, in total
    assert.ok(Math.max(...reads) <= 8 * 4, `rows read by each alarm: ${reads.join(", ")}`);
    assert.ok(read <= 4 * deleted, `${read} rows read in all to delete ${deleted}`);
  });

  // cf review finding 1: the touch of a part is its row, written once its whole body is in. A resumed upload whose last
  // touch was nearly a TTL ago had its upload and stored parts deleted by the alarm while a part's body was arriving,
  // and the part then failed NoSuchUpload. Through the production route, so the body really arrives over time.
  test("a part whose body is still arriving when its upload's touch expires is stored, and the parts already saved survive (cf review finding 1)", async () => {
    const project = `lease-a-${Date.now()}`;
    const api = await mediaApi(dev.origin, auth, project);
    const key = `m/${"a".repeat(64)}`;
    const made = await api.call("/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, size: 128 * 1024 }) });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const id = String(made.body!.uploadId);
    const one = bytes(64 * 1024, 3), two = bytes(64 * 1024, 4);
    const p1 = await api.call(`/uploads/${encodeURIComponent(id)}/1?key=${encodeURIComponent(key)}`, { method: "PUT", body: one });
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    const touched = Date.now();
    await sleep(TTL - 1800); // resumed shortly before the upload expires
    // part 2 takes about 4 s to arrive: its upload's expiry (and the sweep's alarm) comes 2 s into it
    const t0 = Date.now();
    const p2 = await api.slowPart(key, id, 2, two, { pieces: 16, everyMs: 250 });
    assert.ok(Date.now() > touched + TTL + 500, `the part ended ${Date.now() - touched - TTL} ms after the upload's expiry: the race wasn't crossed`);
    assert.ok(t0 < touched + TTL - 500, "the part started before the expiry");
    assert.notEqual(p2, "cut");
    assert.equal((p2 as { status: number }).status, 200, `the part arriving across the expiry: ${JSON.stringify(p2)}`);
    const s = await state(project);
    assert.ok(has(s, id), "the upload is kept");
    assert.equal(s.parts[id], 2, "both parts are stored");
    const done = await api.call(`/uploads/${encodeURIComponent(id)}/complete?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [p1.body, (p2 as { body: unknown }).body] }) });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body!.size, 128 * 1024);
    const back = await doBlobStore(vaultNs, project).get(`media/${key}`);
    assert.ok(back && back.byteLength === 128 * 1024 && back.subarray(0, 64 * 1024).every((x, i) => x === one[i]) && back.subarray(64 * 1024).every((x, i) => x === two[i]), "the object is whole");
  });

  test("an upload whose part was cut off mid-body still expires a TTL after it was last touched (cf review finding 1)", async () => {
    const project = `lease-b-${Date.now()}`;
    const api = await mediaApi(dev.origin, auth, project);
    const key = `m/${"b".repeat(64)}`;
    const made = await api.call("/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, size: 64 * 1024 }) });
    const id = String(made.body!.uploadId);
    assert.equal(await api.slowPart(key, id, 1, bytes(64 * 1024, 5), { pieces: 16, everyMs: 100, cutAfter: 6 }), "cut");
    const cutAt = Date.now();
    const s = await until(project, "the abandoned upload is swept", (s) => gone(s, id) && s.uploads.length === 0, TTL * 4);
    assert.ok(Date.now() >= cutAt + TTL - 1000, `swept ${Date.now() - cutAt} ms after the cut: before its TTL`);
    assert.equal(s.parts[id], undefined);
  });

  test("a vault from the sweep's first version keeps an upload whose part is recent, and deletes the data that version left", async () => {
    const name = `sweep-f-${Date.now()}`;
    const v = doBlobStore(vaultNs, name);
    await v.head("m/none");
    // made more than a TTL ago, with a part written just now: by its own `touched` alone it would be swept at once
    const firstAt = Date.now();
    assert.equal((await fetch(vaultUrl(name, `/__first?k=m%2Factive&age=${TTL + 2000}`), { method: "POST" })).status, 204);
    await v.head("m/none"); // the migration runs, and the sweep is armed
    let s = await state(name);
    assert.ok(has(s, "active"), JSON.stringify(s));
    assert.ok(s.uploads.find((u) => u.id === "active")!.touched! >= firstAt, `the upload's touch is its newest part's: ${JSON.stringify(s.uploads)}`);
    s = await until(name, "the leftover data is deleted", (s) => !s.parts.leftover && !s.chunks.leftover);
    assert.ok(has(s, "active"), "the upload with a recent part is kept");
    assert.ok(!has(s, "leftover"), "the row made for the leftover data is gone with it");
    const up = await v.resumeMultipart("m/active", "active");
    assert.equal((await up.complete([{ partNumber: 1, etag: '"pactive"' }])).size, 3);
    assert.deepEqual([...((await v.get("m/active")) ?? [])], [1, 2, 3]);
  });

  // The cost the sweep adds (Cloudflare bills rows written, setAlarm as one too): none per part, none per create
  // while an alarm is pending, a listing at most one row an hour (TTL/8 here).
  test("rows written: a create 1 (and one alarm when none is pending), a part 1 plus 1 per MiB, a listing none within the touch interval", async () => {
    const name = `sweep-c-${Date.now()}`;
    const v = doBlobStore(vaultNs, name);
    await v.head("m/none"); // the vault's tables are made, and its alarm checked (none pending, no upload)
    await state(name);
    const createdAt = Date.now();
    const up = await v.createMultipart("m/one");
    let s = await state(name);
    assert.deepEqual([s.rows, s.alarmsSet], [1, 1], "the first create: its row and the alarm");
    const up2 = await v.createMultipart("m/two");
    s = await state(name);
    assert.deepEqual([s.rows, s.alarmsSet], [1, 0], "a create while the alarm is pending: its row only");
    await up.uploadPart(1, bytes(2 * MiB + 1));
    const partAt = Date.now();
    s = await state(name);
    // the part came within TTL/8 of the create (the upload's touch) unless the box stalled for that long
    if (partAt - createdAt < TTL / 8 - 50) assert.deepEqual([s.rows, s.alarmsSet], [4, 0], "a part: its row and 3 chunks, as before the sweep");
    await up.listParts();
    const listed = Date.now();
    s = await state(name);
    // the listing came within TTL/8 of the upload's touch unless the box stalled for that long
    if (listed - createdAt < TTL / 8 - 50) assert.deepEqual([s.rows, s.alarmsSet], [0, 0], "a listing soon after a part: nothing written");
    await sleep(TTL / 8 + 100);
    await up.listParts();
    await up.listParts();
    s = await state(name);
    assert.deepEqual([s.rows, s.alarmsSet], [1, 0], "two listings after the interval: one touch");
    await up.abort();
    await up2.abort();
  });
});
