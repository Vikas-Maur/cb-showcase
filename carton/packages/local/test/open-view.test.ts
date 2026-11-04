// `cb compare … --show` (Carton UX v2, the `open` write): an ask to the app's pages, through the app's lease holder. On
// the laptop one ask in three answered "No editor window has this project open" while the editor had it open and was
// comparing. Two ways it got there, both fixed here:
//   - the holder ran the ask as a write: the cb-call freeze first (the materializer's queue, behind its file work), and
//     the asker's notices after. A freeze step that failed or ran long failed the ask, which cb read as no window;
//   - the app's holder didn't answer that moment (its loop busy, or a helper holding the lease for a moment): cb
//     concluded at once that no editor had the project open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { Carton } from "@carton/core";
import type { Actor } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { openLocal, SHOW_ANSWER_MS, SHOW_ASK_MS } from "../src/open.ts";
import { Holder, holderSocketPath } from "../src/holder.ts";
import { actorKey, runWrite } from "../src/writes.ts";
import type { ViewPrinter } from "../src/writes.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const terminal: Actor = { kind: "external", id: "terminal:me@laptop", name: "Terminal", group: "local:me@laptop" };
const ask = { kind: "open" as const, view: "compare" as const, from: "main@1", to: "main@2" };

test("runWrite `open`: the pages' answer, never held up by the materializer's freeze; the asker's notices stay for its next call", async () => {
  const store = createMemoryStore();
  const c = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: { kind: "system", id: "engine" } });
  try {
    await store.write([{ table: "notices", key: [actorKey(terminal), 1000, 0], value: { to: actorKey(terminal), kind: "late-conflict", change: "r.1", text: "Your change r.1 conflicted", cards: [] } }]);
    let onCbs = 0, asked = 0;
    // a materializer whose freeze step fails (on Windows: its file work behind EPERM) or would never end
    const mz: ViewPrinter = {
      printView: async () => ({ path: "x", status: "y" }) as never,
      onCb: async () => { onCbs++; throw Object.assign(new Error("EPERM: operation not permitted, rename 'timeline.tsx'"), { code: "EPERM" }); },
      openView: async () => { asked++; return { opened: 1, shown: { status: "offered", why: "comparing" } }; },
    };
    const r = await runWrite(c, { id: "o.1", actor: terminal, op: ask }, { materializer: mz });
    assert.equal(r.status, "confirmed", JSON.stringify(r));
    assert.deepEqual([(r as { opened?: number }).opened, (r as { shown?: unknown }).shown, asked], [1, { status: "offered", why: "comparing" }, 1]);
    assert.equal(onCbs, 0, "an ask is no cb write: no freeze");
    assert.deepEqual(r.notices, [], "nothing shows the notices with a comparison");
    mz.onCb = async () => {};
    const next = await runWrite(c, { id: "o.2", actor: terminal, op: { kind: "pin", owner: "x" } }, { materializer: mz });
    assert.deepEqual(next.notices.map((n) => n.change), ["r.1"], "delivered with the asker's next cb call");
  } finally {
    await c.close();
  }
});

/** The app's holder (kind "worker"): it answers an ask with the pages that have the project open. */
const appHolder = (h: Awaited<ReturnType<typeof openLocal>>, pages = 1) =>
  new Holder({
    lease: h.lease,
    kind: "worker",
    socketPath: holderSocketPath(dirname(h.dbPath), "worker"),
    engine: { serve: async () => ({ status: "confirmed", seq: 0, ref: null, notices: [], opened: pages }) },
  });

test("open: the app holds the project but its holder doesn't answer this moment: asked again, never 'no editor window'", { timeout: 30_000 }, async () => {
  const { dir, projectId } = bundle("open-view");
  const cb = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: terminal });
  let app: Holder | null = null;
  try {
    // the lease as the app left it a moment ago (its last beat fresh), its socket not answering right now
    await cb.lease.take(null, { pid: process.pid, socketPath: join(dirname(cb.dbPath), "gone.sock"), kind: "worker" });
    const asked = cb.write(ask, { actor: terminal });
    // the app's holder answers again (here: takes the lease back) 700 ms into the ask
    await new Promise((r) => setTimeout(r, 700));
    app = appHolder(cb);
    assert.equal(await app.start(), true);
    const r = (await asked) as { status: string; opened?: number };
    assert.deepEqual([r.status, r.opened], ["confirmed", 1], JSON.stringify(r));
  } finally {
    await app?.retire("test over");
    await cb.close();
  }
});

test("open: no app holds the project: 'no editor window' at once; an app that never answers: said so after a while", { timeout: 30_000 }, async () => {
  const { dir, projectId } = bundle("open-view-none");
  const cb = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: terminal });
  try {
    let t0 = Date.now();
    const none = (await cb.write(ask, { actor: terminal })) as { opened?: number; unanswered?: boolean };
    assert.deepEqual([none.opened, none.unanswered], [0, undefined]);
    assert.ok(Date.now() - t0 < 1500, `no waiting without an app: ${Date.now() - t0} ms`);
    // the app's lease, fresh, its holder never answering: asked for a while, then said as unanswered (not "no window")
    await cb.lease.take(null, { pid: process.pid, socketPath: join(dirname(cb.dbPath), "gone.sock"), kind: "worker" });
    t0 = Date.now();
    const silent = (await cb.write(ask, { actor: terminal })) as { opened?: number; unanswered?: boolean };
    assert.deepEqual([silent.opened, silent.unanswered], [0, true]);
    assert.ok(Date.now() - t0 >= 3000, `asked again for a while: ${Date.now() - t0} ms`);
  } finally {
    await cb.close();
  }
});


test("open (review of fix/ux2-laptop #4): an ask again that the app's holder takes and never answers holds cb no longer than what was left and the page's time", { timeout: 60_000 }, async () => {
  const { dir, projectId } = bundle("open-view-hung");
  const cb = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: terminal });
  let calls = 0;
  // the app's holder: the first ask refused (busy), the next taken and never answered
  const app = new Holder({
    lease: cb.lease,
    kind: "worker",
    socketPath: holderSocketPath(dirname(cb.dbPath), "worker"),
    engine: { serve: () => (++calls === 1 ? Promise.reject(Object.assign(new Error("busy a moment"), { code: "BUSY" })) : new Promise(() => {})) },
  });
  try {
    assert.equal(await app.start(), true);
    const t0 = Date.now();
    const r = (await cb.write(ask, { actor: terminal })) as { opened?: number; unanswered?: boolean };
    const ms = Date.now() - t0;
    assert.ok(calls >= 2, `asked again: ${calls}`);
    assert.deepEqual([r.opened, r.unanswered], [0, true]);
    assert.ok(ms < SHOW_ASK_MS + SHOW_ANSWER_MS + 2000, `held ${ms} ms (the RPC's own 20 s was the bound before)`);
  } finally {
    await app.retire("test over");
    await cb.close();
  }
});
