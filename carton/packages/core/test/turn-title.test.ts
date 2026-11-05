// An agent turn's title and what it was asked (laptop, 2026-11-05): a turn's version is named from the person's words,
// then from a short title made of them and what changed, with the request kept beside it (`name(…, {asked})`,
// Version.asked): a rename keeps it, Find finds the turn by it (its prompt) and by the title (a name). And a stored
// name the host hides (Schema.shownName: Cardboard's composed-prompt names) reads as none in Find, landmarks and
// undo's words, while `log` keeps the stored name (it ends an agent's run of versions in History).
import test from "node:test";
import assert from "node:assert/strict";
import { defineSchema, nameShown } from "../src/schema.ts";
import { Carton } from "../src/index.ts";
import type { Actor, Doc, Op } from "../src/types.ts";
import { createMemoryStore } from "../../store-memory/src/index.ts";

const HIDDEN = /^\[Earlier messages/;
const schema = defineSchema({
  collections: { items: { key: "id", noun: "clip" } },
  label: (_c, r) => (r ? String(r.name ?? "?") : "?"),
  shownName: (n) => (HIDDEN.test(n) ? undefined : n),
});
const adapter = { name: "t", schema, schemaVersion: 1, fromHost: (d: Doc) => d, toHost: (d: Doc) => d };
const me: Actor = { kind: "human", id: "me", name: "Vikas" };
const director: Actor = { kind: "agent", id: "director/chat-1/turn-1", name: "Director", chat: "chat-1", turn: "turn-1" };
const doc = (): Doc => ({ name: "Film", items: [{ id: "c1", name: "Intro", start: 0, end: 6 }] }) as unknown as Doc;
const set = (f: string, value: unknown): Op => ({ op: "set", path: ["items", "c1", f], value });
const open = (store = createMemoryStore()) => Carton.open({ adapter, store, init: { doc: doc(), cutName: "Main cut" }, actor: me });
const at = (c: Carton, seq: number) => ({ branchId: c.cut, seq, pending: [] as never[] });

test("a turn's title with what it was asked: kept by a rename, read back after a reopen, found by both", async () => {
  const store = createMemoryStore();
  const c = await open(store);
  try {
    await c.commit({ ops: [set("end", 4)], author: director });
    // the person's own words first (main names the turn at once), then the title (main's titleTurn)
    await c.name(at(c, 1), "Okay in this edit, I have…");
    assert.equal((await c.log({ limit: 1 }))[0]!.asked, undefined, "the person's words are the name: nothing beside it");
    await c.name(at(c, 1), "Tighter intro", { asked: "Okay in this edit, I have the intro running long, tighten it" });
    let v = (await c.log({ limit: 1 }))[0]!;
    assert.equal(v.name, "Tighter intro");
    assert.equal(v.asked, "Okay in this edit, I have the intro running long, tighten it");
    // a rename without it (the panel's own write) keeps it
    await c.name(at(c, 1), "Tighter intro", { author: me });
    assert.equal((await c.log({ limit: 1 }))[0]!.asked, "Okay in this edit, I have the intro running long, tighten it");
    // Find: the request is the turn's prompt, the title a name
    const byAsk = (await c.find("running long")).matches[0]!;
    assert.equal(byAsk.ref.seq, 1);
    assert.equal(byAsk.field, "prompt");
    assert.match(byAsk.snippet, /running long/);
    assert.equal((await c.find("tighter")).matches[0]!.field, "name");
  } finally { await c.close(); }
  const again = await Carton.open({ adapter, store, actor: me });
  try {
    const v = (await again.log({ limit: 1 }))[0]!;
    assert.equal(v.asked, "Okay in this edit, I have the intro running long, tighten it", "stored with the name");
  } finally { await again.close(); }
});

test("a name the host hides: log keeps it; Find, landmarks and undo's words read the version as unnamed", async () => {
  const c = await open();
  try {
    await c.commit({ ops: [set("end", 5)], author: director });
    await c.name(at(c, 1), "[Earlier messages in this conversation did…");
    assert.equal(nameShown(c.schema, "[Earlier messages in this conversation did…"), undefined);
    const v = (await c.log({ limit: 1 }))[0]!;
    assert.equal(v.name, "[Earlier messages in this conversation did…", "the stored name, for what reads it as data");
    assert.equal((await c.find("earlier messages")).matches.length, 0, "never found by the hidden name");
    const turn = (await c.landmarks()).find((l) => l.kind === "turn");
    assert.ok(turn, "still a turn");
    assert.equal(turn!.label, undefined, "with no label: the default words");
    // a person's own edit named so (never by an agent) is no named landmark either, and undo's words skip it
    await c.commit({ ops: [set("end", 3)] });
    await c.name(at(c, 2), "[Earlier messages in this, typed by hand");
    assert.ok(!(await c.landmarks()).some((l) => l.kind === "named"));
    const top = (await c.undoStack(undefined, { limit: 1 }))[0];
    assert.ok(top && !/Earlier messages/.test(top.label ?? ""), JSON.stringify(top));
  } finally { await c.close(); }
});
