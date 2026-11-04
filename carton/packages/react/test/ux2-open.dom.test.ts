// fix/ux2-open, the panel: Back to Fold in… keeps the ticks (and says plainly what it couldn't keep); the newest day
// reads as a story when it isn't today; and the Windows check of b14f8a4e: Exported says nothing of "only you", a
// landmark row says what its version changed and shows when the landmark happened, a group of edits says what it came
// to. `npm test` runs it on React 19 and on preact/compat.
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, render, runtime, waitFor } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, FoldInDialog, HistoryPanel, type FoldTicks } from "../src/index.ts";
import { createMockUi } from "../src/mock.ts";
import { clockOfDay } from "../src/format.ts";
import type { CartonUi, FoldPlan, Landmark } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;
const noon48 = (days = 0) => {
  const d = new Date();
  d.setHours(12, 48, 0, 0);
  return d.getTime() - days * 86_400_000;
};
const row = (root: HTMLElement, text: string | RegExp) => $$(root, ".carton-version").find((r) => (typeof text === "string" ? r.textContent?.includes(text) : text.test(r.textContent ?? ""))) ?? null;

// ------------------------------------------------------------------ Back to Fold in… (item 2)

test(name("Back to Fold in…: the ticks and the pick come back as they were, nothing said; a plan that changed meanwhile says what it couldn't keep"), async () => {
  const ui = createMockUi({ versions: 10 });
  let ticks: FoldTicks | null = null;
  const dialog = (m: { container: HTMLElement }) => $(m.container, "[role=dialog]")!;
  const rows = (m: { container: HTMLElement }) => $$(dialog(m), ".carton-fold-change");
  const boxes = (m: { container: HTMLElement }) => rows(m).map((r) => ($(r, "input") as HTMLInputElement | null)?.checked ?? "locked");
  const radios = (m: { container: HTMLElement }) => $$(dialog(m), "[role=radio]").map((r) => r.getAttribute("aria-checked"));
  const button = (m: { container: HTMLElement }) => $$(dialog(m), ".carton-dialog-foot button").at(-1)!.textContent;
  const m = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose: () => {}, onSideBySide: (_f: string, _i: string, t: FoldTicks) => void (ticks = t) })));
  await flush();
  // the person leaves the first change out and picks the other cut's side of the conflict
  await click($(rows(m)[0]!, ".carton-change-text"));
  await click($$(dialog(m), "[role=radio]")[1]!);
  const was = { boxes: boxes(m), radios: radios(m), button: button(m) };
  assert.equal(was.boxes[0], false);
  await click(byText(dialog(m), "button", /^See them side by side$/));
  assert.ok(ticks, "the dialog gave its choices to its host");
  const t = ticks as FoldTicks;
  assert.deepEqual([t.from, t.into, t.left.length, Object.keys(t.picks).length], ["cut-ig", "cut-main", 1, 1]);
  await m.unmount();

  // Back to Fold in…: the same ticks, the same pick, the same count, and nothing to say (a plan asked again may give
  // its changes times of their own: the rows read the same, so nothing changed)
  const planned = ui.planFold.bind(ui);
  ui.planFold = async (f, i, o) => { const pl = await planned(f, i, o); return { ...pl, changes: pl.changes.map((c) => ({ ...c, at: c.at + 1234 })) }; };
  const back = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose: () => {}, ticks: t })));
  await flush();
  assert.deepEqual({ boxes: boxes(back), radios: radios(back), button: button(back) }, was);
  assert.equal($(dialog(back), ".carton-fold-reticked"), null, "everything kept: nothing said");
  await back.unmount();

  // the cuts changed while the person compared: the change they left out went, one came, the conflict reads differently
  ui.planFold = planned;
  const plan = await ui.planFold("cut-ig", "cut-main");
  const author = plan.changes[0]!.author;
  const moved: FoldPlan = {
    ...plan,
    changes: [...plan.changes.slice(1), { id: "items/drone", summary: "Added “Drone shot”", author, at: Date.now() }],
    conflicts: plan.conflicts.map((c) => ({ ...c, sig: `${c.sig ?? c.id}|again` })),
  };
  const changed = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-ig", intoCutId: "cut-main", onClose: () => {}, ticks: t, plan: moved })));
  await flush();
  const said = $(dialog(changed), ".carton-fold-reticked");
  assert.ok(said, "it says so");
  assert.equal(said!.getAttribute("role"), "status");
  assert.equal(said!.textContent, "Some changes are different since you compared: 1 change you left out isn't there any more, 1 new change is ticked and 1 conflict to pick again. Check the ticks before you fold in.");
  assert.ok(boxes(changed).every((b) => b === true || b === "locked"), "the one left out is gone; the new one is ticked");
  assert.deepEqual(radios(changed), ["false", "false"], "a pick on a card that changed is made again");
  await changed.unmount();

  // another pair of cuts is another plan: the ticks don't carry over to it
  const other = await render(wrap(ui, h(FoldInDialog, { fromCutId: "cut-main", intoCutId: "cut-ig", onClose: () => {}, ticks: t })));
  await flush();
  assert.equal($(dialog(other), ".carton-fold-reticked"), null);
  await other.unmount();
});

// ------------------------------------------------------------------ landmark rows (items 4, 5, 6a)

