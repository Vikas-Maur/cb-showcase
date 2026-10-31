// local-cli request 6: a process that adopts a cut switch another process stored (`meta ["current"]`) switches its
// handle without writing the switch again, so a third process's switch in the meantime stands. Two handles on one
// store are two processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0 } from "./fixture.ts";

test("switchTo(cut, { persist: false }) adopts a cut without writing the machine's current cut; switchTo(cut) still writes it", async () => {
  const store = createMemoryStore();
  const a = await Carton.open({ adapter, store, init: { doc: doc0() } });
  const b = await Carton.open({ adapter, store });
  const main = a.cut;
  // b makes a cut and switches the machine to it; a (the follower) reads `draft` as the stored current cut
  const draft = (await b.fork("draft")).id;
  await b.switchTo(draft);
  assert.equal(await store.get("meta", ["current"]), draft);
  // a third process switches back before the follower adopts what it read
  await b.switchTo(main);
  assert.equal(await store.get("meta", ["current"]), main);
  // the follower adopts `draft` (a cut made after it opened, known by its id) without writing it
  await a.switchTo(draft, { persist: false });
  assert.equal(a.cut, draft, "the handle is on the adopted cut");
  assert.equal((await a.head()).ref.branchId, draft);
  assert.equal(await store.get("meta", ["current"]), main, "the later switch stands");
  // an unknown cut throws, and writes nothing either way
  await assert.rejects(a.switchTo("no-such-cut", { persist: false }), /no cut/);
  await assert.rejects(b.switchTo("no-such-cut"), /no cut/);
  assert.equal(await store.get("meta", ["current"]), main);
  // the default still writes it, and a handle opened next starts there
  await b.switchTo(draft);
  assert.equal(await store.get("meta", ["current"]), draft);
  const c = await Carton.open({ adapter, store });
  assert.equal(c.cut, draft);
  await Promise.all([a.close(), b.close(), c.close()]);
});
