// Conflict cards (docs/carton-ux PLAN 7.1-7.3), in a DOM (React, then preact/compat): the card says in words what each
// side did; its sides are a radio group that only picks; "See it" views a side (kind "conflict") and nothing else
// does; one primary button names the pick; no two buttons on a card read the same; one card at a time with "1/2 ›",
// "Not now" into the pill; a line during the other side's agent turn; a pick on values that changed since asks again.
import { $, $$, React, byText, cleanup, click, closeDom, flush, key, render, runtime } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, ConflictList, ConflictStack } from "../src/index.ts";
import { createMockUi, people } from "../src/mock.ts";
import type { CartonUi, Conflict, ConflictChoice } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;

const now = Date.now();
// The mockups' cards (after/conflict-card.png, conflict-keep-both.png, conflict-same-person.png)
const interviewB = (over: Partial<Conflict> = {}): Conflict => ({
  id: "c-interview",
  path: "items/interview-b/#time",
  title: "'Interview B' timing",
  mine: { author: people.alice, summary: "Moved 0:05.0 → 0:18.0", at: now - 150_000, text: "Moved it to start at 0:18", did: "moved it", what: "move" },
  theirs: { author: people.terminal, summary: "Moved 0:05.0 → 0:20.0", at: now - 10_000, text: "Moved it to start at 0:20", did: "moved it", what: "move" },
  canKeepBoth: false,
  provisional: "mine",
  sig: "18|20",
  item: "item-interview-b",
  clip: "Interview B",
  ...over,
});
const tone = (): Conflict => ({
  id: "c-tone",
  path: "items/tone/mediaItemId",
  title: "'Tone.mp3' media",
  mine: { author: people.alice, summary: "'Tone.mp3'", at: now - 300_000, text: "Kept “Tone.mp3” from 0:00", did: "kept it", what: "edit" },
  theirs: { author: people.leo, summary: "'Upbeat.wav'", at: now - 180_000, text: "Replaced it with “Upbeat.wav”", did: "replaced it", what: "edit" },
  canKeepBoth: true,
  both: "Leo's music on a new track under yours",
  provisional: "mine",
  clip: "Tone.mp3",
});
const twice = (): Conflict => ({
  id: "c-twice",
  path: "media/m1/data/content",
  title: "'Summer launch' text",
  mine: { author: people.alice, summary: "\"Summer sale\"", at: new Date(2026, 10, 3, 10, 5).getTime(), text: "Changed it to “Summer sale”", did: "changed its text", what: "edit" },
  theirs: { author: people.alice, summary: "\"Summer launch\"", at: new Date(2026, 10, 3, 10, 4).getTime(), text: "Changed it to “Summer launch”", did: "changed its text", what: "edit" },
  canKeepBoth: false,
  provisional: "theirs",
  clip: "Summer launch",
});

const radios = (card: Element) => $$(card, "[role=radio]");
const checked = (card: Element) => radios(card).find((r) => r.getAttribute("aria-checked") === "true")?.dataset.choice;
const primary = (card: Element) => $(card, ".carton-conflict-actions .carton-btn[data-variant=primary]")!.textContent;
const buttonNames = (card: Element) => $$(card, "button").map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "");
/** Spy on resolve, so a test sees what a Keep sends. */
const spyResolve = (ui: CartonUi) => {
  const sent: [string, ConflictChoice][] = [];
  const real = ui.resolve.bind(ui);
  ui.resolve = async (id, choice) => {
    sent.push([id, choice]);
    return real(id, choice);
  };
  return sent;
};

