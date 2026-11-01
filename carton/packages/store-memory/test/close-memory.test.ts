// A closed handle holds nothing (verify-ci F4, route 40): opening from keyframes started the background load with a
// timer that held the handle, and with it the whole history, until it fired; a loop of opens and closes whose reads
// all resolve at once never let it fire, so each closed handle's history stayed in memory until the heap ran out.
// close() clears the timer, and a background load stops paging once close() has begun.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Carton, type Store } from "@carton/core";
import type { StoreRange } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set } from "./fixture.ts";

const alice = { kind: "human" as const, id: "alice" };
const tick = () => new Promise((r) => setTimeout(r, 20));
/** The background read of the older rows: `changes` up to a seq, with no lower bound. */
const olderRows = (table: string, r?: StoreRange) => table === "changes" && !!r?.lte && !r.gt && !r.gte;

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const heap = () => (gc(), gc(), process.memoryUsage().heapUsed);

async function project(n: number): Promise<Store> {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  for (let i = 1; i <= n; i++) assert.equal((await c.commit({ ops: [set("b", "name", `b ${i}`)] })).status, "confirmed");
  await c.close();
  return store;
}

test("opening and closing a 30,000-change project again and again: the heap after each close stays flat", { timeout: 600_000 }, async () => {
  const store = await project(30_000);
  const after: number[] = [];
  // no turn of the event loop between the cycles: every read of the memory store resolves at once
  for (let k = 0; k < 8; k++) {
    let c: Carton | null = await Carton.open({ adapter, store, actor: alice });
    assert.equal((await c.head()).ref.seq, 30_000);
    assert.equal((await c.log({ limit: 1 }))[0]!.ref.seq, 30_000); // waits for the whole history
    await c.close();
    c = null;
    after.push(heap());
  }
  const mb = (b: number) => (b / 2 ** 20).toFixed(1);
  const first = after[0]!,
    last = after[after.length - 1]!;
  assert.ok(last <= first * 1.1, `heap after close: ${after.map(mb).join(", ")} MB (the last more than 10% over the first)`);
});

test("close() while the older rows load a page at a time: the pages stop, close() doesn't wait for them all", async () => {
  const raw = await project(12_000);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let older = 0;
  const store = new Proxy(raw, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        if (olderRows(table, r) && ++older === 1) await held;
        return (v as Store["range"]).call(t, table as never, r);
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store, actor: alice });
  await c.head();
  await tick();
  assert.equal(older, 1, "the background load's first page is being read");
  const closing = c.close();
  release();
  await closing;
  await tick();
  await tick();
  assert.equal(older, 1, "no page read after the one under way when close() began (12,000 rows are three pages)");
});
