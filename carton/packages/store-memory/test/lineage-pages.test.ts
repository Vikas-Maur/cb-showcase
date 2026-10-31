// SF1-8: a teammate who joins a shared cut pages through its whole ancestry closure (the server sends it by its byte
// budget: `lineageFrom` / `lineageNext`, hosts-plugins' dd8e0ee). Against the in-process host of @carton/server with a
// small budget, so a closure with several carried states takes several pages on a server that pages; the client
// follows every cursor, and the joiner ends with the sharer's fork point and credits either way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, hashDoc, type Actor } from "@carton/core";
import type { Transport } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, schema, set } from "./fixture.ts";
import { until, world } from "./world.ts";

const alice: Actor = { kind: "human", id: "alice", group: "alice@laptop" };
const carol: Actor = { kind: "human", id: "carol", group: "carol@studio" };
const director = (turn: string): Actor => ({ kind: "agent", id: "director", name: "Director", group: "alice@laptop/director", turn });

test("SF1-8: a joiner pages through a closure larger than the server's budget and sees the same fork point and credits", async (t) => {
  const w = world({ catchupBytes: 1500 });
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: alice, sync: w.sync("alice") });
  const draft = a.cut;
  // a draft with three folded variants: its closure carries a state for each fork and fold
  for (const [i, id] of ["a", "b", "c"].entries()) {
    const v = await a.fork(`idea ${i}`);
    await a.commit({ cut: v.id, ops: [set(id, "name", `idea ${i} `.repeat(30))], author: director(`t${i}`) });
    assert.equal((await a.fold(v.id, { into: draft })).status, "confirmed");
    await a.switchTo(draft);
  }
  const short = await a.fork("30s cut");
  await a.commit({ cut: short.id, ops: [set("d", "name", "Tag")] });
  await a.share(short.id);
  await until(async () => (await a.cuts()).find((x) => x.id === short.id)!.sequencer.kind === "server", 5000, "the hand-off");
  // carol joins from an invite, counting the history requests and the lineage cursors that come back
  let asked = 0,
    cursors = 0,
    optedIn = 0;
  const transport: Transport = {
    async connect(url, o) {
      const c = await w.host.transport.connect(url, o);
      return {
        get open() {
          return c.open;
        },
        send: (m) => (m.type === "history" && m.lineage && (asked++, m.lineageFrom && optedIn++), c.send(m)),
        onMessage: (l) => c.onMessage((m) => (m.type === "history" && m.lineageNext && cursors++, l(m))),
        onClose: (l) => c.onClose(l),
        close: () => c.close(),
      };
    },
  };
  const rec = (await a.cuts()).find((c) => c.id === short.id)!;
  const root = await a.checkout(`${short.id}@0`);
  const d = await Carton.open({ adapter, store: createMemoryStore(), init: { join: { projectId: a.projectId, cut: rec, doc0: root, rootHash: hashDoc(root, schema) } }, actor: carol, sync: { ...w.sync("carol"), transport } });
  await until(async () => (await d.credits(["items", "c"], { cut: short.id }))?.id === "director", 5000, "the lineage at the joiner");
  assert.equal(optedIn, asked, "every lineage request asks for a page (a server that pages answers by its budget)");
  assert.equal(asked, cursors + 1, "every cursor followed, and no request past the last page");
  assert.equal((await d.cuts()).find((x) => x.id === short.id)!.forkOf, rec.forkOf, "its fork point");
  for (const id of ["a", "b", "c", "d", "e"]) assert.deepEqual(await d.credits(["items", id], { cut: short.id }), await a.credits(["items", id], { cut: short.id }), `credits of ${id}`);
  t.diagnostic(`${asked} lineage page(s) asked for, ${cursors} cursor(s) followed`);
  await a.close();
  await d.close();
  w.host.close();
});
