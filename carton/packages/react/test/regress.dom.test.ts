// The laptop's regression check of the release candidate (merge/prod-2, 2026-11-02), in a DOM: what it found in the real
// app. `npm test` runs this file on React 19 and on preact/compat.
import { $, $$, React, act, click, cleanup, closeDom, flush, render, runtime } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider, HistoryPanel } from "../src/index.ts";
import { createMockUi } from "../src/mock.ts";
import type { CartonUi } from "../src/model.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const wrap = (ui: CartonUi, ...children: unknown[]) => h(CartonProvider, { ui }, ...(children as never[]));
const name = (t: string) => `${t} [${runtime}]`;
const ty = (el: Element) => parseFloat(((el as HTMLElement).style.transform.match(/translateY\(([\d.]+)px\)/) ?? [])[1] ?? "NaN");

// Regress #2: a reader who picked a version, then scrolled away from it (into an older day), was pulled back to it when a
// new version arrived: the active row's index and the rows' layout moved, and the list kept the active row in view.
for (const [label, hour, grouped] of [["grouped by day, scrolled into an older day", 1, true], ["one day", 14, false]] as const)
  test(name(`regress #2: a new version keeps the reader's place after they picked a row and scrolled away (${label})`), async () => {
    const ui = createMockUi({ versions: 120, now: new Date(2026, 10, 2, hour, 0).getTime() });
    const m = await render(wrap(ui, h(HistoryPanel, { initialHeight: 600 })));
    await flush();
    const list = $(m.container, ".carton-history-list")!;
    assert.equal($$(m.container, ".carton-day").length > 0, grouped, grouped ? "the History spans two days" : "one day: no day headers");
    const scrollTo = async (y: number) => {
      list.scrollTop = y;
      await act(async () => { list.dispatchEvent(new Event("scroll")); await new Promise((r) => setTimeout(r, 10)); });
    };
    // the person picks a version near the top
    await click($$(m.container, ".carton-version")[3]!);
    assert.equal($$(m.container, ".carton-version[data-active]").length, 1, "a picked row");
    // and scrolls far below it: in the grouped History, into yesterday
    await scrollTo(2400);
    if (grouped) {
      const days = $$(m.container, ".carton-day").map((d) => d.textContent ?? "");
      assert.ok(days.some((d) => d.startsWith("Yesterday")), "yesterday's header is on screen: " + days.join(" | "));
    }
    const before = list.scrollTop;
    const topRow = () => $$(m.container, ".carton-vrow").map((r) => [r, ty(r)] as const).filter(([, y]) => y <= list.scrollTop).sort((a, b) => b[1] - a[1])[0]![0].querySelector("[role=option]")!.id;
    const was = topRow();
    await act(async () => { ui.addVersion(); });
    await flush();
    assert.equal(list.scrollTop, before + 52, "shifted by the row that arrived above, never back to the picked row");
    assert.equal(topRow(), was, "the same row is still at the top");
    // the picked row is still the picked one, wherever it is now
    assert.equal($$(m.container, ".carton-version[data-active]").length, 0, "the picked row is off screen (it stays picked)");
    await m.unmount();
  });
