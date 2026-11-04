// Carton UX v2 for teammates (fix/ux2-open): Alice's Exported and Sent reach Bob through the sync server, as landmarks
// (never edits: no row, no version, no undo step); her Start and her Before stay hers; her bring-back of one clip on the
// shared cut reads as one at Bob's ("Brought back “B” from …"), and her restore says which version. Against an older
// server (a welcome without `landmarks`) nothing new is sent, and what waited goes once a server keeps landmarks.
// The real engine, the in-process host (@carton/server, the sequencer core every host runs) and the view model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, timeAlgebra, type Actor, type Doc, type Landmark, type Rec } from "@carton/core";
import type { AuthContext, AuthProvider, HostAdapter, Store, Transport } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { createMemoryStore } from "@carton/store-memory";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { fromCarton } from "../src/from-carton.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true, noun: "track" },
    items: { parent: { field: "trackId", collection: "tracks" }, noun: "clip", groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? (r as Rec | undefined)?.id ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, name: string): Rec => ({ id, trackId: "t1", startTime: s, endTime: s + 2, trimStart: 0, trimEnd: 2, name });
const doc0 = (): Doc => ({ tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0, "Intro"), clip("b", 2, "B-roll pier")] });
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", name: "Bob", group: "bob@desk" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => T | Promise<T>, what: string, ms = 8000): Promise<Exclude<T, false | null | undefined>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as Exclude<T, false | null | undefined>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/**
 * The host, and a transport like it as an older server would answer (`old`: its welcomes say nothing of landmarks,
 * and it never sends any), recording what the client sends.
 */
