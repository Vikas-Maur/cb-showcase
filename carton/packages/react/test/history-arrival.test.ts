// feat/history-arrival: someone else's versions arriving while History is open (arrivals.ts), and a teammate's live
// version named by person from the first time History holds it (core's change event tells its author as log() does).
// - nextArrivals: only versions that join the watched cut while it is watched, by someone other than you and your
//   agents; never what was there at the first look, nor a list loaded or swapped (a cut, a reload), in O(what arrived).
// - Over the real engine, two replicas syncing through the in-process host: Leo's GUI save and Leo's Claude Code's
//   version come to Vikas's History live as "Leo" and "Leo's Claude Code" (in Leo's colour), at every notification,
//   never first as "Teammate" or an unowned "Claude Code" (as Vikas's own agent reads), on another computer or his;
//   Vikas's own versions stay as they were.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARRIVAL_BURST, ARRIVAL_CALM_MS, ARRIVALS_KEPT, isSomeoneElse, nextArrivals, type ArrivalState } from "../src/arrivals.ts";
import { actorColor, actorLabel } from "../src/actors.ts";
import { clip, leoClaude, leoClaudeHere, setOp, twoPeople, until, vikasClaude } from "./two-people.fixture.ts";
import type { Actor, Version } from "../src/model.ts";

// ------------------------------------------------------------------------------------------------- nextArrivals
const you: Actor = { key: "human/vikas", kind: "human", name: "Vikas", isYou: true };
const yourAgent: Actor = { key: "agent/claude", kind: "agent", name: "Claude Code", parent: "human/vikas", isYou: true };
const leo: Actor = { key: "human/leo", kind: "human", name: "Leo" };
const leosAgent: Actor = { key: "agent/claude-leo", kind: "agent", name: "Claude Code", parent: "human/leo" };
const system: Actor = { key: "system/carton", kind: "system", name: "" };
let n = 0;
const v = (author: Actor, o: Partial<Version> = {}): Version => {
  n++;
  return { id: `v${n}`, seq: n, ref: `main@${n}`, at: n * 1000, author, kind: "edit", summary: `change ${n}`, ...o };
};
const SRC = {};
const step = (s: ArrivalState | null, all: readonly Version[], rev: number, o: { cut?: string; loading?: boolean; now?: number; source?: unknown } = {}) =>
  nextArrivals(s, all, { source: o.source ?? SRC, cut: o.cut ?? "main", rev, ...(o.loading ? { loading: true } : {}), now: o.now ?? 5 });

test("someone else is a teammate or a teammate's agent: never you, your agents or the system", () => {
  assert.deepEqual([you, yourAgent, leo, leosAgent, system].map(isSomeoneElse), [false, false, true, true, false]);
});

test("the first look is what was there: nothing arrived; a teammate's version after it did, yours and your agent's never", () => {
  const all = [v(system, { start: "created" }), v(leo), v(you), v(leosAgent)];
  let s = step(null, all, 1);
  assert.equal(s.at.size, 0, "rows there when History opened");
  assert.equal(s.last, all[3]!.id);
  all.push(v(yourAgent), v(you));
  s = step(s, all, 2);
  assert.equal(s.at.size, 0, "yours and your agent's");
  const t = v(leo), a = v(leosAgent);
  all.push(t, a);
  s = step(s, all, 3, { now: 42 });
  assert.deepEqual([...s.at], [[t.id, 42], [a.id, 42]]);
  assert.deepEqual(s.added.map((x) => x.id), [a.id, t.id], "newest first");
  const same = step(s, all, 3);
  assert.equal(same, s, "the same revision: the same state (memoizable)");
  const quiet = step(s, all, 4);
  assert.equal(quiet.at, s.at, "nothing new: the same marks");
  assert.deepEqual(quiet.added, []);
});

test("a version arriving among provisional rows (before them, as the engine places it, or after, as the mock does) is found", () => {
  const all = [v(you), v(you)];
  let s = step(null, all, 1);
  const p1 = v(you, { provisional: true, seq: null }), p2 = v(yourAgent, { provisional: true, seq: null });
  all.push(p1, p2);
  s = step(s, all, 2);
  assert.equal(s.at.size, 0);
  const before = v(leo);
  all.splice(2, 0, before); // from-carton: a confirmed version goes in before the provisional ones still waiting
  s = step(s, all, 3);
  assert.deepEqual([...s.at.keys()], [before.id]);
  const after = v(leosAgent);
  all.push(after); // the mock appends
  s = step(s, all, 4);
  assert.deepEqual([...s.at.keys()], [before.id, after.id]);
  // your provisional ones confirmed (same ids, now confirmed): yours, never arrivals
  all.splice(2, 2, before, { ...p1, provisional: undefined, seq: 9 });
  s = step(s, all, 5);
  assert.deepEqual([...s.at.keys()], [before.id, after.id]);
});

