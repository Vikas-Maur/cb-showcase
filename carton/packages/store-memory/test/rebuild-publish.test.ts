// A rebuild sets what it read on the handle only together with the History it built (Stage F round 5, fifth re-check;
// both bugs were on the branch before the open-time change): a failed one changes nothing, and the handle's own current
// cut stands through a rebuild that read the stored one while a switch was being saved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Store } from "@carton/core";
import type { StoreRange } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set } from "./fixture.ts";

const alice = { kind: "human" as const, id: "alice" };
const latch = () => {
  let release!: () => void;
  return { p: new Promise<void>((r) => (release = r)), release: () => release() };
};

test("a switch still being saved when a rebuild reads the stored current cut: the handle stays on the cut it switched to", async () => {
  const raw = createMemoryStore();
  const build = latch(),
    buildBegan = latch(),
    write = latch(),
    writeBegan = latch();
  let armed = false,
    holdWrite = false;
  const store = new Proxy(raw, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p === "range")
        return async (table: string, r?: StoreRange) => {
          const out = await (v as Store["range"]).call(t, table as never, r);
          if (armed && table === "meta" && r?.prefix?.[0] === "noop") (armed = false), buildBegan.release(), await build.p;
          return out;
        };
      if (p === "write")
        return async (w: { table: string; key: unknown[] }[], c?: unknown) => {
          if (holdWrite && w.some((x) => x.table === "meta" && x.key[0] === "current")) (holdWrite = false), writeBegan.release(), await write.p;
          return (v as Store["write"]).call(t, w as never, c as never);
        };
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Store;
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  const main = c.cut,
    variant = (await c.fork("variant", { id: "zzzz", from: `${main}@0` })).id;
  for (let i = 1; i <= 100; i++) await c.commit({ ops: [set("b", "name", `b ${i}`)] });
  armed = true;
  const rebuilding = c.compact({ olderThanDays: 0 }); // compaction's rebuild, held before it reads the current cut
  await buildBegan.p;
  holdWrite = true;
  const switching = c.switchTo(variant);
  await writeBegan.p; // switched in memory, the write not landed
  build.release();
  await rebuilding;
  write.release();
  await switching;
  assert.equal(await raw.get("meta", ["current"]), variant);
  assert.equal(c.cut, variant);
  const r = await c.commit({ ops: [set("c", "name", "on the variant")] });
  assert.equal(r.status === "confirmed" && r.ref.branchId, variant);
  await c.close();
});

test("a rebuild that fails leaves the pin snapshot with its History: a pin made meanwhile keeps another handle's owner", async () => {
  const raw = createMemoryStore();
  const pause = latch(),
    paused = latch();
  let holdExport = false,
    fail = false;
  const store = new Proxy(raw, {
    get(t, p, rcv) {
      const v = Reflect.get(t, p, rcv);
      if (p !== "range") return typeof v === "function" ? v.bind(t) : v;
      return async (table: string, r?: StoreRange) => {
        if (holdExport && table === "meta" && r?.prefix?.[0] === "exported" && r.gt) (holdExport = false), paused.release(), await pause.p;
        if (fail && table === "meta" && r?.prefix?.[0] === "join") (fail = false), (() => { throw new Error("rebuild read failed"); })();
        return (v as Store["range"]).call(t, table as never, r);
      };
    },
  }) as Store;
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice });
  const main = c.cut;
  const draft = { ...doc0(), name: "held draft" };
  const first = await c.pin({ owner: "first", doc: draft });
  const other = await Carton.open({ adapter, store: raw, actor: alice });
  holdExport = true;
  const pinning = c.pin({ owner: "ours", doc: draft }); // held after it read the pin's owners
  await paused.p;
  const theirs = await other.pin({ owner: "other", doc: draft });
  await other.fork("trigger", { id: "zzzz", from: `${main}@0` });
  fail = true;
  await assert.rejects(c.cuts(), /rebuild read failed/); // a rebuild that read the newer pins, then failed
  pause.release();
  await pinning;
  const rows = await raw.range<{ owners: { owner: string }[] }>("pins");
  assert.deepEqual(rows[0]!.value.owners.map((o) => o.owner).sort(), ["first", "other", "ours"]);
  await c.release(first.ref, "first");
  await c.release(first.ref, "ours");
  assert.equal((await other.resolve(theirs.ref)).doc.name, "held draft", "the other handle's pinned draft is still there");
  for (const x of [c, other]) await x.close();
});
