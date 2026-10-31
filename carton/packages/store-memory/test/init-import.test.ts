// local-cli request 7: `init: { doc, asChange: true }` (§16 migration) makes the empty root and the import change
// main@1. They are one store write, so a process stopped while creating the project leaves either nothing (the next
// open creates it) or the whole project, never an empty project that later opens take as made. A project an older
// build left at its empty root is finished by the next open with `asChange`. Two handles on one store are two processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { createMemoryData, createMemoryStore } from "../src/index.ts";
import { adapter, doc0 } from "./fixture.ts";

const empty = () => ({ tracks: [], items: [] });
const kinds = async (c: Carton) => (await c.log()).map((v) => [v.ref.seq, v.kind]);

test("init asChange writes the project's root and its import change in one store write", async () => {
  const store = createMemoryStore();
  const write = store.write.bind(store);
  const batches: string[][] = [];
  store.write = (async (w: Parameters<Store["write"]>[0], cond?: Parameters<Store["write"]>[1]) => {
    batches.push(w.map((x) => `${x.table}:${x.key[0]}`));
    return write(w, cond);
  }) as Store["write"];
  const c = await Carton.open({ adapter, store, init: { doc: doc0(), asChange: true } });
  assert.deepEqual(await kinds(c), [[1, "import"], [0, "root"]]);
  const first = batches.findIndex((b) => b.includes("meta:project"));
  assert.ok(first >= 0);
  assert.ok(batches[first]!.includes(`changes:${c.cut}`), "the import change is in the batch that makes the project");
  assert.ok(batches[first]!.includes("ids:import." + c.projectId));
  assert.ok(!batches.slice(first + 1).some((b) => b.includes(`changes:${c.cut}`)), "and in no later batch");
  await c.close();
});

test("a process stopped while making an asChange project leaves no project, and the next open imports", async () => {
  const store = createMemoryStore();
  const write = store.write.bind(store);
  store.write = (async (w: Parameters<Store["write"]>[0], cond?: Parameters<Store["write"]>[1]) => {
    if (w.some((x) => x.table === "changes")) throw new Error("stopped here");
    return write(w, cond);
  }) as Store["write"];
  await assert.rejects(Carton.open({ adapter, store, init: { doc: doc0(), asChange: true } }), /stopped here/);
  store.write = write;
  assert.equal(await store.get("meta", ["project"]), undefined, "nothing stored: the root never lands without its import");
  const c = await Carton.open({ adapter, store, init: { doc: doc0(), asChange: true } });
  assert.deepEqual(await kinds(c), [[1, "import"], [0, "root"]]);
  assert.deepEqual((await c.head()).doc.items, doc0().items);
  await c.close();
});

test("Carton.open resumes an init whose import change never landed (a project an older build left at its empty root)", async () => {
  const store = createMemoryStore();
  // the empty root without its import: what a process stopped between the two writes of an older build left
  const a = await Carton.open({ adapter, store, init: { doc: empty(), asChange: false } });
  const projectId = a.projectId;
  await a.close();
  // opened without asChange: left as it is
  const plain = await Carton.open({ adapter, store, init: { doc: doc0() } });
  assert.deepEqual(await kinds(plain), [[0, "root"]]);
  await plain.close();
  const b = await Carton.open({ adapter, store, init: { doc: doc0(), asChange: true } });
  assert.equal((await b.head()).ref.seq, 1, "core finishes its own two-step init");
  assert.deepEqual(await kinds(b), [[1, "import"], [0, "root"]]);
  assert.equal((await b.log())[0]!.change, `import.${projectId}`);
  assert.deepEqual((await b.head()).doc.items, doc0().items);
  await b.close();
  // opened again with asChange: nothing more
  const again = await Carton.open({ adapter, store, init: { doc: doc0(), asChange: true } });
  assert.deepEqual(await kinds(again), [[1, "import"], [0, "root"]]);
  await again.close();
});

test("two processes finishing the same empty project's import record it once", async () => {
  const data = createMemoryData();
  const a = await Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: empty() } });
  await a.close();
  const [x, y] = await Promise.all([0, 1].map(() => Carton.open({ adapter, store: createMemoryStore({ shared: data }), init: { doc: doc0(), asChange: true } })));
  for (const c of [x!, y!]) assert.deepEqual(await kinds(c), [[1, "import"], [0, "root"]]);
  await x!.close();
  await y!.close();
});

test("asChange imports into nothing but an empty project at its root: an edit, a non-empty root or a second cut stand", async () => {
  // an edit already on the empty root
  const s1 = createMemoryStore();
  const a = await Carton.open({ adapter, store: s1, init: { doc: empty() } });
  assert.equal((await a.commit({ ops: [{ op: "insert", path: ["tracks", "t1"], value: { id: "t1" } }] })).status, "confirmed");
  await a.close();
  const a2 = await Carton.open({ adapter, store: s1, init: { doc: doc0(), asChange: true } });
  assert.deepEqual((await kinds(a2)).map(([, k]) => k), ["edit", "root"]);
  await a2.close();
  // a root that isn't empty (a project made with its doc as the root)
  const s2 = createMemoryStore();
  await (await Carton.open({ adapter, store: s2, init: { doc: doc0() } })).close();
  const b = await Carton.open({ adapter, store: s2, init: { doc: { ...doc0(), name: "Other" }, asChange: true } });
  assert.deepEqual(await kinds(b), [[0, "root"]]);
  await b.close();
  // a second cut on the empty project
  const s3 = createMemoryStore();
  const c = await Carton.open({ adapter, store: s3, init: { doc: empty() } });
  await c.fork("Alt");
  await c.close();
  const c2 = await Carton.open({ adapter, store: s3, init: { doc: doc0(), asChange: true } });
  assert.equal((await c2.head()).ref.seq, 0);
  await c2.close();
});

test("an import of an empty doc is recorded once as a no-op, and later opens stay quiet", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: empty(), asChange: true } });
  assert.deepEqual(await kinds(c), [[0, "root"]]);
  await c.close();
  const again = await Carton.open({ adapter, store, init: { doc: empty(), asChange: true } });
  assert.ok((await kinds(again)).every(([, k]) => k !== "import"));
  await again.close();
});