test(name("7.1: the card says what each side did in words; the radios only pick, starting on the side shown; Keep names the pick"), async () => {
  const ui = createMockUi({ versions: 5 });
  ui.setConflicts([interviewB()]);
  const sent = spyResolve(ui);
  const m = await render(wrap(ui, h(ConflictList)));
  await flush();
  const card = $(m.container, ".carton-conflict")!;
  assert.equal($(card, ".carton-card-title")!.textContent, "“Interview B”: you and Claude Code both moved it");
  assert.equal($(card, ".carton-card-sub")!.textContent, "Pick the one to keep. Until you pick, yours is in the timeline.");
  assert.deepEqual($$(card, ".carton-conflict-name").map((e) => e.textContent), ["Yours", "Claude Code's"]);
  assert.deepEqual($$(card, ".carton-conflict-what").map((e) => e.textContent), ["Moved it to start at 0:18", "Moved it to start at 0:20"]);
  assert.match($$(card, ".carton-conflict-who")[0]!.textContent ?? "", /^Yours · 2 min ago$/);
  assert.equal($(card, "[role=radiogroup]")!.getAttribute("aria-label"), "Pick the one to keep");
  assert.equal(checked(card), "mine", "starts on the side the timeline shows");
  assert.equal(primary(card), "Keep yours");
  // picking only picks: the stage doesn't change
  await click($$(card, ".carton-conflict-side")[1]);
  assert.equal(checked(card), "theirs");
  assert.equal(primary(card), "Keep Claude Code's", "the primary button names the pick");
  assert.equal(ui.viewing(), null, "picking a radio never changes viewing()");
  // keyboard: ↑ ↓ pick, Enter keeps
  await key(radios(card)[1], "ArrowDown");
  assert.equal(checked(card), "mine", "↓ wraps to the first side");
  await key(radios(card)[0], "ArrowUp");
  assert.equal(checked(card), "theirs");
  assert.equal(ui.viewing(), null);
  await key(radios(card)[1], "Enter");
  await flush();
  assert.deepEqual(sent, [["c-interview", "theirs"]], "Enter keeps the picked side");
  assert.equal($(m.container, ".carton-conflict"), null, "the card goes once picked");
  await m.unmount();
});

test(name("7.1: the lead says the other side is in the timeline when core kept it (a late conflict)"), async () => {
  const ui = createMockUi({ versions: 5 });
  ui.setConflicts([interviewB({ provisional: "theirs" })]);
  const m = await render(wrap(ui, h(ConflictList)));
  await flush();
  const card = $(m.container, ".carton-conflict")!;
  assert.equal($(card, ".carton-card-sub")!.textContent, "Pick the one to keep. Until you pick, Claude Code's is in the timeline.");
  assert.equal(checked(card), "theirs");
  assert.equal(primary(card), "Keep Claude Code's", "the default keeps what is on screen");
  await m.unmount();
});

test(name("7.1: See it views a side (kind conflict) with its label; Seeing it, Esc or deciding comes back"), async () => {
  const ui = createMockUi({ versions: 5 });
  ui.setConflicts([interviewB(), tone()]);
  const sent = spyResolve(ui);
  const m = await render(wrap(ui, h(ConflictStack)));
  await flush();
  const card = () => $(m.container, ".carton-conflict")!;
  const see = (k: "mine" | "theirs") => $(card(), `.carton-conflict-side[data-side=${k}] .carton-see`)!;
  assert.equal(see("theirs").textContent, "See it");
  assert.equal(see("theirs").getAttribute("aria-label"), "See Claude Code's");
  assert.equal(see("mine").getAttribute("aria-label"), "See yours");
  await click(see("theirs"));
  const v = ui.viewing();
  assert.deepEqual(v && { kind: v.kind, conflictId: v.conflictId, side: v.side, label: v.label }, { kind: "conflict", conflictId: "c-interview", side: "theirs", label: "Claude Code's move of “Interview B”" });
  assert.equal(see("theirs").textContent, "Seeing it");
  assert.equal(see("theirs").getAttribute("aria-pressed"), "true");
  assert.equal(checked(card()), "mine", "seeing a side doesn't pick it");
  assert.ok($(m.container, ".carton-conflict"), "seeing a side keeps its card open (it isn't viewing elsewhere)");
  // picking while seeing leaves the stage as it is
  await click($$(card(), ".carton-conflict-side")[1]);
  assert.equal(ui.viewing()?.side, "theirs");
  // See it again comes back
  await click(see("theirs"));
  assert.equal(ui.viewing(), null);
  // Esc comes back first, then is "Not now"
  await click(see("mine"));
  assert.equal(ui.viewing()?.label, "Your move of “Interview B”");
  await key(radios(card())[0], "Escape");
  assert.equal(ui.viewing(), null, "the first Esc comes back to your edit");
  assert.ok($(m.container, ".carton-conflict"), "and leaves the card");
  await key(radios(card())[0], "Escape");
  assert.ok($(m.container, ".carton-stack-pill"), "the next Esc is Not now");
  assert.deepEqual(sent, [], "nothing decided");
  // deciding while seeing comes back first
  await click($(m.container, ".carton-stack-pill"));
  await flush();
  assert.match(card().textContent ?? "", /Tone\.mp3/, "the card set aside went to the back of the queue");
  await click(see("theirs"));
  assert.equal(ui.viewing()?.kind, "conflict");
  await click($(card(), ".carton-conflict-actions .carton-btn[data-variant=primary]"));
  assert.equal(ui.viewing(), null, "deciding brings you back");
  assert.deepEqual(sent, [["c-tone", "mine"]]);
  await m.unmount();
});

