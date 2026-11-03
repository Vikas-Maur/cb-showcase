// Viewing without banners (docs/carton-ux PLAN 1.1, DESIGN §4.2): ViewingFrame, the frame round the stage in place of
// PreviewBanner. Its Esc is the banner's, the same hook (useEscapeBack): the banner's Esc tests (final N2, regress #4)
// are ported here 1:1, step for step, on the frame (the banner's own still run on the banner, unchanged). `npm test`
// runs this file on React 19 and on preact/compat.
import { $, $$, React, act, cleanup, click, closeDom, flush, render, runtime } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, HistoryPanel, ViewingFrame } from "../src/index.ts";
import { createMockUi } from "../src/mock.ts";
import type { CartonUi } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;
const press = async (target: EventTarget, k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(e); await new Promise((r) => setTimeout(r, 5)); });
  return e;
};

test(name("PLAN 1.1: the frame while viewing, its label tab with the one label and ✕; nothing on your edit"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(ViewingFrame, null)));
  assert.equal($(m.container, ".carton-frame"), null, "your edit: nothing");
  await act(async () => { await ui.view({ kind: "version", versionId: ui.history().all!().at(-4)!.id }); });
  await flush();
  const frame = $(m.container, ".carton-frame")!;
  assert.ok(frame, "the frame");
  assert.equal(frame.getAttribute("data-kind"), "version");
  assert.equal($(frame, ".carton-frame-text")!.textContent, ui.viewing()!.label, "the one label");
  assert.equal($(frame, ".carton-frame-text")!.getAttribute("title"), ui.viewing()!.label, "whole in its tooltip");
  const x = $(frame, ".carton-frame-back")!;
  assert.equal(x.getAttribute("aria-label"), "Back to my edit (Esc)");
  assert.equal(x.getAttribute("aria-keyshortcuts"), "Escape");
  assert.equal($(m.container, ".carton-sr[role=status]")!.textContent, `Looking at ${ui.viewing()!.label}. Esc to go back.`, "said once");
  await click(x);
  assert.equal(ui.viewing(), null, "✕: back to your edit");
  assert.equal($(m.container, ".carton-frame"), null);
  assert.equal($(m.container, ".carton-sr[role=status]")!.textContent, "Back to your edit");
  await m.unmount();
});

test(name("PLAN 1.1: no label tab where History's list marks the row; the host's own viewing, label and way back"), async () => {
  const ui = createMockUi({ versions: 10 });
  let back = 0;
  const v = { ref: "leo@2", kind: "cut" as const, cutId: "leo", label: "Leo's Main cut", short: "Leo's Main cut" };
  const m = await render(wrap(ui, h(ViewingFrame, { viewing: v, label: false, onBack: () => { back++; }, isViewing: () => true })));
  assert.ok($(m.container, ".carton-frame"), "the frame");
  assert.equal($(m.container, ".carton-frame-label"), null, "no tab");
  await m.rerender(wrap(ui, h(ViewingFrame, { viewing: v, onBack: () => { back++; }, isViewing: () => true })));
  await click($(m.container, ".carton-frame-back"));
  assert.equal(back, 1, "the host's way back (a teammate's cut: your own cut again)");
  await m.unmount();
});

test(name("PLAN 1.4: each edit tried pulses the frame once: a new name for each, so the animation plays again"), async () => {
  const ui = createMockUi({ versions: 10 });
  const v = { ref: "main@3", kind: "version" as const, label: "Director's “Add captions…”", short: "x" };
  const m = await render(wrap(ui, h(ViewingFrame, { viewing: v, pulse: 0 })));
  assert.equal($(m.container, ".carton-frame")!.getAttribute("data-pulse"), null, "no pulse before an attempt");
  const seen: (string | null)[] = [];
  for (const pulse of [1, 2, 3]) {
    await m.rerender(wrap(ui, h(ViewingFrame, { viewing: v, pulse })));
    seen.push($(m.container, ".carton-frame")!.getAttribute("data-pulse"));
  }
  assert.deepEqual(seen, ["a", "b", "a"]);
  await m.unmount();
});

