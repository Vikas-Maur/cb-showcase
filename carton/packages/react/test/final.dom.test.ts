// The laptop's UI re-check of the final candidate (merge/prod-2 @ 0cc587f1, 2026-11-02, docs/regress/final/ui), in a
// DOM: what it found in the real app. `npm test` runs this file on React 19 and on preact/compat.
import { $, React, act, cleanup, closeDom, flush, render, runtime } from "./dom.ts";
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
// text editor inside the read-only preview, whose typing was dropped. The keys the list acts on are the list's alone;
// the others (Space to play, Ctrl+Z, Esc) still reach the editor.
test(name("final N3: the keys a History row acts on never reach the editor's own window listeners"), async () => {
  const ui = createMockUi({ versions: 10 });
  const opened: string[] = [];
  const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600, onOpen: (v: { id: string }) => opened.push(v.id) })));
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
  assert.equal(opened.length, 1, "Enter opens the picked row");
  await press(list, " ");
  await press(list, "z");
  window.removeEventListener("keydown", editor);
  assert.deepEqual(seen, [" ", "z"], "only the keys the list doesn't act on reach the editor");
  await m.unmount();
});