test(name("7.1: no two buttons on a card read the same, for every kind of card"), async () => {
  const ui = createMockUi({ versions: 5 });
  ui.setConflicts([interviewB(), tone(), twice()]);
  const m = await render(wrap(ui, h(ConflictList)));
  await flush();
  const cards = $$(m.container, ".carton-conflict");
  assert.equal(cards.length, 3);
  for (const card of cards) {
    const names = buttonNames(card);
    assert.equal(new Set(names).size, names.length, "unique: " + names.join(" | "));
  }
  // every primary name for every pick differs too
  for (const card of cards) {
    const seen = new Set<string>();
    for (const r of radios(card)) {
      await click(r.closest(".carton-conflict-side"));
      seen.add(primary(card) ?? "");
    }
    assert.equal(seen.size, radios(card).length, [...seen].join(" | "));
  }
  await m.unmount();
});

test(name("7.1: two changes by one person read as the earlier and the later one, with clock times"), async () => {
  const ui = createMockUi({ versions: 5 });
  ui.setConflicts([twice()]);
  const m = await render(wrap(ui, h(ConflictList)));
  await flush();
  const card = $(m.container, ".carton-conflict")!;
  assert.equal($(card, ".carton-card-title")!.textContent, "“Summer launch”: two of your changes disagree");
  assert.equal($(card, ".carton-card-sub")!.textContent, "You changed its text twice, from two places, at nearly the same time.");
  assert.deepEqual($$(card, ".carton-conflict-name").map((e) => e.textContent), ["Your earlier change", "Your later change"], "in the order they were made");
  assert.match($$(card, ".carton-conflict-who")[0]!.textContent ?? "", /^Your earlier change · 10:04\s?am$/i);
  assert.equal(checked(card), "theirs");
  assert.equal(primary(card), "Keep earlier");
  await click($$(card, ".carton-conflict-side")[1]);
  assert.equal(primary(card), "Keep later");
  await key(radios(card)[1], "ArrowUp");
  assert.equal(primary(card), "Keep earlier", "↑ moves up the list as shown");
  await m.unmount();
});

test(name("7.1: Both is a third choice when both can stay, with what it makes; no See it on it"), async () => {
  const ui = createMockUi({ versions: 5 });
  ui.setConflicts([tone()]);
  const sent = spyResolve(ui);
  const m = await render(wrap(ui, h(ConflictList)));
  await flush();
  const card = $(m.container, ".carton-conflict")!;
  assert.equal($(card, ".carton-card-title")!.textContent, "“Tone.mp3”: you kept it and Leo replaced it");
  assert.equal($(card, ".carton-card-sub")!.textContent, "Pick one to keep, or keep both. Until you pick, yours is in the timeline.");
  assert.deepEqual($$(card, ".carton-conflict-name").map((e) => e.textContent), ["Yours", "Leo's", "Both"]);
  const both = $(card, ".carton-conflict-side[data-side=both]")!;
  assert.equal($(both, ".carton-conflict-what")!.textContent, "Leo's music on a new track under yours");
  assert.equal($(both, ".carton-see"), null);
  await click(both);
  assert.equal(primary(card), "Keep both");
  await click($(card, ".carton-conflict-actions .carton-btn[data-variant=primary]"));
  assert.deepEqual(sent, [["c-tone", "both"]]);
  await m.unmount();
});