// Ported 1:1 from final.dom.test.ts "final N2" (the banner's): the same selection listener, the same steps, the frame.
for (const order of ["before", "during"] as const)
  test(name(`final N2 (frame): a clip selected ${order} viewing: the first Esc deselects it, the second returns`), async () => {
    const ui = createMockUi({ versions: 10 });
    let selection: string[] = [];
    let deselect: ((e: KeyboardEvent) => void) | null = null;
    // as Cardboard's PropertiesPanel: `useEffect(() => { Esc && selection.length && select(null) }, [selection])`
    const select = (ids: string[]) => {
      if (deselect) window.removeEventListener("keydown", deselect);
      selection = ids;
      deselect = (e: KeyboardEvent) => { if (e.key === "Escape" && selection.length > 0) select([]); };
      window.addEventListener("keydown", deselect);
    };
    if (order === "before") select(["w6"]);
    const m = await render(wrap(ui, h(ViewingFrame, { escapeState: () => selection })));
    await act(async () => { ui.openPreview("main@3", "the version from 9:13 PM"); });
    await flush();
    if (order === "during") select(["w6"]);
    assert.deepEqual(selection, ["w6"]);
    await press(document.body, "Escape");
    assert.deepEqual(selection, [], "the first Esc deselects the clip");
    assert.ok(ui.viewing(), "and viewing stays");
    await press(document.body, "Escape");
    assert.equal(ui.viewing(), null, "the second Esc returns to your edit");
    window.removeEventListener("keydown", deselect!);
    await m.unmount();
  });

// Ported 1:1 from regress.dom.test.ts "regress #4" (the banner's): every case, on the frame and its tab's ✕.
test(name("regress #4 (frame): Esc returns to your edit when the key was nobody else's, whichever handler listened first"), async () => {
  const ui = createMockUi({ versions: 10 });
  let selection: string[] = ["clip-1"];
  const m = await render(wrap(ui, h(ViewingFrame, { escapeState: () => selection })));
  const esc = async (target: EventTarget) => {
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { target.dispatchEvent(e); await new Promise((r) => setTimeout(r, 5)); });
    return e;
  };
  await act(async () => { ui.openPreview("main@3", "the version from 12:41"); });
  assert.ok($(m.container, ".carton-frame"), "viewing");
  assert.equal($(m.container, ".carton-frame-back")!.getAttribute("aria-keyshortcuts"), "Escape", "the ✕ says its key");
  // typing in a field: its Esc
  const field = document.createElement("input");
  document.body.appendChild(field);
  field.focus();
  await esc(field);
  assert.ok(ui.viewing(), "a field's Esc stays the field's");
  field.remove();
  // a layer took it in the capture phase (Radix)
  const capture = (e: Event) => e.preventDefault();
  document.addEventListener("keydown", capture, true);
  await esc(document.body);
  document.removeEventListener("keydown", capture, true);
  assert.ok(ui.viewing(), "a key a layer took stays theirs");
  // the chat's approval card, shown while viewing: its window listener comes after the frame's, skips a key already
  // taken, else takes it
  let skipped = 0;
  const approval = (e: KeyboardEvent) => { if (e.defaultPrevented) return; if (e.key === "Escape") { e.preventDefault(); skipped++; } };
  window.addEventListener("keydown", approval);
  await esc(document.body);
  window.removeEventListener("keydown", approval);
  assert.equal(skipped, 1, "the approval card got the key");
  assert.ok(ui.viewing(), "and viewing stays");
  // the properties panel clears the selection on Esc, taking nothing: that Esc was the editor's
  const deselect = (e: KeyboardEvent) => { if (e.key === "Escape" && selection.length) selection = []; };
  window.addEventListener("keydown", deselect);
  await esc(document.body);
  assert.deepEqual(selection, [], "the clip was deselected");
  assert.ok(ui.viewing(), "and viewing stays");
  // nothing selected now: the next Esc is nobody else's, and returns. The frame takes no key from anyone.
  const e = await esc(document.body);
  window.removeEventListener("keydown", deselect);
  assert.equal(ui.viewing(), null, "Esc returned to your edit");
  assert.equal(e.defaultPrevented, false, "without taking the key from a handler after it");
  assert.equal($(m.container, ".carton-frame"), null);
  await m.unmount();
});

