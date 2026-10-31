// The Store conformance cases (PLAN §3.1): a Store plug-in is accepted when it passes them. They check every invariant
// written on the `Store` interface in `@carton/core/plugins`. This file uses no Node API, so the same cases run inside
// a browser page for store-idb; `index.ts` registers them with node:test.

import type { Store, StoreKey } from "@carton/core/plugins";
import { ok, eq, deepEq, rejects } from "./check.ts";

export { CheckFailed } from "./check.ts";

export interface StoreSuiteOptions {
  /** A second, independent handle on the same store (another process for SQLite, another tab for IndexedDB). */
  second?: (first: Store) => Promise<Store>;
  /** Close `first` and open the same data again (persistent stores). */
  reopen?: (first: Store) => Promise<Store>;
}

/** What a case gets: the store under test, and the extra handles its options can make. */
export interface StoreFixture {
  store: Store;
  another?(): Promise<Store>;
  reopen?(): Promise<Store>;
}

export interface StoreCase {
  name: string;
  run(f: StoreFixture): Promise<void>;
}

/** Run one case on a fresh store, closing every handle it opened. */
export async function runStoreCase(c: StoreCase, make: () => Promise<Store>, opts: StoreSuiteOptions = {}): Promise<void> {
  const opened: Store[] = [];
  const f: StoreFixture = { store: await make() };
  opened.push(f.store);
  const second = opts.second;
  const reopen = opts.reopen;
  if (second) f.another = async () => { const s = await second(f.store); opened.push(s); return s; };
  if (reopen) f.reopen = async () => { const s = await reopen(f.store); opened.push(s); f.store = s; return s; };
  try {
    await c.run(f);
  } finally {
    for (const s of opened.reverse()) await s.close().catch(() => {});
  }
}

/** The contract's key order, as a reference: element-wise; number < string; numbers numerically; strings as JS `<`. */
export function referenceCompare(a: StoreKey, b: StoreKey): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return a.length - b.length;
}

const keys = (rows: { key: StoreKey }[]) => rows.map((r) => r.key);
const put = (table: string, key: StoreKey, value: unknown) => ({ table, key, value });

// Keys chosen to catch the usual mistakes: string order of numbers ("10" < "9"), number vs string, negative and
// fractional numbers, a key vs its extensions, UTF-16 code units vs code points (U+FFFD sorts after an astral
// character's high surrogate D83D in UTF-16, before it in UTF-8), the empty string and "\u0000".
const ORDER_KEYS: StoreKey[] = [
  [],
  [-1e9],
  [-2.5],
  [-0.5, "z"],
  [0],
  [0, -1],
  [0, 0],
  [0, ""],
  [0, "a"],
  [1],
  [2],
  [9],
  [10],
  [1e15],
  [""],
  ["", 0],
  ["\u0000"],
  ["A"],
  ["a"],
  ["a", 1],
  ["a", 2],
  ["a", 10],
  ["a", "b"],
  ["a\u0000"],
  ["ab"],
  ["b"],
  ["é"],
  ["😀"],
  ["�"],
];

