// fix/take5-names: the demo video's recording switch (Cardboard: CARTON_AGENT_NAME; temporary). Off, as in every
// normal run, names are exactly as before: "Claude 2" is "Claude", the person's own Claude Code is "Claude Code". On, a
// teammate's "Claude 2" keeps its number (keepNameNumbers) and the person's own Claude Code goes by the given name
// (fromCarton's ownAgentNames); someone else's agents never do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, POS, defineSchema, timeAlgebra, type Actor as CoreActor, type Doc, type Rec } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { actorDetail, actorLabel, firstName, keepNameNumbers } from "../src/actors.ts";
import { fromCarton, toUiActor } from "../src/from-carton.ts";
import type { Actor } from "../src/model.ts";

const claude2: Actor = { key: "human/Claude", kind: "human", name: "Claude 2" };
const theirs: Actor = { key: "agent/claude-code/s2", kind: "agent", name: "Claude Code", parent: "human/Claude" };
const byKey = (k: string) => (k === claude2.key ? claude2 : undefined);

test("switch off (the default): a teammate is their first name, numbers and all, as before", () => {
  assert.equal(firstName("Claude 2"), "Claude");
  assert.equal(firstName("Cam 3"), "Cam");
  assert.equal(firstName("Leo Park"), "Leo");
  assert.equal(firstName("  Mia   Chen "), "Mia");
  assert.equal(firstName(""), "Teammate");
  assert.equal(actorLabel(claude2, byKey, "You"), "Claude");
  assert.equal(actorLabel(theirs, byKey, "You"), "Claude's Claude Code");
  assert.equal(actorDetail(claude2, byKey, "You"), "Claude 2", "the whole name on hover");
});

test("switch on: a name whose rest is only a number keeps it; any other name is its first name", (t) => {
  keepNameNumbers(true);
  t.after(() => keepNameNumbers(false));
  assert.equal(firstName("Claude 2"), "Claude 2");
  assert.equal(firstName("  Cam   3 "), "Cam 3");
  assert.equal(firstName("Claude 12"), "Claude 12");
  assert.equal(firstName("Leo Park"), "Leo");
  assert.equal(firstName("Mia Chen 2"), "Mia", "a last name and a number: the first name");
  assert.equal(firstName("Claude 2b"), "Claude", "not only a number");
  assert.equal(firstName("Claude"), "Claude");
  assert.equal(firstName(""), "Teammate");
  // every slot that names a teammate goes through it: History's author, their agent's owner; the tooltip then has
  // nothing more to say
  assert.equal(actorLabel(claude2, byKey, "You"), "Claude 2");
  assert.equal(actorLabel(theirs, byKey, "You"), "Claude 2's Claude Code");
  assert.equal(actorDetail(claude2, byKey, "You"), undefined);
});

const me: CoreActor = { kind: "human", id: "vikas", name: "Vikas", group: "local:vikas@laptop" };
const g = "local:vikas@laptop";
const NAMES = { "claude-code": "Claude 1" };
const mine: CoreActor = { kind: "agent", id: "claude-code/ab12cd34", owner: { id: "vikas", name: "Vikas" } };

test("toUiActor without names (the default): the person's own Claude Code is 'Claude Code', as before", () => {
  assert.deepEqual([toUiActor(mine, me, g).name, toUiActor(mine, me, g).isYou], ["Claude Code", true]);
  assert.equal(toUiActor({ kind: "agent", id: "claude-code/ab12cd34", name: "Claude Code" }, me, g, undefined, true).name, "Claude Code");
});

