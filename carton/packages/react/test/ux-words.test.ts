// The UX redesign's words and rows (docs/carton-ux PLAN 0.3, 0.4, 0.9): the removed words are gone, History's group and
// start rows, one clock with am/pm and one label for a version. Pure, no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clock, clockOfDay, shortPrompt, timecode, versionLabel, versionShort } from "../src/format.ts";
import { dayNumber, GROUP_GAP_MS, groupHistory, type HistoryRow } from "../src/history-groups.ts";
import { rowTops, windowRangeOf } from "../src/virtual.ts";
import { createMockUi, people } from "../src/mock.ts";
import { words } from "../src/words.ts";
import type { Actor, Version } from "../src/model.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../../..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return f === "test" || f === "node_modules" ? [] : files(p);
    return /\.(ts|js|mjs)$/.test(f) ? [p] : [];
  });

test("0.3: none of the removed words is left in @carton/react's src/ or scripts/carton/", () => {
  const REMOVED = ["Read-only", "Return to current", "Previewing", "Checkpoint", "Section", "unchanged shot", "Shown in the player", "Watch the changes", "Showing now", "conflict card waiting", "Waiting to sync"];
  const found: string[] = [];
  for (const f of [...files(path.join(ROOT, "carton/packages/react/src")), ...files(path.join(ROOT, "scripts/carton"))]) {
    const text = readFileSync(f, "utf8");
    for (const w of REMOVED) if (text.includes(w)) found.push(`${path.relative(ROOT, f)}: ${w}`);
  }
  assert.deepEqual(found, []);
});

test("0.3: every word of DESIGN §8 the components need is in words.ts, counted in changes", () => {
  assert.equal(words.changes(1), "1 change");
  assert.equal(words.changes(7), "7 changes");
  assert.equal(words.changesOf(2, 3), "2 of 3 changes");
  assert.equal(words.changesSince(7), "Your edit has 7 changes since this");
  assert.equal(words.changesSoFar(2), "2 changes so far");
  assert.equal(words.keepEditing("Director"), "Keep editing. Director sees your changes when its turn ends.");
  assert.equal(words.dayVersions(23, 2), "23 versions · 2 named", "version only for a folded day");
  assert.equal(words.restoreBody(4), "Your edit goes back to how it was then. The 4 changes made since are undone. They stay in History, and Ctrl+Z brings them back.");
  assert.equal(words.undoThisTurnHint(4), "Takes out only these 4 changes. Later changes stay.");
  assert.equal(words.foldInN(3), "Fold in 3 changes");
  assert.equal(words.leftOutLine(1, "30s Instagram cut"), "1 change is left out. It stays on “30s Instagram cut”, and you can fold it in later.");
  assert.equal(words.offlineChip(3), "Offline · 3 changes not sent yet");
  assert.equal(words.notSentYet, "Not sent yet");
  // a label that ends in an ellipsis takes no full stop after it (design QA G21: never "…”.")
  assert.equal(words.lookingAt("Director's “Add captions…”"), "You're looking at Director's “Add captions…”");
  assert.equal(words.lookingAt("“Sent to client”"), "You're looking at “Sent to client”.");
  assert.equal(words.conflictsToPick(2), "2 conflicts to pick");
});

// ---------------------------------------------------------------- 0.9: one clock, one label
const NOW = new Date(2026, 10, 3, 12, 48).getTime(); // Tue Nov 3 2026, 12:48 pm local
const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime();

test("0.9: clock(): always am/pm, 'yesterday at', then the date; in the locale's 12-hour form", () => {
  assert.equal(clock(at(3, 12, 41), { now: NOW, locale: "en-US" }), "12:41 pm");
  assert.equal(clock(at(3, 9, 5), { now: NOW, locale: "en-US" }), "9:05 am");
  assert.equal(clock(at(2, 16, 10), { now: NOW, locale: "en-US" }), "yesterday at 4:10 pm");
  assert.equal(clock(new Date(2026, 9, 30, 16, 10).getTime(), { now: NOW, locale: "en-US" }), "Oct 30 at 4:10 pm");
  assert.equal(clock(new Date(2025, 9, 30, 16, 10).getTime(), { now: NOW, locale: "en-US" }), "Oct 30, 2025 at 4:10 pm");
  // a locale whose own clock is 24-hour still gets its 12-hour form: never a bare H:MM beside a timecode
  assert.equal(clock(at(3, 16, 10), { now: NOW, locale: "en-GB" }), "4:10 pm");
  assert.match(clockOfDay(at(3, 16, 10), "de-DE"), /^4:10\s?(pm|PM|nachm\.)$/);
  for (const loc of ["en-US", "en-GB", "fr-FR", "ja-JP"]) assert.doesNotMatch(clock(at(3, 16, 10), { now: NOW, locale: loc }), /^\d{1,2}:\d{2}$/, loc);
});

