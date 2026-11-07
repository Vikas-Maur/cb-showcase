// A teammate's version that comes to History live reads by person once described (from-carton's summarize tells its
// author as log() does): over the real engine, two replicas syncing through the in-process host, Leo's GUI save and
// Leo's Claude Code's version come to Vikas's History live as recorded ("Teammate", and an unowned "Claude Code" that
// reads like Vikas's own agent), and read "Leo" and "Leo's Claude Code" (in Leo's colour) once described; Vikas's own
// versions keep their actors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, hashDoc, timeAlgebra, type Actor as CoreActor, type Doc, type Rec } from "@carton/core";
import type { AuthContext, AuthProvider, HostAdapter } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { createMemoryStore } from "@carton/store-memory";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { actorColor, actorLabel } from "../src/actors.ts";
import { fromCarton } from "../src/from-carton.ts";

const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, noun: "clip", nounOf: (r) => (r.type === "text" ? "title" : undefined), groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number, o: Partial<Rec> = {}): Rec => ({ id, trackId: "t1", startTime: s, endTime: s + 2, trimStart: 0, trimEnd: 2, name: id, ...o });
const doc0 = (): Doc => ({ tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0), clip("b", 2)] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

test("a teammate's live versions read by person once described (Leo, Leo's Claude Code, in Leo's colour); yours stay", { timeout: 30_000 }, async () => {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name });
  const sync = (name: string) => {
    tokens.set(`tok-${name}`, { account: name, credential: `${name}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
    return { transport: host.transport, url: host.url, token: `tok-${name}`, autoConnect: true };
  };
  // each app records its GUI saves as the generic person in its machine's group; setIdentity says who that is
  const vikasPerson: CoreActor = { kind: "human", id: "person", group: "local:vikas@laptop" };
  const leoPerson: CoreActor = { kind: "human", id: "person", group: "local:leo@studio" };
  const vikasClaude: CoreActor = { kind: "agent", id: "claude-code/787d66ff", name: "Claude Code", provider: "claude-code", group: "local:vikas@laptop" };
  const leoClaude: CoreActor = { kind: "agent", id: "claude-code/1c0e5a9b", name: "Claude Code", provider: "claude-code", group: "local:leo@studio" };
  const vikas = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "p" }, actor: vikasPerson, sync: sync("vikas") });
  await vikas.setIdentity({ id: "vikas", name: "Vikas" });
  await vikas.share();
  await until(async () => (await vikas.cuts())[0]!.sequencer.kind === "server", "the hand-off");
  const cut = (await vikas.cuts())[0]!;
  const root = await vikas.checkout(`${cut.id}@0`);
  const leoC = await Carton.open({ adapter, store: createMemoryStore(), init: { join: { projectId: "p", cut, doc0: root, rootHash: hashDoc(root, schema) } }, actor: leoPerson, sync: sync("leo") });
  await leoC.setIdentity({ id: "leo", name: "Leo Park" });
  const ui = fromCarton(vikas, { me: { kind: "human", id: "vikas", name: "Vikas", group: "local:vikas@laptop" } });
  await ui.ready;
  try {
    const set = (id: string, f: string, val: unknown) => ({ op: "set" as const, path: ["items", id, f], value: val });
    // History open; then Vikas's own edit and his Claude Code's, Leo's GUI save and Leo's Claude Code's title, live
    assert.equal((await vikas.commit({ ops: [set("a", "endTime", 1.5), set("a", "trimEnd", 1.5)], wait: 5000 })).status, "confirmed");
    assert.equal((await vikas.commit({ ops: [set("b", "startTime", 2.5)], author: vikasClaude, wait: 5000 })).status, "confirmed");
    assert.equal((await leoC.commit({ ops: [set("b", "endTime", 4.5), set("b", "trimEnd", 2)], wait: 5000 })).status, "confirmed");
    assert.equal((await leoC.commit({ ops: [{ op: "insert", path: ["items", "t"], value: clip("t", 1, { type: "text", name: "Summer launch" }) }], author: leoClaude, wait: 5000 })).status, "confirmed");
    const h = ui.history();
    const byKey = ui.actor.bind(ui);
    const rows = () => h.all!().slice(-4);
    await until(async () => (await ui.settled(), rows().length === 4 && rows()[3]!.author.kind === "agent" && !rows()[3]!.author.isYou), "Leo's Claude Code's version at Vikas's");
    const was = rows().map((x) => x.author);
    // live, as recorded: what the panel read before (Leo's generic person, his agent without its person)
    assert.deepEqual(was.map((a) => actorLabel(a, byKey, "You")), ["You", "Claude Code", "Teammate", "Claude Code"]);
    // the panel shows them: each is described, and told by person
    for (let i = 0; i < 4; i++) h.at("all", i);
    await until(async () => (await ui.settled(), rows().every((x) => !!x.summary)), "the rows described");
    const now = rows().map((x) => x.author);
    assert.deepEqual(now.map((a) => actorLabel(a, byKey, "You")), ["You", "Claude Code", "Leo", "Leo's Claude Code"]);
    assert.equal(now[0], was[0], "your edit: the same actor");
    assert.equal(now[1], was[1], "your Claude Code: the same actor");
    assert.equal(actorColor(now[3]!, byKey), actorColor(now[2]!, byKey), "Leo's Claude Code in Leo's colour");
    assert.deepEqual(now.map((a) => !!a.isYou), [true, true, false, false]);
    assert.equal(h.count("mine"), 1, "Your changes: your own edit (re-indexed after the telling)");
    assert.match(rows()[3]!.summary, /Summer launch/);
  } finally {
    ui.dispose();
    await Promise.all([vikas.close(), leoC.close()]);
    host.close();
  }
});