test("toUiActor with names: the person's own Claude Code goes by its given name; a teammate's and the Director don't", () => {
  const leos: CoreActor = { kind: "agent", id: "claude-code/ff00ee11", owner: { id: "leo", name: "Leo Park" } };
  const grouped: CoreActor = { kind: "agent", id: "claude-code/ab12cd34", group: g };
  const sub: CoreActor = { kind: "subagent", id: "claude-code/ab12cd34/sub-Explore-x1", agentType: "Explore", owner: { id: "vikas", name: "Vikas" } };
  const director: CoreActor = { kind: "agent", id: "director/c1/t1", provider: "claude-code", owner: { id: "vikas", name: "Vikas" } };
  assert.deepEqual([toUiActor(mine, me, g, NAMES).name, toUiActor(mine, me, g, NAMES).isYou], ["Claude 1", true]);
  assert.equal(toUiActor(grouped, me, g, NAMES).name, "Claude 1", "yours by your undo group, no owner told");
  assert.equal(toUiActor(sub, me, g, NAMES).name, "Claude 1", "a subagent goes by its agent's name");
  assert.equal(toUiActor(director, me, g, NAMES).name, "Director");
  const leo = toUiActor(leos, me, g, NAMES);
  assert.equal(leo.name, "Claude Code", "a teammate's agent keeps its name");
  assert.equal(actorLabel(leo, (k) => (k === "human/leo" ? { key: k, kind: "human", name: "Leo Park" } : undefined), "You"), "Leo's Claude Code");
  // an in-app turn (setWorking) is the person's own, whoever recorded it
  const turn: CoreActor = { kind: "agent", id: "claude-code/ab12cd34", name: "Claude Code" };
  assert.equal(toUiActor(turn, me, g, NAMES).name, "Claude Code", "not known as yours");
  assert.equal(toUiActor(turn, me, g, NAMES, true).name, "Claude 1");
  // a Claude Code known only by its view (no hook): its saves are credited to the view, with the provider
  const view: CoreActor = { kind: "external", id: "external:.scratch/views/cc.tsx", provider: "claude-code", group: g };
  assert.equal(toUiActor(view, me, g, NAMES).name, "Claude 1");
  assert.equal(toUiActor(view, me, g).name, "Claude Code");
});

// ------------------------------------------------------------------ over the real engine
const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
const schema = defineSchema({
  collections: { tracks: { seq: true }, items: { parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] } },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? (r as Rec | undefined)?.id ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
const clip = (id: string, s: number): Rec => ({ id, trackId: "t1", startTime: s, endTime: s + 5, trimStart: 0, trimEnd: 5, name: id.toUpperCase() });
const doc0 = (): Doc => ({ tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0), clip("b", 5)] });
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["items", id, f], value: v });
const mineCc: CoreActor = { kind: "agent", id: "claude-code/ab12cd34", group: g };

async function opened(ownAgentNames?: Record<string, string>) {
  const carton = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), cutName: "Main cut" }, actor: me });
  const ui = fromCarton(carton, { me, ...(ownAgentNames ? { ownAgentNames } : {}) });
  await ui.ready;
  await carton.commit({ ops: [set("a", "name", "Hello?")], author: mineCc });
  await ui.refresh();
  await ui.settled();
  return { carton, ui };
}

for (const [names, want] of [[undefined, "Claude Code"], [NAMES, "Claude 1"]] as const) {
  test(`fromCarton(${names ? "ownAgentNames" : "no names, the default"}): History's row, the working turn and credits say '${want}'`, async () => {
    const { carton, ui } = await opened(names);
    const top = ui.history().at("all", 0)!;
    assert.deepEqual([top.author.name, top.author.isYou, actorLabel(top.author, ui.actor.bind(ui), "You")], [want, true, want]);
    const cr = await ui.credits("a");
    assert.ok(cr.lines.length && cr.lines.every((l) => l.author.name === want), JSON.stringify(cr.lines.map((l) => l.author.name)));
    ui.setWorking({ actor: { kind: "agent", id: "claude-code/ab12cd34", name: "Claude Code" }, label: "Change the titles" });
    assert.equal(ui.working()?.actor.name, want);
    ui.setWorking(null);
    ui.dispose();
    await carton.close();
  });
}
