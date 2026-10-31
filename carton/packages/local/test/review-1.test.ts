// Regressions from review round 1 (local runtime): a non-idempotent write is never retried blindly after its holder
// died holding it; a taker takes over only the nonce it saw fail; a fresh holder is never bypassed by an in-process
// commit; UNC paths map to pipes; an exiting engine thread fails its callers; an ack that lands during the commit
// isn't missed; heartbeats write fresh rows; writes deliver notices without deleting them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryStore } from "@carton/store-memory";
import { ControlServer, pipeName } from "../src/ipc.ts";
import { Lease } from "../src/lease.ts";
import { probeHolder } from "../src/holder.ts";
import { submit, UNKNOWN_OUTCOME } from "../src/client.ts";
import { EngineThread } from "../src/engine-thread.ts";
import { watchOutcomes, destCut, IDEMPOTENT, deliverNotices, actorKey } from "../src/writes.ts";
import { scratch } from "./support/scratch.ts";

const dir = mkdtempSync(join(scratch(), "review1-"));

/** A holder whose socket answers pings, and drops the connection on `carton.commit` (it died holding the call). */
async function dyingHolder(lease: Lease, name: string) {
  const path = join(dir, `${name}.sock`);
  let nonce = "";
  let calls = 0;
  const srv = await ControlServer.listen({
    path,
    open: ["carton.ping"],
    methods: {
      "carton.ping": () => ({ pid: process.pid, nonce }),
      "carton.commit": (_p, ctx) => { calls++; ctx.socket.destroy(); return new Promise(() => {}); },
    },
  });
  const row = (await lease.take(null, { pid: process.pid, socketPath: path, kind: "helper" }))!;
  nonce = row.nonce;
  return { srv, row, calls: () => calls };
}

test("a non-idempotent write whose holder died holding it is not run again: its outcome is reported unknown", async () => {
  const lease = new Lease(createMemoryStore());
  const h = await dyingHolder(lease, "die-undo");
  try {
    const spawned: (string | null)[] = [];
    const r = await submit("carton.commit", { op: { kind: "undo" } }, { lease, idempotent: false, needsHelper: async () => true, spawnHelper: (s) => spawned.push(s), helperStartMs: 200 });
    assert.equal(r.via, "error");
    assert.equal((r as { code?: string }).code, UNKNOWN_OUTCOME);
    assert.equal(h.calls(), 1, "sent once, never again");
    assert.deepEqual(spawned, [], "no takeover to run it a second time");
    assert.equal(IDEMPOTENT.has("undo") || IDEMPOTENT.has("fold") || IDEMPOTENT.has("fork") || IDEMPOTENT.has("restore") || IDEMPOTENT.has("revert"), false);
    assert.ok(IDEMPOTENT.has("commit") && IDEMPOTENT.has("undoTurn"));
  } finally {
    await h.srv.close();
  }
});

test("an idempotent write (a commit with its change id) is retried after the holder died holding it", async () => {
  const lease = new Lease(createMemoryStore());
  const h = await dyingHolder(lease, "die-commit");
  try {
    const r = await submit("carton.commit", { id: "rid.1", op: { kind: "commit" } }, { lease, idempotent: true, needsHelper: async () => true, spawnHelper: () => {}, helperStartMs: 100 });
    assert.equal(r.via, "error");
    assert.ok(h.calls() >= 2, `retried with the same id (${h.calls()} calls)`);
  } finally {
    await h.srv.close();
  }
});