const you: Actor = { ...people.alice };
const leo: Actor = { key: "human/leo", kind: "human", name: "Leo" };
const director: Actor = people.director;
const v = (over: Partial<Version>): Version => ({ id: "v", seq: 1, ref: "main@1", at: at(3, 12, 41), author: you, kind: "edit", summary: "", ...over }) as Version;

test("0.9: versionLabel(): the name, an agent's prompt (24 characters, never ending on a small word), or 'your edit from 12:41 pm'", () => {
  const ctx = { now: NOW, locale: "en-US" };
  assert.equal(versionLabel(v({ name: "Sent to client" }), ctx), "“Sent to client”");
  assert.equal(versionLabel(v({ author: director, kind: "turn", name: "Add captions to the interview", turn: { label: "Add captions to the interview", edits: 12 } }), ctx), "Director's “Add captions…”");
  assert.equal(versionLabel(v({ author: people.terminal, kind: "turn", turn: { label: "Tighten the intro and add a lower third", edits: 4 } }), ctx), "Claude Code's “Tighten the intro…”");
  assert.equal(versionLabel(v({}), ctx), "your edit from 12:41 pm");
  assert.equal(versionLabel(v({}), { ...ctx, start: true }), "Your edit from 12:41 pm");
  assert.equal(versionLabel(v({ author: leo }), ctx), "Leo's edit from 12:41 pm");
  assert.equal(versionLabel(v({ at: at(2, 16, 10) }), ctx), "your edit from yesterday at 4:10 pm");
  assert.equal(versionShort(v({ author: director }), { ...ctx, actor: (k) => (k === you.key ? you : undefined) }), "12:41 pm · Director");
  assert.equal(shortPrompt("Add captions to the interview"), "Add captions…");
  assert.equal(shortPrompt("Tighten the intro and add a lower third"), "Tighten the intro…");
  assert.equal(shortPrompt("Fix the jump cut"), "Fix the jump cut");
  assert.equal(shortPrompt("Remove the silences.\nThen tighten."), "Remove the silences");
  assert.equal(timecode(9), "0:09");
  assert.equal(timecode(75.4), "1:15");
  assert.equal(timecode(3725), "1:02:05");
});

