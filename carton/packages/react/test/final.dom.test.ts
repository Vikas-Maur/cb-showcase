// The laptop's UI re-check of the final candidate (merge/prod-2 @ 0cc587f1, 2026-11-02, docs/regress/final/ui), in a
// DOM: what it found in the real app. `npm test` runs this file on React 19 and on preact/compat.
import { $, $$, React, act, click, cleanup, closeDom, flush, render, runtime } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, HistoryPanel, PreviewBanner } from "../src/index.ts";
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

// N2: with a clip selected *before* the preview opened, one Esc both deselected it and left the preview. Cardboard's
// properties panel clears the selection on Esc from a window listener it registers again on every selection change, so
// a selection made before the preview put its listener ahead of the banner's: the banner read the selection already
// cleared and took the Esc for its own. Selected during the preview, its listener came after the banner's and it worked.
for (const order of ["before", "during"] as const)
  test(name(`final N2: a clip selected ${order} the preview: the first Esc deselects it, the second returns`), async () => {
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
    const m = await render(wrap(ui, h(PreviewBanner, { escapeState: () => selection })));
    await act(async () => { ui.openPreview("main@3", "the version from 9:13 PM"); });
    await flush();
    if (order === "during") select(["w6"]);
    assert.deepEqual(selection, ["w6"]);
    await press(document.body, "Escape");
    assert.deepEqual(selection, [], "the first Esc deselects the clip");
    assert.ok(ui.preview(), "and the preview stays");
    await press(document.body, "Escape");
    assert.equal(ui.preview(), null, "the second Esc returns from the preview");
    window.removeEventListener("keydown", deselect!);
    await m.unmount();
  });

// N3 (and baseline P3-9): Enter on a History row previewed it, and also reached Cardboard's own Enter (a window listener
// that opens the selected title's text editor on the stage, and checks only the target's tag, not defaultPrevented): a
// text editor inside the read-only preview, whose typing was dropped. The keys the list acts on are the list's alone
// (Enter opens the row's card now, and Space plays its changes: docs/carton-ux DESIGN §7); the others (Ctrl+Z, Esc with
// no card open) still reach the editor.
test(name("final N3: the keys a History row acts on never reach the editor's own window listeners"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  await flush();
  const seen: string[] = [];
  const editor = (e: KeyboardEvent) => seen.push(e.key);
  window.addEventListener("keydown", editor);
  const list = $(m.container, "[role=listbox]")!;
  list.focus();
  // ending on the third row: a confirmed version (the mock's two newest are still syncing: nothing to open)
  for (const k of ["End", "Home", "PageDown", "PageUp", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowUp"]) assert.equal((await press(list, k)).defaultPrevented, true, k);
  assert.ok($(m.container, ".carton-version[data-active]"), "a version is picked");
  const enter = await press(list, "Enter");
  assert.equal(enter.defaultPrevented, true);
  await flush();
  assert.ok($(m.container, ".carton-card-version"), "Enter opens the picked row's card");
  assert.equal(ui.viewing(), null, "and shows nothing else on the stage");
  assert.equal((await press(list, " ")).defaultPrevented, true, "Space plays the row's changes");
  await press(list, "z");
  window.removeEventListener("keydown", editor);
  assert.deepEqual(seen, ["z"], "only the keys the list doesn't act on reach the editor");
  await m.unmount();
});

// N4: a version of one change, opened, read "Hide the changes". Its successor (docs/carton-ux DESIGN §6.1): a version's
// count reads "1 change" or "N changes", and a person's run of changes lists its versions from its chevron, named for
// what it does ("Show these 6 changes", then "Hide these 6 changes").
test(name("final N4: one change reads \"1 change\"; a group's chevron says what it shows and hides"), async () => {
  const ui = createMockUi({ versions: 10 });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  await flush();
  const codex = $$(m.container, ".carton-version").find((r) => /Trimmed “Product close-up”/.test(r.textContent ?? ""))!;
  assert.match($(codex, ".carton-version-meta")!.textContent ?? "", /^Codex1 change$/);
  const chevron = () => $(m.container, ".carton-version[data-group] .carton-version-group")!;
  assert.equal(chevron().getAttribute("aria-label"), "Show these 6 changes");
  assert.equal($$(m.container, ".carton-version[data-child]").length, 0);
  await click(chevron());
  await flush();
  assert.equal(chevron().getAttribute("aria-label"), "Hide these 6 changes");
  assert.equal(chevron().getAttribute("aria-expanded"), "true");
  assert.equal($$(m.container, ".carton-version[data-child]").length, 5, "its five older versions, one by one (its newest is its own row: design QA G10)");
  assert.equal($(m.container, ".carton-card-version"), null, "the chevron lists them; it opens no card");
  await m.unmount();
});

// Baseline P3-12b: "Folded the rest of 'Client review' into 'Main cut'" showed the ↺ (restore) mark; a fold shows the fold
// mark, as "Folded 'Client review' into 'Main cut': 1 of 2 changes" does. (fromCarton gives it the fold kind:
// from-carton.test.ts.) An undo has its own mark now, apart from a restore's (AUDIT H7).
test(name("final P3-12b: the rest of a partial fold has the fold mark; an undo and a restore each their own"), async () => {
  const ui = createMockUi({ versions: 10 });
  await act(async () => { ui.addVersion({ kind: "fold", summary: "Folded the rest of 'Client review' into 'Main cut': 1 change" } as never); });
  await act(async () => { ui.addVersion({ kind: "undo", summary: "Undid the restore" } as never); });
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
  await flush();
  const icon = (text: string) => $$(m.container, ".carton-version").find((r) => r.textContent?.includes(text))?.querySelector("[data-icon]")?.getAttribute("data-icon");
  assert.equal(icon("Folded the rest of"), "foldIn");
  assert.equal(icon("Undid the restore"), "undo");
  assert.equal(icon("Restored the"), "restoreArc");
  await m.unmount();
});
