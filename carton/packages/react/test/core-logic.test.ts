import { test } from "node:test";
import assert from "node:assert/strict";
import { duration, seconds, when } from "../src/format.ts";
import { windowRange } from "../src/virtual.ts";
import { TopicHub } from "../src/hub.ts";
import { actorChain, actorDetail, actorLabel, initials } from "../src/actors.ts";
import { people, createMockUi } from "../src/mock.ts";
import { words } from "../src/words.ts";
import type { Actor } from "../src/model.ts";

test("duration and seconds read like the player and describe()", () => {
  assert.equal(duration(7.44), "0:07.4");
  assert.equal(duration(75), "1:15.0");
  assert.equal(duration(59.96), "1:00.0");
  assert.equal(duration(3725), "1:02:05");
  assert.equal(duration(-3), "0:00.0");
  assert.equal(seconds(4.25), "4.3 s");
  assert.equal(seconds(Number.NaN), "0.0 s");
});

test("when: just now, minutes, hours, yesterday, then dates", () => {
  const now = new Date(2026, 9, 31, 15, 0).getTime();
  assert.equal(when(now - 20_000, now, "en-GB"), "just now");
  assert.equal(when(now - 4 * 60_000, now, "en-GB"), "4 min ago");
  assert.equal(when(now - 2 * 3_600_000, now, "en-GB"), "2 h ago");
  // then the moment, always with am/pm (PLAN 0.9): never a bare H:MM beside a timecode
  assert.equal(when(new Date(2026, 9, 31, 8, 5).getTime(), now, "en-GB"), "8:05 am");
  assert.equal(when(new Date(2026, 9, 30, 14, 5).getTime(), now, "en-GB"), "yesterday at 2:05 pm");
  assert.equal(when(new Date(2026, 9, 27, 9, 0).getTime(), now, "en-GB"), "27 Oct at 9:00 am");
  assert.equal(when(new Date(2026, 6, 3).getTime(), now, "en-GB"), "3 Jul at 12:00 am");
  assert.equal(when(new Date(2025, 6, 3).getTime(), now, "en-GB"), "3 Jul 2025 at 12:00 am");
});

test("windowRange renders the visible rows plus overscan, clamped", () => {
  assert.deepEqual(windowRange(0, 400, 52, 10_000, 6), [0, 15]);
  assert.deepEqual(windowRange(52 * 5000, 400, 52, 10_000, 6), [4994, 5015]);
  assert.deepEqual(windowRange(52 * 9999, 400, 52, 10_000, 6), [9993, 10_000]);
  assert.deepEqual(windowRange(0, 400, 52, 0, 6), [0, 0]);
  const [s, e] = windowRange(123_456, 800, 52, 100_000, 6);
  assert.ok(e - s <= Math.ceil(800 / 52) + 1 + 12, "a window stays small at any size");
});

test("TopicHub coalesces a burst into one call per topic, on the next microtask", async () => {
  const hub = new TopicHub<"a" | "b">();
  let a = 0, b = 0;
  hub.subscribe("a", () => a++);
  const off = hub.subscribe("b", () => b++);
  for (let i = 0; i < 100; i++) hub.notify("a");
  hub.notify("b");
  assert.equal(a, 0, "not synchronous");
  await Promise.resolve();
  assert.equal(a, 1);
  assert.equal(b, 1);
  off();
  hub.notify("b");
  await Promise.resolve();
  assert.equal(b, 1, "unsubscribed");
  hub.notifyNow("a");
  assert.equal(a, 2);
});

test("actors: a subagent's slot is the agent that started it; its type and a model are details", () => {
  const byKey = (k: string): Actor | undefined => Object.values(people).find((p) => p.key === k);
  // ui-words: the slot stays short ("Director"); "Director › Explore" is the tooltip, and Credits' details
  assert.equal(actorLabel(people.explore, byKey), "Director");
  assert.equal(actorDetail(people.explore, byKey), "Director › Explore");
  assert.equal(actorLabel(people.terminal, byKey, "You"), "Claude Code");
  assert.equal(actorDetail(people.terminal, byKey, "You"), "Claude Code · Opus 5.5");
  assert.equal(actorDetail(people.director, byKey, "You"), undefined, "nothing more than the slot: no tooltip");
  assert.equal(actorLabel({ key: "system/carton", kind: "system", name: "" }, byKey, "You"), "", "a system row names no one");
  assert.equal(actorLabel(people.alice, byKey, "You"), "You");
  assert.equal(actorLabel(people.bob, byKey, "You"), "Bob Okafor");
  assert.equal(actorLabel(people.director, byKey, "You"), "Director", "your own agent");
  assert.equal(actorLabel(people.bobsDirector, byKey, "You"), "Bob Okafor's Director", "someone else's agent, by its owner");
  assert.deepEqual(actorChain(people.explore, byKey).map((a) => a.subagentType ?? a.name), ["Alice Moreau", "Director", "Explore"]);
  assert.equal(initials("Bob Okafor"), "BO");
  assert.equal(initials("Émile"), "É");
  assert.equal(initials("  "), "?");
});

test("words: the §0.1 status words and plurals", () => {
  assert.equal(words.offline(1), "Offline: 1 edit waiting");
  assert.equal(words.offline(3), "Offline: 3 edits waiting");
  assert.equal(words.syncing, "Syncing");
  assert.equal(words.upToDate, "Up to date");
  assert.equal(words.foldInto("Main cut"), "Fold into Main cut");
  assert.equal(words.undoLabel("Director", "tighter intro"), "Undo Director: tighter intro");
});

test("mock history: 10k versions, filters, newest first, indexOf in O(log n)", () => {
  const ui = createMockUi({ versions: 10_000, seed: 3, provisional: true });
  const h = ui.history();
  // the generated versions, the start, the story's 12 and 2 not sent yet
  assert.equal(h.count("all"), 10_015);
  const newest = h.at("all", 0)!;
  assert.equal(newest.provisional, true);
  assert.equal(h.indexOf("all", newest.id), 0);
  assert.ok(h.count("named") >= 20);
  assert.ok(h.count("turns") > 1000);
  for (let i = 0; i < h.count("named"); i++) assert.ok(h.at("named", i)!.name);
  const t = h.at("turns", 5)!;
  assert.equal(t.kind, "turn");
  assert.equal(h.indexOf("turns", t.id), 5);
  assert.equal(h.indexOf("named", t.id) >= -1, true);
  const r0 = h.revision();
  ui.addVersion({ author: people.bob });
  assert.equal(h.count("all"), 10_016);
  assert.ok(h.revision() > r0);
});