test("0.9: no other place formats a version's time for display (one clock, in format.ts)", () => {
  const found: string[] = [];
  for (const f of [...files(path.join(ROOT, "carton/packages/react/src")), ...files(path.join(ROOT, "scripts/carton"))]) {
    if (f.endsWith(path.join("src", "format.ts"))) continue;
    const text = readFileSync(f, "utf8");
    // the day headers (history-groups' dayLabel) say a day, never a time of one
    for (const m of text.matchAll(/toLocaleTimeString|toLocaleString\(|hour:\s*"(numeric|2-digit)"/g)) found.push(`${path.relative(ROOT, f)}: ${m[0]}`);
  }
  assert.deepEqual(found, []);
});

// ---------------------------------------------------------------- 0.4: History's groups
const H = 3_600_000, MIN = 60_000;
const base = new Date(2026, 10, 3, 15, 0).getTime();
const r = (id: string, t: number, over: Partial<Version> = {}) => ({ id, at: t, kind: "edit", summary: id, author: you, ref: id, seq: 0, changes: 1, ...over }) as unknown as Version;
const keys = (rows: HistoryRow[]) => rows.map((x) => (x.kind === "group" ? `[${x.ids.join(",")}]` : x.kind === "day" ? "day" : x.kind === "start" ? `start(${x.ids.join(",")})` : x.id));

test("0.4: a person's run of edits is one row, at most 10 min apart; a named version or an agent's turn breaks it", () => {
  const all = [
    r("root", base - 5 * H, { start: "created", author: { key: "system/carton", kind: "system", name: "" } }),
    r("imp", base - 5 * H + 1000, { start: "created" }),
    r("y1", base - 4 * H), r("y2", base - 4 * H + 5 * MIN), r("y3", base - 4 * H + 14 * MIN),
    r("gap", base - 4 * H + 14 * MIN + GROUP_GAP_MS + 1),
    r("named", base - 3 * H, { name: "Sent to client" }),
    r("m1", base - 3 * H + MIN), r("m2", base - 3 * H + 2 * MIN, { changes: 3 }),
    r("turn", base - 2 * H, { kind: "turn", author: director, turn: { label: "Add captions", edits: 2 } }),
    r("m3", base - 2 * H + MIN),
    r("leo1", base - H, { author: leo }), r("leo2", base - H + MIN, { author: leo }),
    r("m4", base - 30 * MIN), r("m5", base - 29 * MIN),
  ];
  const rows = groupHistory(all, () => false, { group: true });
  assert.deepEqual(keys(rows), ["day", "[m5,m4]", "[leo2,leo1]", "m3", "turn", "[m2,m1]", "named", "gap", "[y3,y2,y1]", "start(imp,root)"]);
  const top = rows[1] as Extract<HistoryRow, { kind: "group" }>;
  assert.equal(top.now, true, "the newest row is flagged now");
  assert.equal(rows.filter((x) => "now" in x && x.now).length, 1);
  assert.deepEqual([top.count, (rows[5] as Extract<HistoryRow, { kind: "group" }>).count], [2, 4], "counted in changes: 1 + 3");
  assert.equal(top.author.key, you.key);
  // the start rows merge into one, at the bottom, with no menu (its own row kind)
  const start = rows.at(-1) as Extract<HistoryRow, { kind: "start" }>;
  assert.deepEqual([start.kind, start.imported, start.id], ["start", false, "root"]);
  // an open group lists its older versions under it, as children: its newest is its own row (design QA G10)
  const open = groupHistory(all, () => false, { group: true, open: (k) => k === top.key });
  assert.deepEqual(keys(open).slice(1, 4), ["[m5,m4]", "m4", "[leo2,leo1]"]);
  assert.ok(open[2]!.kind === "version" && open[2]!.child);
  // without `group`, the day groups alone, as before
  assert.equal(groupHistory(all, () => false).filter((x) => x.kind === "version").length, all.length);
  // an imported project's start: "History starts here"
  const imported = groupHistory([r("root", base - H, { start: "created" }), r("imp", base - H + 1, { start: "imported" }), r("e", base)], () => false, { group: true });
  assert.equal((imported.at(-1) as Extract<HistoryRow, { kind: "start" }>).imported, true);
});

test("0.4: an agent turn's versions are one row, its newest; a turn and a person's edits never share a row", () => {
  const all = [
    r("e1", base - 40 * MIN),
    r("t1", base - 30 * MIN, { author: director, run: "c1/t1#main@2" }), r("t2", base - 29 * MIN, { author: director, run: "c1/t1#main@2" }),
    r("t3", base - 28 * MIN, { author: director, kind: "turn", run: "c1/t1#main@2", turn: { label: "Add captions", edits: 3 } }),
    r("e2", base - 20 * MIN),
    r("u1", base - 10 * MIN, { author: director, kind: "turn", run: "c1/t2#main@6", turn: { label: "Trim", edits: 1 } }),
  ];
  const rows = groupHistory(all, () => false, { group: true });
  assert.deepEqual(keys(rows), ["day", "u1", "e2", "t3", "e1"]);
  assert.deepEqual((rows[3] as Extract<HistoryRow, { kind: "version" }>).turn, ["t2", "t1"]);
  assert.equal((rows[1] as Extract<HistoryRow, { kind: "version" }>).turn, undefined, "a turn of one version");
});

test("0.4: a group never crosses a day, and a folded day hides its groups but keeps its named versions", () => {
  const today = dayNumber(base);
  const all = [r("a1", base - 24 * H - 2 * MIN), r("a2", base - 24 * H, { name: "Rough cut" }), r("a3", base - 24 * H + MIN), r("b1", base - 2 * MIN), r("b2", base)];
  const rows = groupHistory(all, (day) => day !== today, { group: true });
  assert.deepEqual(keys(rows), ["day", "[b2,b1]", "day", "a2"]);
  const folded = rows[2] as Extract<HistoryRow, { kind: "day" }>;
  assert.deepEqual([folded.count, folded.hidden], [3, 2]);
});

test("0.4: 12k versions grouped in one pass; the list renders only the rows on screen (≤ viewport/56 + overscan)", () => {
  const ui = createMockUi({ versions: 12_000 });
  const all = ui.history().all!();
  assert.ok(all.length > 12_000);
  const t0 = performance.now();
  const rows = groupHistory(all, (_d, newest) => !newest, { group: true });
  const ms = performance.now() - t0;
  assert.ok(rows.length > 0);
  const ROW = 56, DAY = 32, viewport = 600, overscan = 6;
  const tops = rowTops(rows.length, (i) => (rows[i]!.kind === "day" ? DAY : ROW));
  for (const scrollTop of [0, 2000, 20_000]) {
    const [s, e] = windowRangeOf(scrollTop, viewport, tops, rows.length, overscan);
    assert.ok(e - s <= Math.ceil(viewport / DAY) + 1 + 2 * overscan, `${e - s} rows rendered at ${scrollTop}px`);
  }
  // all open: still only the rows on screen
  const open = groupHistory(all, () => false, { group: true });
  const topsOpen = rowTops(open.length, (i) => (open[i]!.kind === "day" ? DAY : ROW));
  const [s, e] = windowRangeOf(150_000, viewport, topsOpen, open.length, overscan);
  assert.ok(e - s <= Math.ceil(viewport / ROW) + 1 + 2 * overscan + Math.ceil(viewport / DAY), `${e - s} rows`);
  console.log(`  (grouped ${all.length} versions into ${open.length} rows in ${ms.toFixed(1)} ms, unverified)`);
});

test("the mock's view model: the story's changes, labels and the clip filter", async () => {
  const now = new Date(2026, 10, 3, 12, 48).getTime();
  const ui = createMockUi({ versions: 40, now });
  const h = ui.history();
  const top = h.at("all", 0)!;
  assert.equal(versionLabel(top, { now, start: true }), "Claude Code's “Tighten the intro…”");
  const card = await ui.changesIn(top.id);
  assert.deepEqual(card.map((c) => `${timecode(c.at!)} ${c.text}`), ["0:02 Trimmed “Intro”, now ends at 0:05", "0:05 Moved “Summer launch” 1 s earlier (now starts at 0:05)", "0:12 Added lower third “Jane Smith, Founder”", "0:22 Removed “B-roll 3”"]);
  const dir = h.all!().find((x) => x.name === "Add captions to the interview")!;
  const since = await ui.changes(dir.ref, top.ref);
  assert.equal(since.length, 7, "Your edit has 7 changes since this");
  assert.ok(since.every((c) => c.at === undefined || (c.at >= 0 && c.at <= 38)));
  assert.equal(ui.counts.changes, 1);
  await ui.view({ kind: "version", versionId: dir.id });
  assert.deepEqual([ui.viewing()!.label, ui.viewing()!.short], ["Director's “Add captions…”", "12:20 pm · Director"]);
  await ui.view({ kind: "before", versionId: dir.id });
  assert.equal(ui.viewing()!.label, "Before Director's “Add captions…”");
  await ui.view({ kind: "cut", cutId: "cut-bob-main" });
  assert.equal(ui.viewing()!.label, "Bob's Main cut");
  await ui.view({ kind: "conflict", conflictId: ui.conflicts()[0]!.id, side: "theirs" });
  assert.equal(ui.viewing()!.label, "Director's move of “Intro”");
  await ui.view(null);
  assert.equal(ui.viewing(), null);
  const ids = (await ui.clipVersions("item-interview-b")).ids;
  assert.ok(ids.length >= 4);
  assert.equal(h.count({ item: "item-interview-b" }), ids.length);
  ui.setWorking("director");
  assert.deepEqual([ui.working()!.label, ui.working()!.edits], ["Add music under the interview", 2]);
});
