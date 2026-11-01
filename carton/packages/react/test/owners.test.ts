// ui-words: Maya and Leo each use a Director on one shared cut. Core tells an agent's change with its owner, the person
// behind the replica that made it (as it tells the generic person: setIdentity here, the server's people for a
// teammate), so on Maya's screen her agents read "Director" and Leo's read "Leo's Director", and the reverse on Leo's.
// The recorded actor stays as it was. With no owner known, an agent is just "Director".
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, hashDoc, timeAlgebra, type Actor, type Doc, type Rec } from "@carton/core";
import type { AuthContext, AuthProvider, HostAdapter } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { createMemoryStore } from "@carton/store-memory";
// the shared-cut tests' sequencer storage (node:sqlite), as @carton/store-memory's own tests use it
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { actorDetail, actorLabel } from "../src/actors.ts";
import { fromCarton } from "../src/from-carton.ts";

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
const doc0 = (): Doc => ({ tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0), clip("b", 2), clip("c", 4), clip("d", 6)] });
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
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

test("Maya and Leo each use a Director on a shared cut: each sees their own as 'Director', the other's as '<Name>'s Director'", { timeout: 30_000 }, async () => {
  const w = world();
  // Each app records its GUI saves as the generic person in its machine's group; setIdentity says who that is.
  const mayaPerson: Actor = { kind: "human", id: "person", group: "local:maya@laptop" };
  const leoPerson: Actor = { kind: "human", id: "person", group: "local:leo@studio" };
  const maya = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "p" }, actor: mayaPerson, sync: w.sync("maya") });
  await maya.setIdentity({ id: "maya", name: "Maya" });
  await maya.share();
  await until(async () => (await maya.cuts())[0]!.sequencer.kind === "server", "the hand-off");
  const cut = (await maya.cuts())[0]!;
  const root = await maya.checkout(`${cut.id}@0`);
  const leo = await Carton.open({ adapter, store: createMemoryStore(), init: { join: { projectId: "p", cut, doc0: root, rootHash: hashDoc(root, schema) } }, actor: leoPerson, sync: w.sync("leo") });
  await leo.setIdentity({ id: "leo", name: "Leo" });
  // One Director each (their ids say whose chat; nothing in them says whose person), and a subagent of Leo's.
  const mayasDirector: Actor = { kind: "agent", id: "director/m-chat/t1", name: "Director", chat: "m-chat", turn: "t1", provider: "claude-code", group: "local:maya@laptop" };
  const leosDirector: Actor = { kind: "agent", id: "director/l-chat/t1", name: "Director", chat: "l-chat", turn: "t1", provider: "claude-code", group: "local:leo@studio" };
  const leosSub: Actor = { kind: "subagent", id: "director/l-chat/t2/sub-Explore-ab12", name: "Director › Explore", agentType: "Explore", agentId: "ab12", chat: "l-chat", turn: "t2", group: "local:leo@studio" };
  assert.equal((await maya.commit({ ops: [set("a", "name", "maya's director")], author: mayasDirector, wait: 5000 })).status, "confirmed");
  assert.equal((await leo.commit({ ops: [set("b", "name", "leo's director")], author: leosDirector, wait: 5000 })).status, "confirmed");
  assert.equal((await leo.commit({ ops: [set("c", "name", "leo's subagent")], author: leosSub, wait: 5000 })).status, "confirmed");

  // Each screen: the History panel's view model, `me` as Cardboard's panel gives it once the person is known.
  const screens = [
    { carton: maya, me: { kind: "human", id: "maya", name: "Maya", group: "local:maya@laptop" } as Actor, mine: "director/m-chat/t1", theirs: "director/l-chat/t1", other: "Leo" },
    { carton: leo, me: { kind: "human", id: "leo", name: "Leo", group: "local:leo@studio" } as Actor, mine: "director/l-chat/t1", theirs: "director/m-chat/t1", other: "Maya" },
  ];
  for (const s of screens) {
    await until(async () => {
      const log = await s.carton.log();
      return log.filter((v) => v.author?.owner).length >= 3;
    }, `both Directors' owners at ${s.me.id}'s`);
    const ui = fromCarton(s.carton, { me: s.me });
    await ui.ready;
    await ui.settled();
    const byKey = ui.actor.bind(ui);
    const rows = ui.history().all!();
    const label = (agentId: string) => {
      const v = rows.find((r) => r.author.key === `agent/${agentId}`);
      assert.ok(v, `a row by ${agentId} at ${s.me.id}'s`);
      return actorLabel(v.author, byKey, "You");
    };
    assert.equal(label(s.mine), "Director", `${s.me.id}'s own Director`);
    assert.equal(label(s.theirs), `${s.other}'s Director`, `the other's Director at ${s.me.id}'s`);
    // Leo's subagent reads as Leo's Director everywhere but Leo's own screen; its type is the tooltip's
    const sub = rows.find((r) => r.author.kind === "subagent")!;
    const owned = s.me.id === "leo" ? "Director" : "Leo's Director";
    assert.equal(actorLabel(sub.author, byKey, "You"), owned);
    assert.equal(actorDetail(sub.author, byKey, "You"), `${owned} › Explore`);
    ui.dispose();
  }
  // told, never recorded: the owner is not part of the change (Leo's Director's change hashes as committed)
  const recorded = (await leo.log()).find((v) => v.author?.id === "director/l-chat/t1")!;
  assert.deepEqual(recorded.authoredAs, undefined, "an owner only adds to the actor as recorded");
  await Promise.all([maya.close(), leo.close()]);
  w.host.close();
});

test("with no owner known (no identity, offline), a Director is just 'Director'", async () => {
  const me: Actor = { kind: "human", id: "person", group: "local:maya@laptop" };
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: me });
  // a Director from another machine's group, with no person known for it
  await c.commit({ ops: [set("a", "name", "x")], author: { kind: "agent", id: "director/x/t1", name: "Director", group: "local:someone@else" } });
  const ui = fromCarton(c, { me });
  await ui.ready;
  await ui.settled();
  const v = ui.history().all!().find((r) => r.author.kind === "agent")!;
  assert.equal(actorLabel(v.author, ui.actor.bind(ui), "You"), "Director");
  ui.dispose();
  await c.close();
});