test(name("7.2: one card at a time with 1/2 ›; Not now folds into the pill and sends the card to the back; one resolved elsewhere leaves"), async () => {
  const ui = createMockUi({ versions: 5 });
  ui.setConflicts([interviewB(), tone()]);
  const revealed: string[] = [];
  const m = await render(wrap(ui, h(ConflictStack, { onReveal: (c: Conflict) => revealed.push(c.id) })));
  await flush();
  assert.equal($$(m.container, ".carton-conflict").length, 1, "one card at a time");
  assert.equal($(m.container, ".carton-stack")!.getAttribute("aria-label"), "2 conflicts to pick");
  const next = () => $(m.container, ".carton-conflict-next")!;
  assert.equal(next().textContent, "1/2");
  assert.equal(next().getAttribute("aria-label"), "Next conflict (1 of 2)");
  assert.match($(m.container, ".carton-card-title")!.textContent ?? "", /Interview B/);
  // On timeline: selects the clip, without viewing
  const reveal = byText(m.container, "button", "On timeline")!;
  assert.equal(reveal.getAttribute("data-carton-tip"), "Show on timeline");
  await click(reveal);
  assert.deepEqual(revealed, ["c-interview"]);
  assert.equal(ui.viewing(), null);
  await click(next());
  assert.match($(m.container, ".carton-card-title")!.textContent ?? "", /Tone\.mp3/);
  assert.equal(next().textContent, "2/2");
  await click(next());
  assert.match($(m.container, ".carton-card-title")!.textContent ?? "", /Interview B/, "› wraps round");
  // Not now: the pill, nothing decided, the card to the back
  await click(byText(m.container, "button", "Not now"));
  const pill = $(m.container, ".carton-stack-pill")!;
  assert.equal(pill.textContent, "2 conflicts to pick");
  assert.equal($(m.container, ".carton-conflict"), null);
  assert.equal(ui.conflicts().length, 2, "Not now decides nothing");
  assert.equal(document.activeElement, pill, "focus stays with the stack");
  await click(pill);
  assert.match($(m.container, ".carton-card-title")!.textContent ?? "", /Tone\.mp3/, "the card set aside is at the back");
  assert.equal(document.activeElement?.getAttribute("role"), "radio", "the pill's card takes focus on its picked side");
  // no set-aside list, no peeking deck
  assert.equal($(m.container, ".carton-stack-aside"), null);
  assert.equal($(m.container, ".carton-stack-peek"), null);
  // a card resolved elsewhere leaves
  ui.setConflicts([interviewB()]);
  await flush();
  assert.match($(m.container, ".carton-card-title")!.textContent ?? "", /Interview B/);
  assert.equal($(m.container, ".carton-conflict-next"), null, "one card: no 1/1");
  ui.setConflicts([]);
  await flush();
  assert.equal($(m.container, ".carton-stack"), null);
  await m.unmount();
});

test(name("7.2: while the stage shows a version the stack waits as the pill; the pill brings you back and opens the card"), async () => {
  const ui = createMockUi({ versions: 5 });
  await ui.view({ kind: "version", versionId: ui.history().at("all", 2)!.id });
  assert.equal(ui.viewing()?.kind, "version");
  ui.setConflicts([interviewB()]);
  const m = await render(wrap(ui, h(ConflictStack)));
  await flush();
  assert.equal($(m.container, ".carton-conflict"), null);
  await click($(m.container, ".carton-stack-pill"));
  assert.equal(ui.viewing(), null, "back to your edit");
  assert.ok($(m.container, ".carton-conflict"));
  // the host's own collapse (a side panel open) still folds it
  await m.rerender(wrap(ui, h(ConflictStack, { collapsed: true })));
  await flush();
  assert.ok($(m.container, ".carton-stack-pill"));
  await m.unmount();
});

