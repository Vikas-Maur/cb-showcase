// A teammate's version that comes to History live reads by person from its first frame: core's change event tells its
// author as log() does, and from-carton takes it (summarize() tells one again, for a person learnt later). Over the
// real engine, two replicas syncing through the in-process host: Leo's GUI save and Leo's Claude Code's version come to
// Vikas's History live as "Leo" and "Leo's Claude Code" (in Leo's colour), at every notification, never first as
// "Teammate" or an unowned "Claude Code" (as Vikas's own agent reads) or as Vikas's own (two profiles on one computer);
// Vikas's own versions keep their actors.
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

/** Vikas's and Leo's replicas of one shared project through the in-process host, each with its identity, and Vikas's
 * History (his view model, as the library worker makes it once the person is known). */
/** `sameComputer`: Leo's app on Vikas's computer (two test profiles on one laptop): both in one machine group. */
async function twoPeople(o: { sameComputer?: boolean } = {}) {
  const tokens = new Map<string, AuthContext>();
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name });
  const sync = (name: string) => {
    tokens.set(`tok-${name}`, { account: name, credential: `${name}/install`, role: "editor", projectId: "p", expires: Date.now() + 3600_000 });
    return { transport: host.transport, url: host.url, token: `tok-${name}`, autoConnect: true };
  };
  // each app records its GUI saves as the generic person in its machine's group; setIdentity says who that is
  const vikasPerson: CoreActor = { kind: "human", id: "person", group: "local:vikas@laptop" };
  const leoPerson: CoreActor = { kind: "human", id: "person", group: o.sameComputer ? "local:vikas@laptop" : "local:leo@studio" };
  const vikas = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0(), projectId: "p" }, actor: vikasPerson, sync: sync("vikas") });
  await vikas.setIdentity({ id: "vikas", name: "Vikas" });
  await vikas.share();
  await until(async () => (await vikas.cuts())[0]!.sequencer.kind === "server", "the hand-off");
  const cut = (await vikas.cuts())[0]!;
  const root = await vikas.checkout(`${cut.id}@0`);
  const leo = await Carton.open({ adapter, store: createMemoryStore(), init: { join: { projectId: "p", cut, doc0: root, rootHash: hashDoc(root, schema) } }, actor: leoPerson, sync: sync("leo") });
  await leo.setIdentity({ id: "leo", name: "Leo Park" });
  const ui = fromCarton(vikas, { me: { kind: "human", id: "vikas", name: "Vikas", group: "local:vikas@laptop" } });
  await ui.ready;
  const close = async () => {
    ui.dispose();
    await Promise.all([vikas.close(), leo.close()]);
    host.close();
  };
  return { vikas, leo, ui, close };
}
const vikasClaude: CoreActor = { kind: "agent", id: "claude-code/787d66ff", name: "Claude Code", provider: "claude-code", group: "local:vikas@laptop" };
const leoClaude: CoreActor = { kind: "agent", id: "claude-code/1c0e5a9b", name: "Claude Code", provider: "claude-code", group: "local:leo@studio" };
/** Leo's Claude Code on Vikas's computer (`sameComputer`): the same machine group as Vikas's. */
const leoClaudeHere: CoreActor = { ...leoClaude, group: "local:vikas@laptop" };
const setOp = (id: string, f: string, val: unknown) => ({ op: "set" as const, path: ["items", id, f], value: val });