export const storeCases: readonly StoreCase[] = [
  {
    name: "info names the store and says whether it is persistent and multi-process",
    async run({ store }) {
      ok(typeof store.info.kind === "string" && store.info.kind.length > 0);
      eq(typeof store.info.persistent, "boolean");
      eq(typeof store.info.multiProcess, "boolean");
    },
  },
  {
    name: "a missing key, or a key of a table never written, reads as undefined; ranges of it are empty",
    async run({ store }) {
      eq(await store.get("never", ["x"]), undefined);
      deepEq(await store.range("never"), []);
      ok(await store.write([put("t", ["a"], 1)]));
      eq(await store.get("t", ["b"]), undefined);
      deepEq(await store.range("t", { prefix: ["b"] }), []);
    },
  },
  {
    name: "put, overwrite and delete (value undefined) round-trip",
    async run({ store }) {
      ok(await store.write([put("t", ["k", 1], { a: 1 })]));
      deepEq(await store.get("t", ["k", 1]), { a: 1 });
      ok(await store.write([put("t", ["k", 1], { a: 2 })]));
      deepEq(await store.get("t", ["k", 1]), { a: 2 });
      ok(await store.write([put("t", ["k", 1], undefined)]));
      eq(await store.get("t", ["k", 1]), undefined);
      deepEq(await store.range("t"), []);
      ok(await store.write([put("t", ["absent"], undefined)]), "deleting an absent key is a no-op");
    },
  },
  {
    name: "values round-trip as JSON",
    async run({ store }) {
      const v = {
        s: "plain",
        u: "é \u0000 😀 \ud800",
        n: [0, -1, 1.5, -2.25, 2 ** 53 - 1, -(2 ** 53) + 1, 1e300, 5e-324],
        b: [true, false],
        z: null,
        o: { nested: { deep: [[], {}, [{ x: "y" }]] } },
        e: "",
      };
      ok(await store.write([put("t", ["v"], v), put("t", ["s"], "str"), put("t", ["n"], 0), put("t", ["f"], false), put("t", ["z"], null), put("t", ["a"], [1, "2"])]));
      deepEq(await store.get("t", ["v"]), v);
      eq(await store.get("t", ["s"]), "str");
      eq(await store.get("t", ["n"]), 0);
      eq(await store.get("t", ["f"]), false);
      eq(await store.get("t", ["z"]), null);
      deepEq(await store.get("t", ["a"]), [1, "2"]);
    },
  },
  {
    name: "undefined object members may be dropped, never turned into something else",
    async run({ store }) {
      ok(await store.write([put("t", ["u"], { a: 1, gone: undefined })]));
      const got = (await store.get<Record<string, unknown>>("t", ["u"]))!;
      eq(got.a, 1);
      eq(got.gone, undefined);
    },
  },
  {
    name: "key order: element-wise, number < string, numbers numerically, strings by UTF-16 code units, prefix first",
    async run({ store }) {
      const shuffled = [...ORDER_KEYS].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? 1 : -1));
      ok(await store.write(shuffled.map((k, i) => put("t", k, i))));
      const want = [...ORDER_KEYS].sort(referenceCompare);
      deepEq(keys(await store.range("t")), want);
      deepEq(keys(await store.range("t", { reverse: true })), [...want].reverse());
      // and the reference itself is the order written above
      deepEq(want, ORDER_KEYS);
    },
  },
  {
    name: "-0 and 0 are the same key",
    async run({ store }) {
      ok(await store.write([put("t", [-0], "neg")]));
      ok(await store.write([put("t", [0], "pos")]));
      deepEq((await store.range("t")).map((r) => r.value), ["pos"]);
      eq(await store.get("t", [-0]), "pos");
    },
  },
  {
    name: "range: prefix includes the key equal to it and its extensions, never siblings",
    async run({ store }) {
      const ks: StoreKey[] = [["a"], ["a", 1], ["a", 1, "x"], ["a", 2], ["a", "z"], ["a\u0000"], ["ab"], ["b"], [1], [1, "a"]];
      ok(await store.write(ks.map((k) => put("t", k, true))));
      deepEq(keys(await store.range("t", { prefix: ["a"] })), [["a"], ["a", 1], ["a", 1, "x"], ["a", 2], ["a", "z"]]);
      deepEq(keys(await store.range("t", { prefix: ["a", 1] })), [["a", 1], ["a", 1, "x"]]);
      deepEq(keys(await store.range("t", { prefix: [1] })), [[1], [1, "a"]]);
      deepEq(keys(await store.range("t", { prefix: [] })).length, ks.length);
      deepEq(await store.range("t", { prefix: ["c"] }), []);
    },
  },
  {
    name: "range: gt, gte, lt, lte compare on the full key, within the prefix",
    async run({ store }) {
      const ws = [];
      for (const cut of ["c1", "c2"]) for (let s = 1; s <= 20; s++) ws.push(put("changes", [cut, s], { cut, s }));
      ok(await store.write(ws));
      const seqs = (rows: { value: unknown }[]) => rows.map((r) => (r.value as { s: number }).s);
      deepEq(seqs(await store.range("changes", { prefix: ["c1"], gt: ["c1", 17] })), [18, 19, 20]);
      deepEq(seqs(await store.range("changes", { prefix: ["c1"], gte: ["c1", 17] })), [17, 18, 19, 20]);
      deepEq(seqs(await store.range("changes", { prefix: ["c2"], lt: ["c2", 3] })), [1, 2]);
      deepEq(seqs(await store.range("changes", { prefix: ["c2"], lte: ["c2", 3] })), [1, 2, 3]);
      deepEq(seqs(await store.range("changes", { prefix: ["c1"], gt: ["c1", 4], lte: ["c1", 6] })), [5, 6]);
      deepEq(seqs(await store.range("changes", { prefix: ["c1"], gt: ["c1", 25] })), []);
      // bounds outside the prefix never widen it
      deepEq(seqs(await store.range("changes", { prefix: ["c1"], gte: ["c0"] })).length, 20);
      deepEq(seqs(await store.range("changes", { prefix: ["c2"], lt: ["c3"] })).length, 20);
      // a bound that is a prefix of keys: gt ["c1"] is every c1 key (they extend it) and every c2 key
      eq((await store.range("changes", { gt: ["c1"] })).length, 40);
      eq((await store.range("changes", { gt: ["c1", 20] })).length, 20);
      eq((await store.range("changes", { lt: ["c2"] })).length, 20);
      eq((await store.range("changes", { lte: ["c2"] })).length, 20);
      // without a prefix
      deepEq(keys(await store.range("changes", { gte: ["c1", 20], lte: ["c2", 1] })), [["c1", 20], ["c2", 1]]);
    },
  },
  {
    name: "range: reverse and limit (the newest N changes of a cut)",
    async run({ store }) {
      ok(await store.write(Array.from({ length: 30 }, (_, i) => put("changes", ["c", i + 1], i + 1))));
      ok(await store.write([put("changes", ["d", 1], "other cut")]));
      deepEq((await store.range("changes", { prefix: ["c"], reverse: true, limit: 3 })).map((r) => r.value), [30, 29, 28]);
      deepEq((await store.range("changes", { prefix: ["c"], limit: 2 })).map((r) => r.value), [1, 2]);
      deepEq((await store.range("changes", { prefix: ["c"], lt: ["c", 10], reverse: true, limit: 2 })).map((r) => r.value), [9, 8]);
      deepEq((await store.range("changes", { prefix: ["c"], gt: ["c", 28], limit: 10 })).map((r) => r.value), [29, 30]);
      eq((await store.range("changes", { prefix: ["c"], limit: 1000 })).length, 30);
    },
  },
  {
    name: "tables are independent",
    async run({ store }) {
      ok(await store.write([put("a", ["k"], "in a"), put("b", ["k"], "in b")]));
      eq(await store.get("a", ["k"]), "in a");
      eq(await store.get("b", ["k"]), "in b");
      ok(await store.write([put("a", ["k"], undefined)]));
      eq(await store.get("b", ["k"]), "in b");
      deepEq(keys(await store.range("b")), [["k"]]);
    },
  },
  {
    name: "core's table names (STORE_TABLES), including camelCase ones",
    async run({ store }) {
      const names = ["meta", "cuts", "changes", "ids", "keyframes", "states", "lineage", "names", "pending", "pins", "notices", "views", "ephemeral", "lease", "pathMap"];
      ok(await store.write(names.map((t) => put(t, ["k"], t))));
      for (const t of names) eq(await store.get(t, ["k"]), t, t);
      ok(await store.write([put("pathmap", ["k"], "lower")]));
      eq(await store.get("pathMap", ["k"]), "pathMap", "table names are case-sensitive");
    },
  },
  {
    name: "within a batch writes apply in order: a later write to the same key wins",
    async run({ store }) {
      ok(await store.write([put("t", ["k"], 1), put("t", ["k"], 2), put("t", ["d"], "x"), put("t", ["d"], undefined), put("t", ["e"], undefined), put("t", ["e"], "back")]));
      eq(await store.get("t", ["k"]), 2);
      eq(await store.get("t", ["d"]), undefined);
      eq(await store.get("t", ["e"]), "back");
    },
  },
  {
    name: "conditions: absent, present, equals (canonical JSON: object key order does not matter)",
    async run({ store }) {
      ok(await store.write([put("t", ["k"], { a: 1, b: [1, { c: 2, d: 3 }] })]));
      ok(await store.write([put("t", ["x"], 1)], [{ table: "t", key: ["nope"], expect: "absent" }]));
      ok(await store.write([put("t", ["x"], 2)], [{ table: "t", key: ["k"], expect: "present" }]));
      ok(await store.write([put("t", ["x"], 3)], [{ table: "t", key: ["k"], expect: { equals: { b: [1, { d: 3, c: 2 }], a: 1 } } }]));
      eq(await store.write([put("t", ["x"], 4)], [{ table: "t", key: ["k"], expect: "absent" }]), false);
      eq(await store.write([put("t", ["x"], 5)], [{ table: "t", key: ["nope"], expect: "present" }]), false);
      eq(await store.write([put("t", ["x"], 6)], [{ table: "t", key: ["k"], expect: { equals: { a: 1, b: [1, { c: 2, d: 4 }] } } }]), false);
      eq(await store.write([put("t", ["x"], 7)], [{ table: "t", key: ["k"], expect: { equals: { a: 1 } } }]), false, "a subset is not equal");
      eq(await store.write([put("t", ["x"], 8)], [{ table: "t", key: ["nope"], expect: { equals: null } }]), false, "absent is not null");
      eq(await store.write([put("t", ["x"], 9)], [{ table: "other", key: ["k"], expect: "present" }]), false, "conditions name their table");
      eq(await store.get("t", ["x"]), 3);
    },
  },
  {
    name: "a batch with a failing condition writes nothing at all",
    async run({ store }) {
      ok(await store.write([put("t", ["keep"], "v1")]));
      const res = await store.write(
        [put("t", ["keep"], "v2"), put("t", ["new"], "n"), put("u", ["other-table"], "o"), put("t", ["keep"], undefined)],
        [{ table: "t", key: ["keep"], expect: "present" }, { table: "t", key: ["keep"], expect: "absent" }],
      );
      eq(res, false);
      eq(await store.get("t", ["keep"]), "v1");
      eq(await store.get("t", ["new"]), undefined);
      eq(await store.get("u", ["other-table"]), undefined);
    },
  },
  {
    name: "conditions see the state before the batch, not the batch's own writes",
    async run({ store }) {
      ok(await store.write([put("t", ["k"], "first")], [{ table: "t", key: ["k"], expect: "absent" }]));
      eq(await store.write([put("t", ["k"], "second")], [{ table: "t", key: ["k"], expect: "absent" }]), false);
      eq(await store.get("t", ["k"]), "first");
    },
  },
  {
    name: "concurrent writes on one handle: every batch is atomic and none is lost",
    async run({ store }) {
      await Promise.all(Array.from({ length: 50 }, (_, i) => store.write([put("t", ["n", i], i), put("t", ["m", i], -i)])));
      eq((await store.range("t", { prefix: ["n"] })).length, 50);
      eq((await store.range("t", { prefix: ["m"] })).length, 50);
    },
  },
  {
    name: "CAS append (the local sequencer): racing appenders on one handle lose nothing",
    async run({ store }) {
      await casAppenders([store, store, store, store], 25);
    },
  },
  {
    name: "CAS append across handles (processes, tabs): racing appenders lose nothing",
    async run(f) {
      if (!f.store.info.multiProcess) return;
      ok(f.another, "a multi-process store's suite options give `second`");
      const others = await Promise.all([f.another(), f.another(), f.another()]);
      await casAppenders([f.store, ...others], 25);
    },
  },
  {
    name: "another handle sees every write that resolved before its read",
    async run(f) {
      if (!f.store.info.multiProcess) return;
      ok(f.another, "a multi-process store's suite options give `second`");
      const b = await f.another();
      for (let i = 1; i <= 20; i++) {
        ok(await f.store.write([put("changes", ["c", i], i)]));
        deepEq(keys(await b.range("changes", { prefix: ["c"], reverse: true, limit: 1 })), [["c", i]]);
        eq(await b.get("changes", ["c", i]), i);
      }
      ok(await b.write([put("t", ["from-b"], 1)]));
      eq(await f.store.get("t", ["from-b"]), 1);
    },
  },
  {
    name: "watch fires after a successful write with its tables, never for a failed one",
    async run({ store }) {
      if (!store.watch) return;
      const seen: string[][] = [];
      const stop = store.watch((tables) => seen.push([...tables].sort()));
      ok(await store.write([put("a", ["k"], 1), put("b", ["k"], 1)]));
      eq(await store.write([put("c", ["k"], 1)], [{ table: "a", key: ["k"], expect: "absent" }]), false);
      stop();
      ok(await store.write([put("d", ["k"], 1)]));
      deepEq(seen, [["a", "b"]]);
    },
  },
  {
    name: "a persistent store keeps every resolved write across close and reopen",
    async run(f) {
      if (!f.store.info.persistent) return;
      ok(f.reopen, "a persistent store's suite options give `reopen`");
      ok(await f.store.write([put("changes", ["c", 1], { id: "r.1" }), put("meta", ["projectId"], "p1")]));
      ok(await f.store.write([put("changes", ["c", 2], { id: "r.2" })], [{ table: "changes", key: ["c", 2], expect: "absent" }]));
      const again = await f.reopen();
      deepEq((await again.range("changes", { prefix: ["c"] })).map((r) => r.value), [{ id: "r.1" }, { id: "r.2" }]);
      eq(await again.get("meta", ["projectId"]), "p1");
    },
  },
  {
    name: "large values (a 2 MB keyframe) and many rows round-trip in order",
    async run({ store }) {
      const items = Array.from({ length: 4000 }, (_, i) => ({ id: `item-${i}`, trackId: `t${i % 7}`, startTime: i * 0.5, endTime: i * 0.5 + 0.4, text: "x".repeat(400) }));
      ok(await store.write([put("keyframes", ["c", 64], { items })]));
      deepEq(await store.get("keyframes", ["c", 64]), { items });
      const N = 3000;
      for (let i = 0; i < N; i += 500) ok(await store.write(Array.from({ length: 500 }, (_, j) => put("changes", ["c", i + j + 1], { seq: i + j + 1 }))));
      const all = await store.range<{ seq: number }>("changes", { prefix: ["c"] });
      eq(all.length, N);
      ok(all.every((r, i) => r.value.seq === i + 1 && r.key[1] === i + 1));
    },
  },
  {
    name: "a bad key is refused, never stored under a different key",
    async run({ store }) {
      await rejects(async () => store.write([put("t", [NaN], 1)]), "NaN key");
      await rejects(async () => store.write([put("t", [Infinity], 1)]), "Infinity key");
      deepEq(await store.range("t"), []);
    },
  },
];

// The local sequencer's append: read the head, write head + 1 with an `absent` condition, retry on false.
async function casAppenders(handles: Store[], each: number): Promise<void> {
  let retries = 0;
  await Promise.all(
    handles.map(async (s, w) => {
      for (let i = 0; i < each; i++) {
        for (;;) {
          const last = await s.range<{ id: string }>("changes", { prefix: ["main"], reverse: true, limit: 1 });
          const head = last.length ? (last[0].key[1] as number) : 0;
          const id = `w${w}.${i}`;
          const done = await s.write([put("changes", ["main", head + 1], { id }), put("ids", [id], ["main", head + 1])], [{ table: "changes", key: ["main", head + 1], expect: "absent" }]);
          if (done) break;
          retries++;
        }
      }
    }),
  );
  const rows = await handles[0].range<{ id: string }>("changes", { prefix: ["main"] });
  const n = handles.length * each;
  eq(rows.length, n, "every append landed");
  ok(rows.every((r, i) => r.key[1] === i + 1), "seqs are contiguous from 1");
  eq(new Set(rows.map((r) => r.value.id)).size, n, "each append landed once");
  eq((await handles[0].range("ids")).length, n);
  void retries;
}