test(`an arrival within ${ARRIVAL_CALM_MS} ms of the one before is in a burst (drawn without motion); after a quiet moment it is calm again`, () => {
  const all = [v(you)];
  let s = step(null, all, 1);
  const a = v(leo), b = v(leosAgent), c = v(leo), d = v(leo);
  all.push(a);
  s = step(s, all, 2, { now: 10_000 });
  assert.equal(s.busy.size, 0, "the first: calm");
  all.push(b, c);
  s = step(s, all, 3, { now: 10_000 + ARRIVAL_CALM_MS - 1 });
  assert.deepEqual([...s.busy].sort(), [b.id, c.id].sort(), "the next two, soon after: a burst");
  all.push(v(you));
  s = step(s, all, 4, { now: 10_000 + 2 * ARRIVAL_CALM_MS });
  assert.equal(s.lastAt, 10_000 + ARRIVAL_CALM_MS - 1, "yours move nothing");
  all.push(d);
  s = step(s, all, 5, { now: 10_000 + 3 * ARRIVAL_CALM_MS });
  assert.ok(!s.busy.has(d.id), "after a quiet moment: calm");
  assert.ok([...s.busy].every((id) => s.at.has(id)), "a burst's marks are some of the arrivals'");
});

test("History loading, empty or loaded in one go is never an arrival; another cut starts over; a reload is watched as it is", () => {
  const list = [v(you), v(leo), v(leosAgent)];
  // the renderer's History before the worker's first `init` (remote.ts: loading), then the whole list at once
  let s = step(null, [], 1, { loading: true });
  assert.equal(s.last, null, "not watching yet");
  s = step(s, list, 2);
  assert.equal(s.at.size, 0, "loaded: what was there");
  // a version that came by event while the worker's load waited, then the load around it (older ones under it)
  s = step(null, [list[2]!], 1);
  s = step(s, list, 2);
  assert.equal(s.at.size, 0, "the load's older versions");
  // an arrival, then a cut switched to: the worker empties History, then loads the other cut's
  const t = v(leo);
  s = step(s, [...list, t], 3);
  assert.equal(s.at.size, 1);
  s = step(s, [], 4);
  assert.equal(s.last, null);
  assert.equal(s.at.size, 1, "the same cut, emptied: its marks are kept (a reload of it)");
  const other = [v(you), v(leo), v(leosAgent), v(leo)];
  s = step(s, other, 5, { cut: "30s" });
  assert.equal(s.at.size, 0, "another cut: its own arrivals, from its first look");
  // both in one render (no empty step), on the same cut id: the one seen last is gone, so it starts watching this one
  const swapped = [v(leo), v(leosAgent), v(leo)];
  const s2 = step(s, swapped, 6, { cut: "30s" });
  assert.equal(s2.at.size, 0);
  assert.equal(s2.last, swapped[2]!.id);
  // another source (a new view model) starts over too
  assert.equal(step(s2, [...swapped, v(leo)], 7, { cut: "30s", source: {} }).at.size, 0);
});

test(`more than ${ARRIVAL_BURST} new confirmed versions at once is another list, not arrivals; marks are kept for the newest ${ARRIVALS_KEPT}`, () => {
  const all = [v(you)];
  let s = step(null, all, 1);
  for (let i = 0; i <= ARRIVAL_BURST; i++) all.push(v(leo));
  s = step(s, all, 2);
  assert.equal(s.at.size, 0, "a burst past the bound");
  assert.equal(s.last, all[all.length - 1]!.id);
  let rev = 3;
  for (let i = 0; i < ARRIVALS_KEPT + 10; i++) {
    all.push(v(leo));
    s = step(s, all, rev++);
  }
  assert.equal(s.at.size, ARRIVALS_KEPT);
  assert.ok(s.at.has(all[all.length - 1]!.id) && !s.at.has(all[all.length - ARRIVALS_KEPT - 1]!.id), "the oldest marks go first");
  assert.ok(s.busy.size <= ARRIVALS_KEPT && [...s.busy].every((id) => s.at.has(id)), "a burst's marks go with them");
});

test("a step reads only what arrived: the newest confirmed version back to the one seen last", () => {
  const all: Version[] = [];
  for (let i = 0; i < 50_000; i++) all.push(v(i % 3 ? you : leo));
  let s = step(null, all, 1);
  let reads = 0;
  const counted = new Proxy(all, { get: (t, k, r) => ((typeof k === "string" && /^\d+$/.test(k) && reads++), Reflect.get(t, k, r)) });
  all.push(v(leo));
  s = step(s, counted, 2);
  assert.equal(s.at.size, 1);
  assert.ok(reads <= 4, `${reads} reads of History for one arrival in 50,001 versions`);
});

// ------------------------------------------------------------------------------------------------- the real engine

test("over the engine, a teammate's live versions arrive told by person (Leo, Leo's Claude Code, in Leo's colour); yours stay", { timeout: 30_000 }, async () => {
  const { vikas, leo, ui, close } = await twoPeople();
  try {
    // History open; then Vikas's own edit and his Claude Code's, Leo's GUI save and Leo's Claude Code's title, live
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
    assert.deepEqual(was.map(isSomeoneElse), [false, false, true, true]);
    assert.equal(actorColor(was[3]!, byKey), actorColor(was[2]!, byKey), "Leo's Claude Code in Leo's colour");
    // the panel shows them (described): nothing changes who they are
    for (let i = 0; i < 4; i++) h.at("all", i);
    await until(async () => (await ui.settled(), rows().every((x) => !!x.summary)), "the rows described");
    const now = rows().map((x) => x.author);
    assert.deepEqual(now.map((a) => actorLabel(a, byKey, "You")), ["You", "Claude Code", "Leo", "Leo's Claude Code"]);
    now.forEach((a, i) => assert.equal(a, was[i], `row ${i}: the same actor once described`));
    assert.deepEqual(now.map((a) => !!a.isYou), [true, true, false, false]);
    assert.equal(h.count("mine"), 1, "Your changes: your own edit");
    assert.match(rows()[3]!.summary, /Summer launch/);
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