test(name("7.1 (host path): See it through the host's onPreview shows the side under the card's label, and Seeing it comes back"), async () => {
  const ui = createMockUi({ versions: 5 });
  ui.setConflicts([interviewB()]);
  const asked: string[] = [];
  const onPreview = (c: Conflict, side: ConflictChoice, label: string) => {
    asked.push(`${c.id} ${side} ${label}`);
    ui.openPreview(`see:${side}`, label); // what Cardboard's stage does: conflictRef, then the deprecated openPreview
  };
  const m = await render(wrap(ui, h(ConflictStack, { onPreview })));
  await flush();
  const see = () => $(m.container, ".carton-conflict-side[data-side=theirs] .carton-see")!;
  await click(see());
  assert.deepEqual(asked, ["c-interview theirs Claude Code's move of “Interview B”"]);
  assert.equal(ui.preview()?.label, "Claude Code's move of “Interview B”");
  assert.equal(see().textContent, "Seeing it");
  assert.ok($(m.container, ".carton-conflict"), "its own side on the stage doesn't fold the card");
  await click(see());
  assert.equal(ui.preview(), null, "Seeing it comes back");
  await m.unmount();
});

test(name("7.1: See it that can't load says so in the card, and the stage stays on your edit"), async () => {
  const ui = createMockUi({ versions: 5 });
  ui.setConflicts([interviewB()]);
  const m = await render(wrap(ui, h(ConflictStack, { onPreview: () => Promise.reject(new Error("gone")) })));
  await flush();
  await click($(m.container, ".carton-conflict-side[data-side=theirs] .carton-see"));
  assert.equal($(m.container, ".carton-conflict [role=alert]")!.textContent, "Couldn't load this version. Try again.");
  assert.equal(ui.viewing(), null);
  await m.unmount();
});

test(name("7.3: during the other side's agent turn the card says so; a pick on values that changed since asks again"), async () => {
  const ui = createMockUi({ versions: 5 });
  ui.setConflicts([interviewB()]);
  ui.setWorking({ actor: people.terminal, label: "Tighten the intro", edits: 2, since: now - 60_000, cutId: "cut-main" });
  const sent = spyResolve(ui);
  const m = await render(wrap(ui, h(ConflictStack)));
  await flush();
  const card = () => $(m.container, ".carton-conflict")!;
  assert.equal($(card(), ".carton-conflict-turn")!.textContent, "Claude Code is still working. Pick now, or when it's done.");
  await click($$(card(), ".carton-conflict-side")[1]);
  assert.equal(primary(card()), "Keep Claude Code's");
  // Claude Code moves it again: the same card, new values
  ui.setConflicts([interviewB({ sig: "18|22", theirs: { ...interviewB().theirs, text: "Moved it to start at 0:22", summary: "Moved 0:05.0 → 0:22.0" } })]);
  await flush();
  assert.equal($(card(), ".carton-conflict-again")!.textContent, "Claude Code changed it again. Pick again.");
  assert.equal(checked(card()), "mine", "the pick made on the old values is gone");
  assert.equal(primary(card()), "Keep yours");
  assert.match(card().textContent ?? "", /0:22/);
  await click($$(card(), ".carton-conflict-side")[1]);
  assert.equal($(card(), ".carton-conflict-again"), null, "picking again clears the line");
  // the engine replaces the card (a new id on the same clip and field): the pick made on the old one asks again too
  ui.setConflicts([interviewB({ id: "c-interview-2", sig: "18|24", theirs: { ...interviewB().theirs, text: "Moved it to start at 0:24" } })]);
  await flush();
  assert.ok($(card(), ".carton-conflict-again"));
  assert.equal(checked(card()), "mine");
  // the turn ends: no line
  ui.setWorking(null);
  await flush();
  assert.equal($(card(), ".carton-conflict-turn"), null);
  await click($(card(), ".carton-conflict-actions .carton-btn[data-variant=primary]"));
  assert.deepEqual(sent, [["c-interview-2", "mine"]], "what was kept is what the card showed when picked");
  await m.unmount();
});

test(name("7.3: a pick on one card never carries to another card that is still open"), async () => {
  const ui = createMockUi({ versions: 5 });
  // two cards on the same clip and field, both open (core can raise several)
  ui.setConflicts([interviewB(), interviewB({ id: "c-interview-b2", sig: "x|y" })]);
  const m = await render(wrap(ui, h(ConflictStack)));
  await flush();
  const card = () => $(m.container, ".carton-conflict")!;
  await click($$(card(), ".carton-conflict-side")[1]);
  await click($(m.container, ".carton-conflict-next"));
  assert.equal(checked(card()), "mine");
  assert.equal($(card(), ".carton-conflict-again"), null);
  await m.unmount();
});
