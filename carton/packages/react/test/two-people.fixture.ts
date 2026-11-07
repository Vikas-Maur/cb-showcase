// Two people on one shared project, over the real engine (feat/history-arrival's tests): Vikas's and Leo's replicas
// through the in-process sequencer host (node:sqlite), each with its identity, as Cardboard's apps are once the person
// is known, and Vikas's History (his view model, as the library worker makes it).
import { Carton, POS, defineSchema, hashDoc, timeAlgebra, type Actor as CoreActor, type Doc, type Rec } from "@carton/core";
import type { AuthContext, AuthProvider, HostAdapter } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { createMemoryStore } from "@carton/store-memory";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { fromCarton } from "../src/from-carton.ts";
export const TL = { collection: "items", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
export const schema = defineSchema({
  collections: {
    tracks: { seq: true },
    items: { parent: { field: "trackId", collection: "tracks" }, noun: "clip", nounOf: (r) => (r.type === "text" ? "title" : undefined), groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"], algebra: timeAlgebra(TL) }] },
  },
  timeline: TL,
  label: (coll, r) => String((r as Rec | undefined)?.name ?? coll),
});
const adapter: HostAdapter<Doc> = { name: "test", schema, schemaVersion: 1, fromHost: (h) => h, toHost: (d) => d };
export const clip = (id: string, s: number, o: Partial<Rec> = {}): Rec => ({ id, trackId: "t1", startTime: s, endTime: s + 2, trimStart: 0, trimEnd: 2, name: id, ...o });
const doc0 = (): Doc => ({ tracks: [{ id: "t1", [POS]: "V" }], items: [clip("a", 0), clip("b", 2)] });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Vikas's and Leo's replicas of one shared project through the in-process host, each with its identity, and Vikas's
 * History (his view model, as the library worker makes it once the person is known). */
/** `sameComputer`: Leo's app on Vikas's computer (two test profiles on one laptop): both in one machine group. */
export async function twoPeople(o: { sameComputer?: boolean } = {}) {
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
export const vikasClaude: CoreActor = { kind: "agent", id: "claude-code/787d66ff", name: "Claude Code", provider: "claude-code", group: "local:vikas@laptop" };
export const leoClaude: CoreActor = { kind: "agent", id: "claude-code/1c0e5a9b", name: "Claude Code", provider: "claude-code", group: "local:leo@studio" };
/** Leo's Claude Code on Vikas's computer (`sameComputer`): the same machine group as Vikas's. */
export const leoClaudeHere: CoreActor = { ...leoClaude, group: "local:vikas@laptop" };
export const setOp = (id: string, f: string, val: unknown) => ({ op: "set" as const, path: ["items", id, f], value: val });

