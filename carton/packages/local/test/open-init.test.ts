// openLocal({ init }): a new project's first state is in its history (kit-docs): `main@1`, one insert-all change by
// core's import actor, so `cb history` and credits show where the starting state came from. `asChange: false` keeps
// it the root state at `main@0`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openLocal } from "../src/open.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const me = { kind: "human" as const, id: "human:me", name: "me" };

test("openLocal's init is main@1, one change in history with an author", async () => {
  const { dir, projectId } = bundle("open-init");
  const lc = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: me });
  try {
    const head = await lc.carton.head();
    assert.equal(head.ref.seq, 1);
    assert.deepEqual(head.doc.timelineItems, doc0().timelineItems, "head is the doc given");
    const log = (await lc.carton.log({ limit: 10 })).filter((v) => v.kind !== "root");
    assert.equal(log.length, 1, JSON.stringify(log));
    assert.deepEqual([log[0]!.ref.seq, log[0]!.kind], [1, "import"]);
    assert.deepEqual([log[0]!.author?.kind, log[0]!.author?.id], ["system", "import"], "credited to the import");
  } finally {
    await lc.close();
  }
});

test("openLocal's init with asChange: false is the root state at main@0, as before", async () => {
  const { dir, projectId } = bundle("open-init-root");
  const lc = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0(), asChange: false }, actor: me });
  try {
    assert.equal((await lc.carton.head()).ref.seq, 0);
    assert.equal((await lc.carton.log({ limit: 10 })).filter((v) => v.ref.seq > 0).length, 0);
  } finally {
    await lc.close();
  }
});