test("probeHolder reports the nonce it pinged; a recently beaten row is fresh even when its holder doesn't answer", async () => {
  const store = createMemoryStore();
  const lease = new Lease(store);
  const dead = (await lease.take(null, { pid: 1, socketPath: join(dir, "nobody.sock"), kind: "helper" }))!;
  const p = await probeHolder(lease);
  assert.deepEqual([p.live, p.seen, p.fresh], [null, dead.nonce, true]);
  // submit passes exactly that nonce to the helper it starts, and never commits in-process past a fresh row
  const seen: (string | null)[] = [];
  const r = await submit("carton.commit", { id: "x.1", op: { kind: "commit" } }, { lease, needsHelper: async () => false, spawnHelper: (s) => seen.push(s), helperStartMs: 50 });
  assert.notEqual(r.via, "in-process", "a holder that beat within 6 s is taken over, not bypassed");
  assert.ok(seen.length >= 1 && seen.every((s) => s === dead.nonce));
  // an expired row is not fresh: a local-only cut commits in-process
  const old = createMemoryStore();
  const l2 = new Lease(old);
  await l2.take(null, { pid: 1, socketPath: join(dir, "nobody2.sock"), kind: "helper" }, Date.now() - 60_000);
  assert.equal((await probeHolder(l2)).fresh, false);
  assert.equal((await submit("carton.commit", { op: { kind: "commit" } }, { lease: l2, needsHelper: async () => false, spawnHelper: () => {} })).via, "in-process");
});

test("Windows: a UNC path maps to a named pipe; only real pipe names pass through", () => {
  const unc = pipeName("\\\\server\\share\\Library\\.carton\\helper-1-abc.sock", "win32");
  assert.match(unc, /^\\\\\.\\pipe\\cardboard-[0-9a-f]{16}$/);
  assert.equal(pipeName("\\\\.\\pipe\\x", "win32"), "\\\\.\\pipe\\x");
  assert.equal(pipeName("\\\\?\\pipe\\y", "win32"), "\\\\?\\pipe\\y");
});

test("an engine thread that exits fails what waits on it, and later calls", async () => {
  const factory = join(dir, "exit-factory.mjs");
  writeFileSync(factory, "export async function createHolderEngine() { setTimeout(() => process.exit(0), 50); return new Promise(() => {}); }\n");
  await assert.rejects(EngineThread.start({ dbPath: join(dir, "x.db"), factory }), (e: any) => e.code === "ENGINE_EXIT");
});

test("an ack that arrives while the commit is still running is not missed", async () => {
  const listeners: ((e: any) => void)[] = [];
  const carton = { on: (l: (e: any) => void) => { listeners.push(l); return () => listeners.splice(listeners.indexOf(l), 1); } } as any;
  const w = watchOutcomes(carton);
  for (const l of listeners) l({ type: "change", branchId: "b", seq: 7, change: { id: "r.1" }, local: false }); // during commit()
  assert.deepEqual(await w.wait("r.1", 10), { kind: "confirmed", seq: 7 });
  assert.equal(await w.wait("r.2", 10), null);
  w.close();
  assert.equal(listeners.length, 0);
});

test("a fold routes by the cut it changes (into), other writes by their cut", () => {
  assert.equal(destCut({ kind: "fold", from: "a", into: "shared-b" }), "shared-b");
  assert.equal(destCut({ kind: "commit", cut: "c" }), "c");
  assert.equal(destCut({ kind: "fork", name: "x" }), undefined);
});

test("heartbeats write a fresh row: a Store that freezes what it keeps still beats", async () => {
  const store = createMemoryStore();
  const lease = new Lease(store);
  const row = (await lease.take(null, { pid: 1, socketPath: "/s", kind: "worker" }))!;
  Object.freeze(await store.get("lease", ["sync"]));
  Object.freeze(row);
  const copy = { ...row };
  assert.ok(await lease.beat(copy, row.heartbeat + 2000));
  assert.equal((await lease.read())!.heartbeat, row.heartbeat + 2000);
});

test("writes deliver notices once and keep them: unresolved cards stay for conflicts, resolve and the Stop hook", async () => {
  const store = createMemoryStore();
  const actor = { kind: "agent" as const, id: "codex/x" };
  await store.write([{ table: "notices", key: [actorKey(actor), 1, 0], value: { to: actorKey(actor), kind: "late-conflict", text: "t", change: "r.1", cards: [{ kind: "field", path: "a/b/c", base: 1, ours: 2, theirs: 3 }] } }]);
  const carton = { store, notices: async () => [] } as any;
  assert.equal((await deliverNotices(carton, actor)).length, 1);
  assert.equal((await deliverNotices(carton, actor)).length, 0, "delivered once");
  const rows = await store.range("notices", { prefix: [actorKey(actor)] });
  assert.equal(rows.length, 1, "still there for cb conflicts / cb resolve");
});
