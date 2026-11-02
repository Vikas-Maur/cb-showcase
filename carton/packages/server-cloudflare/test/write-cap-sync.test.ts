// A sync write the daily write cap refuses (src/write-cap.ts) resumes on its own once the cap resets (cf review
// finding 2). The real sequencer (in-process host), the real cap around a blob store with its counter on real SQLite
// (the SQL a ProjectRoom runs), and the real sync client (SharedCut). Time is a clock the test moves across midnight UTC,
// and the client's timers are the test's, so the wait for the reset is the client's own, and fired when it is due.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { createInProcessHost, createSequencer } from "@carton/server";
import { defineSchema, timeAlgebra, sync, type Doc, type Op } from "@carton/core";
import type { AuthContext } from "@carton/core/plugins";
import { cappedBlobStore, reserveIn, writeCapOf, WRITE_CAP_PATH } from "../src/write-cap.ts";
import type { DurableObjectNamespace } from "../src/cf.ts";
import { sqliteStorage } from "../../server/test/helpers.ts";

const TL = { collection: "timelineItems", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { key: "id", seq: true },
    timelineItems: { key: "id", parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
});
const clip = (id: string, s: number, e: number) => ({ id, trackId: "V1", startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, opacity: 1 });
const d0: Doc = { tracks: [{ id: "V1", "#pos": "a" }], timelineItems: [clip("c0", 0, 5), clip("c1", 5, 10)] } as never;
const set = (id: string, f: string, v: unknown): Op => ({ op: "set", path: ["timelineItems", id, f], value: v });
const B = "main-cut";
const me = { kind: "human" as const, id: "me" };
const rec = { id: B, name: "main", forkOf: null, owner: "me", kind: "main" as const, sequencer: { kind: "server" as const, since: 0 } };
const tick = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** A namespace whose rooms are SQLite databases answering the counter's route, as ProjectRoom.fetch does. */
function counterRooms(): DurableObjectNamespace {
  const rooms = new Map<string, DatabaseSync>();
  // DO SQL's shape: exec runs at once, as ctx.storage.sql.exec does
  const sqlOf = (db: DatabaseSync) => ({
    exec: (q: string, ...b: unknown[]) => {
      const rows = db.prepare(q).all(...(b as never[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  });
  return {
    idFromName: (n) => n,
    get: (id) => ({
      async fetch(input: Request | string) {
        const req = input as Request;
        assert.equal(new URL(req.url).pathname, WRITE_CAP_PATH);
        if (!rooms.has(String(id))) rooms.set(String(id), new DatabaseSync(":memory:"));
        return Response.json(reserveIn(sqlOf(rooms.get(String(id))!), (await req.json()) as never));
      },
    }),
  };
}

/** Timers the test fires: every delay asked for is kept with its callback. */
function heldTimers() {
  const due = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  return {
    timers: { setTimeout: (fn: () => void, ms: number) => (due.set(++n, { fn, ms }), n), clearTimeout: (h: unknown) => void due.delete(h as number) },
    pending: () => [...due.values()].map((d) => d.ms),
    fire(pred: (ms: number) => boolean) {
      for (const [h, d] of [...due]) if (pred(d.ms)) (due.delete(h), d.fn());
    },
  };
}

async function rig() {
  let now = Date.UTC(2026, 10, 2, 23, 58, 0); // two minutes before the cap resets
  const clock = () => now;
  const auth = { kind: "test", verify: async (): Promise<AuthContext> => ({ account: "me", credential: "me/dev", role: "editor", projectId: "p", expires: Number.MAX_SAFE_INTEGER }) };
  const inner = createMemoryBlobStore();
  const blobs = cappedBlobStore(inner, writeCapOf({ PROJECT_ROOM: counterRooms(), WRITE_CAP_BYTES_PER_DAY: String(64 << 10) }, { now: clock }));
  // a change body over 2 KiB goes to the blob store, so through the cap
  const host = createInProcessHost({ storage: sqliteStorage(), auth, blobs, clock, maxInlineBytes: 2048 });
  await host.sequencer.createBranch(rec, { doc0: d0 as never, stateHash: "h0" });
  const t = heldTimers();
  const events: sync.SharedCutEvent[] = [];
  const cut = new sync.SharedCut({ schema, branch: { id: B, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, doc0: d0, transport: host.transport, url: host.url, token: "t", schemaVersion: 1, client: { timers: t.timers, clock, random: () => 0, defer: (fn) => queueMicrotask(fn) } });
  cut.on((e) => events.push(e));
  const joined = cut.connect({ nonce: "n" });
  await tick();
  assert.equal(await joined, true);
  return { host, inner, blobs, cut, events, t, clock, setNow: (v: number) => (now = v) };
}

test("a sync write refused by the daily cap is kept, held back, and synced on its own once the cap resets (cf review finding 2)", async () => {
  const r = await rig();
  r.cut.commit({ id: "r1aaaaaaaaaaaaaaaaaaaaaa.1", author: me, ops: [set("c0", "name", "small")], at: 0 });
  await tick();
  assert.equal(r.cut.state().pending, 0, "a small edit syncs (inline: no blob write)");
  // the rest of today's bytes go to other writes
  await r.blobs.put("media-of-the-day", new Uint8Array((64 << 10) - 1000));
  r.cut.commit({ id: "r1aaaaaaaaaaaaaaaaaaaaaa.2", author: me, ops: [set("c0", "name", "x".repeat(5000))], at: 0 });
  await tick();
  r.cut.commit({ id: "r1aaaaaaaaaaaaaaaaaaaaaa.3", author: me, ops: [set("c1", "name", "after the big one")], at: 0 });
  await tick();
  // refused: kept, held, and the owner told when it syncs, in plain words
  assert.equal(r.cut.state().pending, 2, "both edits kept");
  assert.equal(r.cut.state().label, "Syncing");
  assert.equal(r.host.sequencer.stats.writeLimited, 1, "refused once; nothing pushed again meanwhile");
  const notice = r.events.find((e) => e.type === "error" && e.code === "write-limit") as Extract<sync.SharedCutEvent, { type: "error" }> | undefined;
  assert.ok(notice, `no write-limit notice: ${JSON.stringify(r.events.filter((e) => e.type === "error"))}`);
  assert.match(notice.error, /^The server's daily limit is reached\. Your edits are kept and will sync after \d{1,2}:\d{2}/);
  assert.doesNotMatch(notice.error, /DailyWriteCap|429|UTC|internal/);
  assert.equal(notice.until, r.clock() + 120_000, "until the reset at 00:00 UTC");
  assert.deepEqual(r.t.pending(), [120_000], "one wait, for the reset");
  // still before the reset: the server is never asked again
  await tick();
  assert.equal(r.host.sequencer.stats.writeLimited, 1);
  // past midnight UTC: the wait ends and the queue goes again, on the same connection
  r.setNow(Date.UTC(2026, 10, 3, 0, 0, 1));
  r.t.fire((ms) => ms === 120_000);
  await tick(40);
  assert.equal(r.cut.state().pending, 0, `still pending after the reset: ${JSON.stringify(r.cut.state())}`);
  assert.equal(r.cut.state().label, "Up to date");
  assert.equal(r.host.sequencer.tables.head(B), 3, "all three edits confirmed, in order");
  assert.equal(r.host.connections, 1, "no reconnect");
  assert.ok([...(await r.inner.list("changes/")).blobs].length === 1, "the big edit's body stored once the cap allowed");
  assert.deepEqual((await r.cut.waitFor("r1aaaaaaaaaaaaaaaaaaaaaa.2", 0)).status, "confirmed");
});

test("held back by the cap across a reconnect: the welcome doesn't push before the reset, and the owner is told again (cf review finding 2)", async () => {
  const r = await rig();
  await r.blobs.put("media-of-the-day", new Uint8Array((64 << 10) - 1000));
  r.cut.commit({ id: "r1aaaaaaaaaaaaaaaaaaaaaa.1", author: me, ops: [set("c0", "name", "y".repeat(5000))], at: 0 });
  await tick();
  assert.equal(r.host.sequencer.stats.writeLimited, 1);
  const told = r.events.filter((e) => e.type === "error" && e.code === "write-limit").length;
  r.host.drop();
  await tick();
  r.t.fire((ms) => ms !== 120_000); // the reconnect's backoff, not the reset
  await tick(40);
  assert.equal(r.host.connections, 1, "reconnected");
  assert.equal(r.host.sequencer.stats.writeLimited, 1, "the welcome pushed nothing before the reset");
  assert.equal(r.events.filter((e) => e.type === "error" && e.code === "write-limit").length, told + 1, "told again after the welcome");
  r.setNow(Date.UTC(2026, 10, 3, 0, 0, 1));
  r.t.fire((ms) => ms === 120_000);
  await tick(40);
  assert.equal(r.cut.state().pending, 0);
  assert.equal(r.host.sequencer.tables.head(B), 1);
});

test("an older client (no writeLimit in its hello) gets the limit in plain words, and its epoch is left as it was (cf review finding 2)", async () => {
  const capped = createSequencer({ storage: sqliteStorage(), auth: { kind: "test", verify: async () => null }, blobs: cappedBlobStore(createMemoryBlobStore(), writeCapOf({ PROJECT_ROOM: counterRooms(), WRITE_CAP_OPS_PER_DAY: "1" })), maxInlineBytes: 2048 });
  await capped.createBranch(rec, { doc0: d0 as never, stateHash: "h0" }); // the one op of the day: the root keyframe
  const inbox: sync.ServerMessage[] = [];
  const conn = { id: "old-1", auth: { account: "me", credential: "me/dev", role: "editor" as const, projectId: "p", expires: Number.MAX_SAFE_INTEGER }, send: (m: sync.ServerMessage) => void inbox.push(m) };
  await capped.handle(conn, { type: "hello", branchId: B, have: 0, pending: [], rids: [], schemaVersion: 1 });
  const ch = (id: string, name: string) => ({ id, hash: "h", author: me, branchId: B, base: { seq: 0, pending: [] }, ops: [set("c0", "name", name)], intent: null, kinds: null, policy: "merge" as const, at: 0, rebase: 0, supersedes: [], paths: ["timelineItems/c0/name"], reads: ["timelineItems/c0"], spans: [], trackOrder: [] });
  await capped.handle(conn, { type: "push", branchId: B, epoch: 1, changes: [ch("r9aaaaaaaaaaaaaaaaaaaaaa.1", "z".repeat(5000))] });
  const err = inbox.find((m) => m.type === "error") as sync.ErrorMsg | undefined;
  assert.ok(err, "an error, not silence");
  assert.equal(err.code, "write-limit");
  assert.match(err.reason, /^The server's daily limit is reached\. Your edits are kept and will sync after \d\d:\d\d UTC/);
  assert.equal(err.epoch, undefined, "no epoch dropped for a client that doesn't wait the limit out");
  assert.ok(typeof err.retryAt === "number" && typeof err.retryAfterMs === "number");
  // the epoch is still live for it: a small change in it is judged, as before
  await capped.handle(conn, { type: "push", branchId: B, epoch: 1, changes: [{ ...ch("r9aaaaaaaaaaaaaaaaaaaaaa.2", "small"), base: { seq: 0, pending: [] } }] });
  assert.ok(inbox.some((m) => m.type === "ack" && m.id === "r9aaaaaaaaaaaaaaaaaaaaaa.2"), `no answer in the same epoch: ${JSON.stringify(inbox.map((m) => m.type))}`);
});

test("a hand-off the cap refuses is answered with the limit and its time, for the client to ask again after it (cf review finding 2)", async () => {
  const capped = createSequencer({ storage: sqliteStorage(), auth: { kind: "test", verify: async () => null }, blobs: cappedBlobStore(createMemoryBlobStore(), writeCapOf({ PROJECT_ROOM: counterRooms(), WRITE_CAP_OPS_PER_DAY: "1" })), maxInlineBytes: 2048 });
  await capped.createBranch(rec, { doc0: d0 as never, stateHash: "h0" }); // the one op of the day
  const inbox: sync.ServerMessage[] = [];
  const conn = { id: "c-1", auth: { account: "me", credential: "me/dev", role: "owner" as const, projectId: "p", expires: Number.MAX_SAFE_INTEGER }, send: (m: sync.ServerMessage) => void inbox.push(m) };
  await capped.handle(conn, { type: "adopt", branchId: "shared", n: 0, stateHash: "h", rows: [], rec: { ...rec, id: "shared" }, doc0: d0 as never, closure: [] });
  const err = inbox.find((m) => m.type === "adoptError") as sync.AdoptErrorMsg | undefined;
  assert.ok(err, JSON.stringify(inbox));
  assert.equal(err.code, "write-limit");
  assert.ok(typeof err.retryAfterMs === "number" && err.retryAfterMs > 0 && err.retryAfterMs <= 86_400_000);
  assert.match(err.reason, /^The server's daily limit is reached/);
  assert.ok(!capped.tables.branch("shared"), "nothing of it kept");
});