test(name("landmark rows: Exported is everyone's (no “only you”), Start and Before stay yours; each says what its version changed; its time is the landmark's"), async () => {
  const ui = createMockUi({ versions: 8, now: noon48(), landmarks: true });
  // the export happened 40 minutes after its version was made
  const own = ui.landmarks!.bind(ui);
  const later = 40 * 60_000;
  ui.landmarks = async (o) => (await own(o)).map((l: Landmark) => (l.kind === "exported" ? { ...l, at: l.at + later } : l));
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 1400 })));
  await waitFor(() => !!$(m.container, ".carton-version[data-landmark=exported]"), "the exported row");
  const exported = $(m.container, ".carton-version[data-landmark=exported]")!;
  assert.doesNotMatch(exported.textContent ?? "", /only you see this/, "everyone sees an export");
  assert.match($(m.container, ".carton-version[data-landmark=before]")!.textContent ?? "", /Kept for you.*only you see this/, "a Before is yours");
  assert.match($(m.container, ".carton-version[data-landmark=start]")!.textContent ?? "", /only you see this/, "a Start is yours");
  // the title is the landmark's; the meta line says what the version itself changed, then who
  assert.match($(exported, ".carton-version-title")!.textContent ?? "", /^Exported1080p for the client$/);
  const mark = (await ui.landmarks!()).find((l) => l.kind === "exported")!;
  const v = ui.history().all!().find((x) => x.id === mark.versionId)!;
  assert.ok(v.summary, "its version says what it did");
  assert.equal($(exported, ".carton-landmark-change")!.textContent, v.summary);
  assert.ok($(exported, ".carton-landmark-change + .carton-actor-name"), "then who");
  // its time is the export's, as cb history --landmarks says it, not its version's
  const when = $(exported, ".carton-version-when")!;
  // (its text is the short time, then the exact one for hover)
  assert.ok(when.textContent!.startsWith(clockOfDay(mark.at)), when.textContent!);
  assert.equal(when.getAttribute("datetime"), new Date(mark.at).toISOString());
  assert.ok(!when.textContent!.startsWith(clockOfDay(v.at)), "not its version's");
  // an ordinary row keeps its version's time
  const plain = $$(m.container, ".carton-version").find((r) => !r.hasAttribute("data-landmark") && !r.hasAttribute("data-now") && $(r, "time"));
  const pv = ui.history().all!().find((x) => plain?.textContent?.includes(x.summary ?? "\u0000"));
  if (pv) assert.equal($(plain!, ".carton-version-when")!.getAttribute("datetime"), new Date(pv.at).toISOString());
  await m.unmount();
});

// ------------------------------------------------------------------ a group's title (item 6b)

test(name("a closed group of your edits says what they came to, never one step of them; “No change in the end” when they cancel out; opened, its newest's own sentence"), async () => {
  const ui = createMockUi({ versions: 8, now: noon48(), netWords: true });
  const asked: [string, string][] = [];
  const net = ui.netWords!.bind(ui);
  ui.netWords = async (a, b) => (asked.push([a, b]), net(a, b));
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 1400 })));
  await waitFor(() => !!$(m.container, ".carton-version[data-group]"), "a group row");
  const title = () => $(m.container, ".carton-version[data-group] .carton-version-title")!.textContent;
  await waitFor(() => asked.length > 0 && title() !== "Several edits", "its words");
  const [base, to] = asked[0]!;
  assert.match(base, /@\d+$/);
  assert.match(to, /@\d+$/);
  const want = await net(base, to);
  assert.equal(title(), want.changes && want.summary ? want.summary : "No change in the end", "the group's net words, from before its oldest to its newest");
  await m.unmount();
  // a group whose edits cancel out
  const ui2 = createMockUi({ versions: 8, now: noon48(), netWords: true });
  ui2.netWords = async () => ({ summary: "", changes: 0 });
  const m2 = await render(wrap(ui2, h(HistoryPanel, { initialHeight: 1400 })));
  await waitFor(() => $(m2.container, ".carton-version[data-group] .carton-version-title")?.textContent === "No change in the end", "no change in the end");
  // opened: the group's own row is its newest version, as before (its older ones under it)
  await click($(m2.container, ".carton-version[data-group] .carton-version-group"));
  await flush();
  assert.notEqual($(m2.container, ".carton-version[data-group] .carton-version-title")!.textContent, "No change in the end");
  await m2.unmount();
});

// ------------------------------------------------------------------ the newest day as a story (item 3)

test(name("nothing today: the newest day folds into runs between its landmarks, below its newest three changes, kept as rows"), async () => {
  // the mock's story ends yesterday at 12:48 pm: nothing happened today
  const ui = createMockUi({ versions: 8, now: noon48(1), landmarks: true });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 1600 })));
  await waitFor(() => !!$(m.container, ".carton-version[data-landmark]"), "landmarks");
  await waitFor(() => !!$(m.container, ".carton-run"), "a run row on the newest day");
  const list = $$(m.container, ".carton-day, .carton-version, .carton-run").map((r) => (r.classList.contains("carton-run") ? "run" : r.classList.contains("carton-day") ? "day" : "row"));
  assert.equal(list[0], "day", "the newest day's header (Yesterday)");
  assert.match($$(m.container, ".carton-day")[0]!.textContent ?? "", /Yesterday/);
  // its newest changes are rows (the newest reads Now), then the story
  assert.deepEqual(list.slice(1, 2), ["row"]);
  assert.ok($(m.container, ".carton-version[data-now]"), "the newest row still reads Now");
  const firstRun = list.indexOf("run");
  assert.ok(firstRun > 1, "the runs come below the kept rows: " + list.join(","));
  await m.unmount();
});
