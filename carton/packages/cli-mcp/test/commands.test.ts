// The command layer on a stand-in Carton: parsing, git aliases, the cb result contract (JSON and short text), and
// the reads and writes each command makes. Engine-backed tests run the same commands on real Carton.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCb, findCommand } from "../src/cb.ts";
import { resultText, exitCodeOf } from "../src/format.ts";
import { opsForChoice } from "../src/commands.ts";
import type { CbContext } from "../src/commands.ts";
import { project, director, human } from "./support/project.ts";
import type { Actor } from "@carton/core";

async function cb(ctxOf: (a?: Actor) => CbContext, argv: string[], actor: Actor = human) {
  let out = "", err = "";
  const code = await runCb(argv, { cwd: ".", env: {}, stdout: (t) => (out += t), stderr: (t) => (err += t) }, { open: async () => ctxOf(actor).project, actor: () => actor, now: ctxOf(actor).now });
  return { code, out: out.trim(), err: err.trim(), json: () => JSON.parse(out) };
}
const setName = (id: string, v: string) => ({ kind: "commit" as const, ops: [{ op: "set", path: ["timelineItems", id, "name"], value: v }] });

test("git words map to Carton commands", () => {
  const p = (argv: string[]) => { const f = findCommand(argv)!; return [f.spec.path.join(" "), f.rest]; };
  assert.deepEqual(p(["log"]), ["history", []]);
  assert.deepEqual(p(["branch"]), ["cut list", []]);
  assert.deepEqual(p(["branch", "Short"]), ["cut new", ["Short"]]);
  assert.deepEqual(p(["cut"]), ["cut list", []]);
  assert.deepEqual(p(["checkout", "Short"]), ["cut switch", ["Short"]]);
  assert.deepEqual(p(["merge", "Short", "--check"]), ["fold", ["Short", "--check"]]);
  assert.deepEqual(p(["blame", "c1"]), ["credits", ["c1"]]);
  assert.deepEqual(p(["revert", "main@1"]), ["restore", ["main@1"]]);
  assert.deepEqual(p(["diff", "main@1"]), ["compare", ["main@1"]]);
  assert.deepEqual(p(["tag"]), ["publish", []]);
  assert.equal(findCommand(["frobnicate"]), null);
});

test("history: versions newest first with who made each; --json; --stats counts like 1.4.0", async () => {
  const { ctx } = project();
  await ctx(director("t1")).project.write(setName("c1", "Cold open"));
  await ctx(director("t1", ["editor", "a1"])).project.write(setName("c2", "Talk"));
  const h = await cb(ctx, ["history"]);
  assert.equal(h.code, 0);
  const lines = h.out.split("\n");
  assert.match(lines[0], /^VERSION\s+SAVED\s+BY\s+WHAT$/);
  assert.match(lines[1], /^main@2\s+just now\s+Director › editor \(turn t1\)\s+edit$/);
  assert.match(lines[2], /^main@1\s+\d+ minutes? ago\s+Director \(turn t1\)\s+edit$/);
  const j = (await cb(ctx, ["log", "--json", "--stats", "--limit", "1"])).json();
  assert.equal(j.versions.length, 1);
  assert.deepEqual([j.versions[0].version, j.versions[0].tracks, j.versions[0].items, j.versions[0].duration], ["main@2", 2, 3, 30]);
  assert.equal(j.versions[0].by.agentType, "editor");
});

test("cut list/new/switch and the branch alias; new cuts start from a version", async () => {
  const { ctx, fake } = project();
  await ctx().project.write(setName("c1", "v1"));
  const n = await cb(ctx, ["cut", "new", "30s Instagram cut", "--from", "main@1"]);
  assert.equal(n.code, 0, n.err);
  assert.match(n.out, /^New cut "30s Instagram cut" \(\w{8}\)$/);
  assert.equal((await cb(ctx, ["branch", "Alt"])).code, 0);
  const l = await cb(ctx, ["branch"]);
  assert.match(l.out, /^\*\s+main\s+main\s+@1\s+local/m);
  assert.match(l.out, /30s Instagram cut\s+variant\s+@0\s+local/);
  const s = await cb(ctx, ["checkout", "30s instagram CUT"]);
  assert.equal(s.out, `Now on "30s Instagram cut"`);
  assert.notEqual(fake.cut, "main0000-0000");
  assert.equal((await cb(ctx, ["cut", "switch", "nope"])).code, 2, "an unknown cut is a usage error");
});

test("fold: --check reports without saving; fold in; fold in some of it (partial accept)", async () => {
  const { ctx, fake } = project();
  await cb(ctx, ["cut", "new", "Alt"]);
  const alt = [...fake.recs.values()].find((c) => c.name === "Alt")!.id;
  await ctx().project.write({ ...setName("c1", "alt-1"), cut: alt });
  await ctx().project.write({ ...setName("c2", "alt-2"), cut: alt });
  const before = (await fake.head()).ref.seq;
  const chk = await cb(ctx, ["fold", "Alt", "--check"]);
  assert.equal(chk.out, "Would fold in cleanly (no cards)");
  assert.equal((await fake.head()).ref.seq, before, "a dry run saves nothing");
  const some = await cb(ctx, ["merge", "Alt", "--reject", "timelineItems/c2", "--json"]);
  const j = some.json();
  assert.equal(j.status, "confirmed");
  const head = (await fake.head()).doc as any;
  assert.equal(head.timelineItems.find((i: any) => i.id === "c1").name, "alt-1");
  assert.equal(head.timelineItems.find((i: any) => i.id === "c2").name, "Interview", "the rejected record kept its value");
});

