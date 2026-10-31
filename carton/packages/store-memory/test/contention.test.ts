// Starvation-free appends (VERIFIED S8): writers committing back to back on one store all get every write in. Each
// handle is its own writer exactly as a process on carton.db is (its own History, every append a conditional batch
// on the shared store); the store answers after a random delay, as IO does, so the interleavings differ every run.
// Before, a writer that lost the append race 4 times in a row failed with "the store changed under this write".
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, item, set } from "./fixture.ts";

const WRITERS = Number(process.env.CARTON_CONTENTION_WRITERS ?? 4);
const N = Number(process.env.CARTON_CONTENTION_WRITES ?? 150);
const RUNS = Number(process.env.CARTON_CONTENTION_RUNS ?? 5);

/** The shared store with IO-like latency: every call resolves after 0–1 ms (a macrotask), in no fixed order. */
function slow(mem: Store): Store {
  const lag = () => new Promise<void>((r) => (Math.random() < 0.5 ? setImmediate(r) : setTimeout(r, Math.random() < 0.2 ? 1 : 0)));
  return Object.assign(Object.create(mem) as Store, {
    get: async (...a: Parameters<Store["get"]>) => (await lag(), mem.get(...a)),
    range: async (...a: Parameters<Store["range"]>) => (await lag(), mem.range(...a)),
    write: async (...a: Parameters<Store["write"]>) => (await lag(), mem.write(...a)),
  });
}

for (let run = 1; run <= RUNS; run++)
  test(`contention run ${run}: ${WRITERS} writers × ${N} back-to-back commits on one store, every one confirmed, none lost or doubled`, { timeout: 300_000 }, async () => {
    const mem = createMemoryStore();
    const first = await Carton.open({ adapter, store: slow(mem), init: { doc: doc0() }, actor: { kind: "human", id: "w0" } });
    const handles = [first];
    for (let w = 1; w < WRITERS; w++) handles.push(await Carton.open({ adapter, store: slow(mem), actor: { kind: "human", id: `w${w}` } as Actor }));
    const failures: string[] = [];
    let confirmed = 0;
    // every writer touches the same record (so every append contends and rebases), each its own field
    await Promise.all(
      handles.map(async (c, w) => {
        for (let i = 0; i < N; i++) {
          try {
            const r = await c.commit({ ops: [set("a", `note_w${w}`, i)] });
            if (r.status === "confirmed") confirmed++;
            else failures.push(`w${w}#${i}: ${r.status}`);
          } catch (e) {
            failures.push(`w${w}#${i}: ${(e as Error).message}`);
          }
        }
      }),
    );
    assert.deepEqual(failures, [], "no write failed");
    assert.equal(confirmed, WRITERS * N);
    const fresh = await Carton.open({ adapter, store: mem, actor: { kind: "human", id: "check" } });
    const head = await fresh.head();
    assert.equal(head.ref.seq, WRITERS * N, "every write is a change: none lost");
    for (let w = 0; w < WRITERS; w++) assert.equal(item(head.doc, "a")![`note_w${w}`], N - 1, `writer ${w}'s last write is the head's`);
    const log = await fresh.log({ limit: WRITERS * N + 1 });
    assert.equal(new Set(log.map((v) => v.change)).size, log.length, "no change recorded twice");
    assert.equal(await mem.get("lease", ["append-turn"]), undefined, "the turn was given back");
    for (const c of [...handles, fresh]) await c.close();
  });

test("a turn left by a writer that died is waited out and cleared; a write is never blocked for good", async () => {
  const mem = createMemoryStore();
  const c = await Carton.open({ adapter, store: mem, init: { doc: doc0() }, actor: { kind: "human", id: "w0" } });
  await mem.write([{ table: "lease", key: ["append-turn"], value: { owner: "dead.0000", until: Date.now() + 300 } }]);
  const t0 = Date.now();
  assert.equal((await c.commit({ ops: [set("a", "name", "after the crash")] })).status, "confirmed");
  assert.ok(Date.now() - t0 >= 250, "it waited for the turn to lapse rather than writing past its holder");
  assert.equal(await mem.get("lease", ["append-turn"]), undefined);
  await c.close();
});

test("a fenced commit (the lease holder's) retries a lost race while its fence holds, and fails at once when it doesn't", async () => {
  const mem = createMemoryStore();
  await mem.write([{ table: "lease", key: ["sync", "nonce"], value: "n1" }]);
  const fence = { table: "lease", key: ["sync", "nonce"], expect: { equals: "n1" } } as const;
  const a = await Carton.open({ adapter, store: slow(mem), init: { doc: doc0() }, actor: { kind: "human", id: "holder" } });
  const b = await Carton.open({ adapter, store: slow(mem), actor: { kind: "human", id: "other" } });
  const failures: string[] = [];
  await Promise.all([
    (async () => {
      for (let i = 0; i < 60; i++) await a.commit({ ops: [set("a", "note_a", i)], conditions: [fence] }).catch((e: Error) => failures.push(e.message));
    })(),
    (async () => {
      for (let i = 0; i < 60; i++) await b.commit({ ops: [set("a", "note_b", i)] }).catch((e: Error) => failures.push(e.message));
    })(),
  ]);
  assert.deepEqual(failures, []);
  assert.equal(item((await a.head()).doc, "a")!.note_a, 59);
  await mem.write([{ table: "lease", key: ["sync", "nonce"], value: "n2" }]);
  await assert.rejects(a.commit({ ops: [set("a", "note_a", 60)], conditions: [fence] }), /store changed under this write/);
  for (const c of [a, b]) await c.close();
});
