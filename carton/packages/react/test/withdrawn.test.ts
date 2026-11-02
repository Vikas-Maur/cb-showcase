// A withdraw row (H1) is never a version on screen. Alice's edit is sent, Bob makes the same edit and his lands first:
// her rebase leaves nothing, her client withdraws the id, and the server fans out an empty row authored
// `{kind: "system", id: "withdraw"}`. History (and so the Compare, preview and restore pickers, which pick from its
// rows) shows Bob's edit and nothing for the withdraw, whether the view model saw it arrive or loaded it later; a real
// version after it shows as usual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { AuthContext, AuthProvider, HostAdapter, Transport, TransportConnection } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { createMemoryStore } from "@carton/store-memory";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { fromCarton } from "../src/from-carton.ts";
import type { Version } from "../src/model.ts";

type CartonUi = ReturnType<typeof fromCarton>;

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number): Rec => ({ id, trackId: "t1", startTime: s, endTime: s + 2, trimStart: 0, trimEnd: 2, name: id });
const doc0 = (): Doc => ({ tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0), clip("b", 2)] });
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", name: "Bob", group: "bob@desk" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
function world() {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name });
  const sync = (name: string) => {
    tokens.set(`tok-${name}`, { account: name, credential: `${name}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
    return { transport: host.transport, url: host.url, token: `tok-${name}`, autoConnect: true };
  };
  return { host, sync };
}
/** The host's transport, except that pushes are held back while `hold()` is on (withdraws go through). */
function gated(t: Transport) {
  const queue: { c: TransportConnection; m: Parameters<TransportConnection["send"]>[0] }[] = [];
  let open = true;
  const transport: Transport = {
    async connect(url, opts) {
      const c = await t.connect(url, opts);
      return {
        get open() {
          return c.open;
        },
        send: (m) => (open || m.type !== "push" ? c.send(m) : void queue.push({ c, m })),
        onMessage: (l) => c.onMessage(l),
        onClose: (l) => c.onClose(l),
        close: () => c.close(),
      };
    },
  };
  return {
    transport,
    hold: () => void (open = false),
    release: () => {
      open = true;
      for (const { c, m } of queue.splice(0)) if (c.open) c.send(m);
    },
  };
}
const rowsOf = (ui: CartonUi): Version[] => {
  const h = ui.history();
  return Array.from({ length: h.count("all") }, (_, i) => h.at("all", i)!);
};

test("History never shows a withdraw row, live or loaded, and a later real version shows as usual", { timeout: 30_000 }, async () => {
  const w = world();
  const uis: CartonUi[] = [];
  const cartons: Carton[] = [];
  try {
    const sa = createMemoryStore();
    const first = await Carton.open({ adapter, store: sa, init: { doc: doc0(), projectId: "p" }, actor: alice, sync: w.sync("alice") });
    await first.share();
    await until(async () => (await first.cuts())[0]!.sequencer.kind === "server", "the hand-off");
    const cut = first.cut;
    const sb = createMemoryStore();
    for (const t of ["cuts", "changes", "meta", "keyframes", "ids", "pins", "names"]) {
      const rows = await sa.range(t);
      if (rows.length) await sb.write(rows.map((r) => ({ table: t, key: r.key, value: JSON.parse(JSON.stringify(r.value)) })));
    }
    await first.close();
    const gate = gated(w.host.transport);
    const a = await Carton.open({ adapter, store: sa, actor: alice, sync: { ...w.sync("alice"), transport: gate.transport } });
    const b = await Carton.open({ adapter, store: sb, actor: bob, sync: w.sync("bob") });
    cartons.push(a, b);
    await until(() => a.sync!.status === "up-to-date" && b.sync!.status === "up-to-date", "both connected");
    // both screens open before the withdraw: they see it arrive as a `change` event
    const liveA = fromCarton(a, { me: alice });
    const liveB = fromCarton(b, { me: bob });
    uis.push(liveA, liveB);
    await Promise.all([liveA.ready, liveB.ready]);

    gate.hold();
    const r = await a.commit({ ops: [set("a", "name", "Same")] });
    assert.equal(r.status, "pending");
    const id = r.status === "pending" ? r.id : "";
    await until(async () => !!(await sa.get<{ sentBases?: number[] }>("pending", [cut, id]))?.sentBases?.length, "alice's edit sent");
    assert.equal((await b.commit({ ops: [set("a", "name", "Same")], wait: 5000 })).status, "confirmed");
    assert.equal((await a.sync!.waitFor(id, 5000)).status, "absorbed");
    gate.release();
    assert.equal(w.host.sequencer.stats.withdraws, 1);
    await until(async () => (await b.head()).ref.seq === (await a.head()).ref.seq && (await b.head()).ref.seq > 1, "the withdraw row at bob's");
    const wseq = (await b.head()).ref.seq;
    for (const ui of uis) await ui.settled();

    // and a screen opened after it: History loaded from log()
    const loadedB = fromCarton(b, { me: bob });
    uis.push(loadedB);
    await loadedB.ready;
    await loadedB.settled();

    const check = (ui: CartonUi, label: string, want: number[]) => {
      const rows = rowsOf(ui);
      assert.deepEqual(rows.map((v) => v.seq), want, `${label}: ${JSON.stringify(rows.map((v) => [v.seq, v.id, v.author.kind]))}`);
      assert.ok(!rows.some((v) => v.id === id || v.ref === `${cut}@${wseq}` || (v.seq !== 0 && v.author.kind === "system")), `${label}: no withdraw row`);
      assert.ok(!rows.some((v) => v.provisional), `${label}: alice's provisional row went with the absorb`);
      assert.equal(ui.history().indexOf("all", id), -1, `${label}: nothing to pick for Compare, preview or restore`);
    };
    for (const [ui, label] of [[liveA, "alice live"], [liveB, "bob live"], [loadedB, "bob loaded"]] as const) check(ui, label, [wseq - 1, 0]);

    // a real version after the withdraw: on every screen, at its own seq, Bob's, comparable to the one before the gap
    assert.equal((await b.commit({ ops: [set("b", "name", "After")], wait: 5000 })).status, "confirmed");
    await until(async () => (await a.head()).ref.seq === wseq + 1, "bob's later edit at alice's");
    for (const ui of uis) await ui.settled();
    for (const [ui, label] of [[liveA, "alice live"], [liveB, "bob live"], [loadedB, "bob loaded"]] as const) {
      check(ui, label, [wseq + 1, wseq - 1, 0]);
      const top = ui.history().at("all", 0)!;
      assert.equal(top.author.name, "Bob", label);
      assert.equal(top.kind, "edit", label);
      // Compare across the gap: both sides are the real versions, each with its author
      const below = ui.history().at("all", 1)!;
      const cmp = await ui.compare(below.ref, top.ref);
      assert.deepEqual([cmp.a.ref, cmp.b.ref], [below.ref, top.ref], label);
      assert.deepEqual([cmp.a.author.name, cmp.b.author.name], ["Bob", "Bob"], label);
    }
  } finally {
    for (const ui of uis) ui.dispose();
    for (const c of cartons) await c.close();
    w.host.close();
  }
});