function world() {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name });
  const sent: string[] = [];
  /** The host's own transport, recording what the client sends; `drop()` closes its live connection (a network drop). */
  let live: { close(): void } | null = null;
  const watched: Transport = {
    async connect(url, opts) {
      const c = await host.transport.connect(url, opts);
      live = c;
      return {
        get open() {
          return c.open;
        },
        send: (m) => (sent.push(m.type), c.send(m)),
        onMessage: (l) => c.onMessage(l),
        onClose: (l) => c.onClose(l),
        close: () => c.close(),
      };
    },
  };
  const old: Transport = {
    async connect(url, opts) {
      const c = await host.transport.connect(url, opts);
      return {
        get open() {
          return c.open;
        },
        send: (m) => {
          sent.push(m.type);
          // an older server answers what it doesn't know with an error (no code): never reached here, as asserted
          if (m.type !== "landmark" && m.type !== "landmarks") c.send(m);
        },
        onMessage: (l) =>
          c.onMessage((m) => {
            if (m.type === "landmarks") return;
            if (m.type === "hello") delete (m as { landmarks?: true }).landmarks;
            l(m);
          }),
        onClose: (l) => c.onClose(l),
        close: () => c.close(),
      };
    },
  };
  const sync = (name: string, transport: Transport = host.transport) => {
    tokens.set(`tok-${name}`, { account: name, credential: `${name}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
    return { transport, url: host.url, token: `tok-${name}`, autoConnect: true };
  };
  return { host, sync, old, watched, sent, drop: () => live?.close() };
}

/** Bob's computer joins: Alice's history as the server has it (her own replica ids, identity and landmarks stay hers). */
async function join(from: Store): Promise<Store> {
  const sb = createMemoryStore();
  for (const t of ["cuts", "changes", "meta", "keyframes", "ids", "pins", "names"]) {
    const rows = (await from.range(t)).filter((r) => t !== "meta" || !["rid", "identity", "person"].includes(String(r.key[0])));
    if (rows.length) await sb.write(rows.map((r) => ({ table: t, key: r.key, value: JSON.parse(JSON.stringify(r.value)) })));
  }
  return sb;
}

const shared = (l: Landmark[]) => l.filter((x) => x.kind === "exported" || x.kind === "sent").map((x) => ({ kind: x.kind, label: x.label, by: x.by?.name ?? x.by?.id, local: x.local, personal: x.personal }));

test("Alice's Exported and Sent reach Bob as hers, never as edits; her Start and Before stay hers; her bring-back reads as one at Bob's", { timeout: 60_000 }, async () => {
  const w = world();
  const open: Carton[] = [];
  try {
    const sa = createMemoryStore();
    const first = await Carton.open({ adapter, store: sa, init: { doc: doc0(), projectId: "p" }, actor: alice, sync: w.sync("alice") });
    // an export before the cut is shared: it waits on her computer, and goes with the share
    await first.mark("exported", { by: alice, label: "Rough cut" });
    await first.share();
    await until(async () => (await first.cuts())[0]!.sequencer.kind === "server", "the hand-off");
    const sb = await join(sa);
    const a = first;
    const b = await Carton.open({ adapter, store: sb, actor: bob, sync: w.sync("bob") });
    open.push(a, b);
    await until(() => a.sync!.status === "up-to-date" && b.sync!.status === "up-to-date", "both connected");
    const cut = a.cut;
    await until(async () => shared(await b.landmarks()).length === 1, "the export from before the share, at Bob's");

    assert.equal((await a.commit({ ops: [set("b", "endTime", 3.5)], wait: 5000 })).status, "confirmed");
    const before = { head: (await b.head()).ref.seq, undo: (await b.undoStack()).length, log: (await b.log()).length };
    await a.mark("exported", { by: alice, label: "1080p for the client" });
    await a.mark("sent", { by: alice, label: "Shared with Leo" });
    await a.mark("start", { by: alice });
    const atBob = await until(async () => { const l = shared(await b.landmarks()); return l.length === 3 && l; }, "Alice's export and send at Bob's");
    assert.deepEqual(atBob.map((x) => `${x.kind}: ${x.label}`).sort(), ["exported: 1080p for the client", "exported: Rough cut", "sent: Shared with Leo"]);
    for (const x of atBob) assert.deepEqual([x.by, x.local, x.personal], ["Alice", false, false], JSON.stringify(x));
    const bobs = await b.landmarks();
    assert.ok(!bobs.some((x) => x.kind === "start"), "her Start stays hers");
    const onHead = bobs.find((x) => x.label === "1080p for the client")!;
    assert.equal(onHead.ref.seq, (await a.head()).ref.seq, "on the version she exported");
    // no edit: no version, no row, no undo step at Bob's
    assert.deepEqual({ head: (await b.head()).ref.seq, undo: (await b.undoStack()).length, log: (await b.log()).length }, before);
    // hers are no longer "only you see this" once the server has them
    await until(async () => shared(await a.landmarks()).every((x) => !x.local), "Alice's own, shared");

    // Bob's view model: the landmark rows, by Alice
    const ui = fromCarton(b, { me: bob });
    await ui.ready;
    const marks = await ui.landmarks!();
    const ex = marks.find((m) => m.label === "1080p for the client")!;
    assert.deepEqual([ex.kind, ex.by?.name, ex.by?.isYou ?? false, ex.local, ex.personal], ["exported", "Alice", false, false, false]);

    // a bring-back of one clip on the shared cut: one row at Bob's that says so
    const then = `${cut}@${(await a.head()).ref.seq - 1}`;
    const r = await a.restoreClip(then, ["items", "b"], { author: alice });
    assert.equal(r.brought.name, "B-roll pier");
    const done = r.status === "pending" ? await a.sync!.waitFor(r.id, 5000) : r;
    assert.equal(done.status, "confirmed");
    const at = (done as { seq: number }).seq;
    await until(async () => (await b.head()).ref.seq === at, "the bring-back at Bob's");
    const row = (await b.log({ limit: 1 }))[0]!;
    assert.deepEqual([row.kind, row.restoreRecord, row.restoreName, row.restoreOf], ["restore", "items/b", "B-roll pier", then]);
    await ui.refresh();
    await ui.settled();
    const h = ui.history();
    h.at("all", 0);
    await ui.settled();
    await sleep(20);
    assert.match(h.at("all", 0)!.summary, /^Brought back “B-roll pier” from \d{1,2}:\d{2} [ap]m$/, "Bob's row reads as a bring-back");
    // her Before is hers: a safety point at Alice's, none at Bob's
    assert.ok((await a.landmarks()).some((x) => x.kind === "before" && x.before === "bring-back" && x.personal));
    assert.ok(!(await b.landmarks()).some((x) => x.kind === "before"), "Bob sees the bring-back's row, not her safety point");

    // a whole restore says which version at Bob's
    const back = `${cut}@1`;
    const rr = await a.restore(back, { author: alice });
    const rd = rr.status === "pending" ? await a.sync!.waitFor(rr.id, 5000) : rr;
    assert.equal(rd.status, "confirmed");
    await until(async () => (await b.head()).ref.seq === (rd as { seq: number }).seq, "the restore at Bob's");
    assert.equal((await b.log({ limit: 1 }))[0]!.restoreOf, back);
  } finally {
    for (const c of open) await c.close();
  }
});

test("against an older server nothing new is sent; what waited goes once the server keeps landmarks", { timeout: 60_000 }, async () => {
  const w = world();
  const sa = createMemoryStore();
  const first = await Carton.open({ adapter, store: sa, init: { doc: doc0(), projectId: "p" }, actor: alice, sync: w.sync("alice") });
  await first.share();
  await until(async () => (await first.cuts())[0]!.sequencer.kind === "server", "the hand-off");
  await first.close();
  // Alice's next session talks to "an older server": her export stays on her computer, nothing about it is sent
  const a = await Carton.open({ adapter, store: sa, actor: alice, sync: w.sync("alice", w.old) });
  await until(() => a.sync!.status === "up-to-date", "connected to the older server");
  const l = await a.mark("exported", { by: alice, label: "Offline export" });
  assert.equal(l?.local, true);
  assert.equal((await a.commit({ ops: [set("a", "name", "Intro 2")], wait: 5000 })).status, "confirmed", "edits sync as always");
  await sleep(100);
  assert.deepEqual(w.sent.filter((t) => t === "landmark" || t === "landmarks"), [], "never sent to it");
  assert.ok(w.sent.includes("push"));
  assert.equal(shared(await a.landmarks())[0]?.local, true, "still only on her computer");
  await a.close();
  // her next session's server keeps landmarks: the export waiting goes, once, and Bob has it
  w.sent.length = 0;
  const a2 = await Carton.open({ adapter, store: sa, actor: alice, sync: w.sync("alice", w.watched) });
  const b = await Carton.open({ adapter, store: await join(sa), actor: bob, sync: w.sync("bob") });
  try {
    await until(async () => shared(await b.landmarks()).length === 1, "the waiting export at Bob's");
    assert.deepEqual(shared(await b.landmarks()), [{ kind: "exported", label: "Offline export", by: "Alice", local: false, personal: false }]);
    await until(async () => shared(await a2.landmarks())[0]?.local === false, "hers, shared");
    assert.deepEqual(w.sent.filter((t) => t === "landmark" || t === "landmarks"), ["landmarks", "landmark"], "asked, then sent the one waiting");
    // a dropped connection: the next one asks again and sends nothing again
    w.sent.length = 0;
    w.drop();
    await until(() => w.sent.includes("landmarks"), "the next connection's ask", 10_000);
    await sleep(200);
    assert.deepEqual(w.sent.filter((t) => t === "landmark" || t === "landmarks"), ["landmarks"]);
    assert.equal(shared(await b.landmarks()).length, 1, "still one");
  } finally {
    await a2.close();
    await b.close();
  }
});