test("credits: who last changed a clip, down to the subagent; by id or name", async () => {
  const { ctx } = project();
  await ctx(director("t3", ["editor", "a7"])).project.write(setName("c2", "Talk"));
  const c = await cb(ctx, ["credits", "c2"]);
  assert.equal(c.out, "c2: last changed by Director › editor (turn t3) (subagent editor a7, chat c1)");
  assert.equal((await cb(ctx, ["blame", "Song"])).out, "m1: no change recorded since the project started");
  assert.equal((await cb(ctx, ["credits", "zzz"])).code, 2);
});

test("restore, undo (your group), undo --turn as one change, undo <rev>", async () => {
  const { ctx, fake } = project();
  const t = director("t9");
  await ctx(t).project.write(setName("c1", "A"));
  await ctx(human).project.write(setName("m1", "Human song"));
  await ctx(director("t9", ["editor", "x"])).project.write(setName("c2", "B"));
  // undo the whole turn t9 (Director + its subagent) as one change; the human's edit in between survives
  const u = await cb(ctx, ["undo", "--turn", "t9", "--json"], t);
  assert.equal(u.json().status, "confirmed");
  let head = (await fake.head()).doc as any;
  assert.deepEqual(head.timelineItems.map((i: any) => i.name), ["Intro", "Interview", "Human song"]);
  assert.equal((await fake.log()).filter((v) => v.change).length, 4, "one undo change for the whole turn");
  // --turn with no value: the caller's own turn
  await ctx(director("t10")).project.write(setName("c1", "C"));
  assert.equal((await cb(ctx, ["undo", "--turn"], director("t10"))).code, 0);
  head = (await fake.head()).doc as any;
  assert.equal(head.timelineItems[0].name, "Intro");
  // plain undo: the newest change of my actor group
  await ctx(human).project.write(setName("c2", "Mine"));
  const g = await cb(ctx, ["undo"], human);
  assert.match(g.out, /^Undo me: confirmed/);
  const byId = async (id: string) => ((await fake.head()).doc as any).timelineItems.find((i: any) => i.id === id);
  assert.equal((await byId("c2")).name, "Interview");
  // restore a version (1.4.0's `undo <rev>` too)
  const r = await cb(ctx, ["revert", "main@1"]);
  assert.match(r.out, /^Restored main@1: confirmed/);
  assert.equal((await byId("c1")).name, "A");
  assert.equal((await cb(ctx, ["restore", "main@99"])).code, 2, "a version that doesn't exist is a usage error");
});

test("compare, publish, activity", async () => {
  const { ctx } = project();
  await ctx(director("t1")).project.write(setName("c1", "X"));
  await ctx(director("t1")).project.write(setName("c2", "Y"));
  await ctx(human).project.write(setName("m1", "Z"));
  assert.equal((await cb(ctx, ["compare", "main@0"])).out, "- changed c1\n- changed c2\n- changed m1");
  assert.equal((await cb(ctx, ["diff", "main@1", "main@2"])).out, "- changed c2");
  const p = await cb(ctx, ["publish", "main@2", "--name", "Sent to client, Monday"]);
  assert.equal(p.out, `Published main@2 as "Sent to client, Monday"`);
  assert.match((await cb(ctx, ["cut", "list"])).out, /Sent to client, Monday\s+published\s+@0/);
  const a = (await cb(ctx, ["activity", "--json"])).json();
  assert.deepEqual(a.activity.map((g: any) => [g.by.name, g.changes]), [["me", 1], ["Director", 2]]);
});

