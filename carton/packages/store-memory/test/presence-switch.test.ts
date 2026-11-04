// Presence P2 (review): a handle's presence shows on its current cut. Switching to another cut withdraws it from the
// one it leaves, so a host never tells a teammate who subscribes there later that this person is still on it (their
// Share panel then kept them there after they closed the editor on the cut they had moved to).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor } from "@carton/core";
import type { Transport } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0 } from "./fixture.ts";
import { until, world } from "./world.ts";

test("switching cuts withdraws this handle's presence from the cut it leaves, once; a leave stays a leave", { timeout: 30_000 }, async () => {
  const w = world();
  const base = w.sync("alice");
  const sent: { branchId: string; state: unknown }[] = [];
  // what this handle sends, as the host gets it
  const transport: Transport = {
    async connect(url, o) {
      const c = await base.transport.connect(url, o);
      return {
        get open() { return c.open; },
        send: (m) => { if (m.type === "presence") sent.push({ branchId: m.branchId, state: m.state }); c.send(m); },
        onMessage: (l) => c.onMessage(l),
        onClose: (l) => c.onClose(l),
        close: () => c.close(),
      };
    },
  };
  const me: Actor = { kind: "human", id: "person", group: "alice@laptop" };
  const a = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "p" }, actor: me, sync: { ...base, transport } });
  await a.setIdentity({ id: "alice", name: "Alice" });
  await a.share();
  const main = (await a.cuts())[0]!.id;
  const variant = (await a.fork("variant")).id;
  await a.share(variant);
  await until(async () => (await a.cuts()).every((c) => c.sequencer.kind === "server"), 5000, "both cuts shared");
  await a.sync!.connect({});
  const on = (b: string) => sent.filter((m) => m.branchId === b).map((m) => m.state);
  await a.switchTo(variant);
  a.sync!.presence({ at: 1 });
  await until(() => on(variant).length === 1, 2000, "presence on the variant");
  await a.switchTo(main);
  await until(() => on(variant).length === 2, 2000, "the leave on the variant");
  assert.deepEqual(on(variant), [{ at: 1 }, null]);
  assert.deepEqual(on(main), [], "nothing said on main until the page speaks");
  a.sync!.presence({ at: 2 });
  await until(() => on(main).length === 1, 2000, "presence on main");
  // a leave on main, then a switch: nothing more to withdraw anywhere
  a.sync!.presence(null);
  await until(() => on(main).length === 2, 2000, "the leave on main");
  await a.switchTo(variant);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(on(main), [{ at: 2 }, null]);
  assert.deepEqual(on(variant), [{ at: 1 }, null]);
  await a.close();
  w.host.close();
});