// PLAN 1.3: what opens viewing, and nothing else. A row's click, Enter or double-click opens its card; Play on the
// newest plays on your edit.
test(name("PLAN 1.3: a row's click, Enter and double-click leave viewing null; Play on the newest leaves it null; Play on an older one views it"), async () => {
  const ui = createMockUi({ versions: 10 });
  ui.confirmAll();
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 700 })));
  await flush();
  const rows = () => $$(m.container, ".carton-version");
  const dbl = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); }); await flush(); };
  await click(rows()[2]);
  assert.ok($(m.container, ".carton-card-version"), "the click opened its card");
  assert.equal(ui.viewing(), null, "and nothing else");
  await dbl(rows()[3]);
  assert.equal(ui.viewing(), null, "a double-click views nothing");
  const list = $(m.container, "[role=listbox]")!;
  list.focus();
  await press(list, "Home");
  await press(list, "ArrowDown");
  await press(list, "Enter");
  await flush();
  assert.equal(ui.viewing(), null, "Enter views nothing");
  // the newest version's card: Play all plays on your edit
  const newest = rows().find((r) => r.hasAttribute("data-now"))!;
  if (!newest.hasAttribute("data-open")) await click(newest);
  await flush();
  const playAll = () => $$(m.container, ".carton-card-version .carton-btn").find((b) => /Play all/.test(b.textContent ?? ""));
  await click(playAll());
  await flush();
  assert.equal(ui.viewing(), null, "Play on the newest: your edit");
  // an older version's: viewing it
  const older = rows().find((r) => !r.hasAttribute("data-now") && r.getAttribute("data-kind") !== "start")!;
  await click(older);
  await flush();
  await click(playAll());
  await flush(6);
  assert.ok(ui.viewing(), "Play on an older version views it");
  assert.ok($(m.container, ".carton-version[data-viewing]"), "its row marked");
  await m.unmount();
});

// With Workstream 4's swap made at once: the frame is drawn with the swap, before the view model has labelled it; no
// tab and nothing said until the label comes, then said once; a change of label is said, the return said once.
test(name("PLAN 1.1 with WS4: a frame still waiting for its label shows no tab and says nothing; its label, when it comes"), async () => {
  const ui = createMockUi({ versions: 10 });
  const at = (label: string) => ({ ref: "main@3", kind: "before" as const, label, short: label });
  const m = await render(wrap(ui, h(ViewingFrame, { viewing: at(""), isViewing: () => true })));
  assert.ok($(m.container, ".carton-frame"), "the frame, at once");
  assert.equal($(m.container, ".carton-frame-label"), null, "no tab before the label");
  assert.equal($(m.container, ".carton-sr[role=status]")!.textContent, "", "nothing said yet");
  await m.rerender(wrap(ui, h(ViewingFrame, { viewing: at("Before Director's “Add captions…”"), isViewing: () => true })));
  assert.equal($(m.container, ".carton-frame-text")!.textContent, "Before Director's “Add captions…”");
  assert.equal($(m.container, ".carton-sr[role=status]")!.textContent, "Looking at Before Director's “Add captions…” Esc to go back.");
  // the next swap waits for its label too: the last one said stays
  await m.rerender(wrap(ui, h(ViewingFrame, { viewing: at(""), isViewing: () => true })));
  assert.equal($(m.container, ".carton-sr[role=status]")!.textContent, "Looking at Before Director's “Add captions…” Esc to go back.");
  await m.rerender(wrap(ui, h(ViewingFrame, { viewing: null, isViewing: () => false })));
  assert.equal($(m.container, ".carton-frame"), null);
  assert.equal($(m.container, ".carton-sr[role=status]")!.textContent, "Back to your edit");
  await m.unmount();
});