test("conflicts and resolve: late-conflict cards, keep mine writes the agent's value", async () => {
  const { ctx, fake } = project();
  const t = director("t4");
  fake.noticeBox.set(t.id, [{ to: t.id, kind: "late-conflict", text: "Your change r.1 conflicted after your turn: timelineItems/c2/#time", change: "r.1",
    cards: [{ kind: "group", path: "timelineItems/c2/#time", base: { startTime: 5, endTime: 20 }, ours: { startTime: 5, endTime: 19 }, theirs: { startTime: 5, endTime: 18.5 } }] }]);
  const c = await cb(ctx, ["conflicts"], t);
  assert.match(c.out, /^1 open card:\n  #1 timelineItems\/c2\/#time \(group\) — yours: \{"startTime":5,"endTime":18.5\} · theirs: \{"startTime":5,"endTime":19\}/);
  assert.equal((await cb(ctx, ["resolve", "1"], t)).code, 2, "must say which side");
  const r = await cb(ctx, ["resolve", "1", "--keep", "mine"], t);
  assert.equal(r.code, 0, r.err);
  assert.equal(((await fake.head()).doc as any).timelineItems[1].endTime, 18.5);
});

test("opsForChoice: leaf, field group, whole record", () => {
  assert.deepEqual(opsForChoice({ kind: "field", path: "timelineItems/c1/name", base: "a", ours: "b", theirs: "c" }, "c"), [{ op: "set", path: ["timelineItems", "c1", "name"], value: "c" }]);
  assert.deepEqual(opsForChoice({ kind: "group", path: "timelineItems/c1/#time", base: null, ours: null, theirs: null }, { startTime: 1, endTime: 2 }), [
    { op: "set", path: ["timelineItems", "c1", "startTime"], value: 1 }, { op: "set", path: ["timelineItems", "c1", "endTime"], value: 2 }]);
  assert.deepEqual(opsForChoice({ kind: "record", path: "timelineItems/c~19", base: null, ours: null, theirs: null }, undefined), [{ op: "remove", path: ["timelineItems", "c/9"] }]);
  assert.deepEqual(opsForChoice({ kind: "record", path: "timelineItems/c1", base: null, ours: { id: "c1" }, theirs: null }, null), [{ op: "remove", path: ["timelineItems", "c1"] }], "core's deleted side is null");
});

test("the cb result contract: confirmed@seq / pending / conflicts as JSON plus short text; exit codes", () => {
  assert.equal(resultText({ status: "confirmed", seq: 58, ref: "main@58", notices: [] }), "Saved: confirmed main@58");
  assert.match(resultText({ status: "pending", id: "r.1", ref: null, notices: [], online: false }), /pending \(offline/);
  const card = { kind: "group" as const, path: "timelineItems/c3/#time", base: 1, ours: 2, theirs: 3 };
  const t = resultText({ status: "conflicts", conflicts: [card], ref: null, notices: [{ to: "a", kind: "late-conflict", text: "Your change r.0 conflicted" }] });
  assert.match(t, /^Late conflict: Your change r\.0 conflicted\nSaved: conflicts \(1 card; nothing else was lost\)\n  #1 timelineItems\/c3\/#time/);
  assert.equal(exitCodeOf({ status: "pending", id: "x", ref: null, notices: [], online: true }), 0);
  assert.equal(exitCodeOf({ status: "conflicts", conflicts: [], ref: null, notices: [] }), 1);
});

test("usage errors exit 2 and print usage; --json errors are JSON", async () => {
  const { ctx } = project();
  const m = await cb(ctx, ["credits"]);
  assert.equal(m.code, 2);
  assert.match(m.err, /missing <clip>/);
  const u = await cb(ctx, ["nope"]);
  assert.equal(u.code, 2);
  assert.match(u.err, /unknown command "nope"/);
  const j = await cb(ctx, ["restore", "garbage", "--json"]);
  assert.equal(j.code, 2);
  assert.equal(j.json().status, "error");
  assert.match((await cb(ctx, ["help"])).out, /cut new <name>/);
});

test("Stage F wording: an absorbed change is confirmed, already in place; a too-large one fails alone", () => {
  const a = resultText({ status: "confirmed", seq: 4, ref: null, notices: [], absorbed: true });
  assert.match(a, /^Saved: confirmed, already in place \(an identical edit was already there/);
  assert.equal(exitCodeOf({ status: "confirmed", seq: 4, ref: null, notices: [], absorbed: true }), 0, "never an error");
  const t = resultText({ status: "rejected", reason: "too large", notices: [] });
  assert.match(t, /not saved: this edit is larger than the server accepts .* The edits after it still went through/);
  assert.equal(exitCodeOf({ status: "rejected", reason: "too large", notices: [] }), 1);
});

test("fold: a fold that landed and came back with late cards says so (shared cut); hints quote cut names for the shell", async () => {
  const cuts = [{ id: "main0000-0000", name: "Main cut", kind: "main", sequencer: { kind: "server" } }, { id: "alt00000-0000", name: "$(touch x) cut", kind: "variant", sequencer: { kind: "server" } }];
  const card = { kind: "group", path: "timelineItems/c1/#time", base: { endTime: 5 }, ours: { endTime: 6 }, theirs: { endTime: 7 } };
  let answer: any;
  const ctx = () => ({ project: { carton: { cut: "main0000-0000", cuts: async () => cuts }, write: async () => answer }, actor: human }) as unknown as CbContext;
  answer = { status: "conflicts", id: "r.1", conflicts: [card], ref: null, notices: [] };
  const late = await cb(ctx, ["fold", "$(touch x) cut"]);
  assert.match(late.out, /^Folded in, but 1 card came back: the other side's value was kept\.\n  #1 timelineItems\/c1\/#time \(group\) — yours: \{"endTime":7\} · theirs: \{"endTime":6\}\nSee them with `cb conflicts <project>`/);
  answer = { status: "conflicts", conflicts: [card], ref: null, notices: [] };
  const undecided = await cb(ctx, ["fold", "$(touch x) cut", "--into", "main"]);
  assert.match(undecided.out, /^Not folded in: 1 card, nothing was saved\./);
  assert.match(undecided.out, /`cb fold <project> '\$\(touch x\) cut' --into main --keep mine` \(keep Main cut's\)/);
});