test("a teammate's live versions arrive told by person (Leo, Leo's Claude Code, in Leo's colour); yours stay", { timeout: 30_000 }, async () => {
  const { vikas, leo, ui, close } = await twoPeople();
  try {
    assert.equal((await vikas.commit({ ops: [setOp("a", "endTime", 1.5), setOp("a", "trimEnd", 1.5)], wait: 5000 })).status, "confirmed");
    assert.equal((await vikas.commit({ ops: [setOp("b", "startTime", 2.5)], author: vikasClaude, wait: 5000 })).status, "confirmed");
    assert.equal((await leo.commit({ ops: [setOp("b", "endTime", 4.5), setOp("b", "trimEnd", 2)], wait: 5000 })).status, "confirmed");
    assert.equal((await leo.commit({ ops: [{ op: "insert", path: ["items", "t"], value: clip("t", 1, { type: "text", name: "Summer launch" }) }], author: leoClaude, wait: 5000 })).status, "confirmed");
    const h = ui.history();
    const byKey = ui.actor.bind(ui);
    const rows = () => h.all!().slice(-4);
    await until(async () => (await ui.settled(), rows().length === 4 && rows()[3]!.author.kind === "agent" && !rows()[3]!.author.isYou), "Leo's Claude Code's version at Vikas's");
    const was = rows().map((x) => x.author);
    // live, before anything is described: already by person
    assert.deepEqual(was.map((a) => actorLabel(a, byKey, "You")), ["You", "Claude Code", "Leo", "Leo's Claude Code"]);
    assert.equal(actorColor(was[3]!, byKey), actorColor(was[2]!, byKey), "Leo's Claude Code in Leo's colour");
    for (let i = 0; i < 4; i++) h.at("all", i);
    await until(async () => (await ui.settled(), rows().every((x) => !!x.summary)), "the rows described");
    const now = rows().map((x) => x.author);
    now.forEach((a, i) => assert.equal(a, was[i], `row ${i}: the same actor once described`));
    assert.deepEqual(now.map((a) => !!a.isYou), [true, true, false, false]);
    assert.equal(h.count("mine"), 1, "Your changes: your own edit");
  } finally {
    await close();
  }
});

for (const sameComputer of [false, true])
test(`a teammate's arriving version is never published as "Teammate", an unowned "Claude Code" or yours, nor in another colour than Leo's${sameComputer ? " (Leo on Vikas's computer: one machine group)" : ""}`, { timeout: 30_000 }, async () => {
  const { vikas, leo, ui, close } = await twoPeople({ sameComputer });
  try {
    const mine = await vikas.commit({ ops: [setOp("a", "endTime", 1.5), setOp("a", "trimEnd", 1.5)], wait: 5000 });
    assert.equal(mine.status, "confirmed");
    const id = mine.status === "confirmed" ? mine.change!.id : "";
    const rid = id.slice(0, id.indexOf("."));
    const byKey = ui.actor.bind(ui);
    const leoColor = actorColor({ key: "human/leo", kind: "human", name: "Leo Park" });
    const seen: string[] = [], wrong: string[] = [];
    // every History the panel could draw: at each notification, each of the teammate's rows as it reads then
    const off = ui.subscribe("history", () => {
      for (const v of ui.history().all!()) {
        if (v.start || v.id.startsWith(rid + ".") || v.author.kind === "system") continue;
        const label = actorLabel(v.author, byKey, "You"), color = actorColor(v.author, byKey);
        seen.push(label);
        if (!(label === "Leo" || label === "Leo's Claude Code") || color !== leoColor || v.author.isYou) wrong.push(`${label} ${color}${v.author.isYou ? " (yours)" : ""}`);
      }
    });
    assert.equal((await leo.commit({ ops: [setOp("b", "endTime", 4.5), setOp("b", "trimEnd", 2)], wait: 5000 })).status, "confirmed");
    assert.equal((await leo.commit({ ops: [{ op: "insert", path: ["items", "t"], value: clip("t", 1, { type: "text", name: "Summer launch" }) }], author: sameComputer ? leoClaudeHere : leoClaude, wait: 5000 })).status, "confirmed");
    await until(async () => (await ui.settled(), seen.includes("Leo's Claude Code")), "Leo's Claude Code's version at Vikas's");
    off();
    assert.deepEqual([...new Set(wrong)], [], "never another name or colour, not for one notification");
    assert.ok(seen.includes("Leo"));
  } finally {
    await close();
  }
});
