// Carton UX v2 on the real Windows laptop (fix/ux2-laptop), P3-11: a landmark's picture was tried once a page. One due
// while the stage showed black (a project just opened, a dropped canvas), or while comparing, never got one. Now a try
// that finds no picture is made again while History is open (after a while, and as soon as Compare ends), and nothing
// runs once History is closed. `pnpm test` runs it on React 19 and on preact/compat.
import { act, cleanup, closeDom, render, runtime } from "./dom.ts";
import { React } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CartonProvider } from "../src/index.ts";
import { createMockUi } from "../src/mock.ts";
import * as LR from "../src/components/LandmarkRow.ts";
import type { CartonUi, Landmark } from "../src/model.ts";

const { indexLandmarks, useStagePictures, PICTURE_SETTLE_MS, __pictures } = LR;
// (read off the module, so the old code without it runs this test too, and fails it on what it does)
const PICTURE_RETRY_MS: readonly number[] = (LR as { PICTURE_RETRY_MS?: readonly number[] }).PICTURE_RETRY_MS ?? [2000, 5000];
const h = React.createElement;
afterEach(() => { cleanup(); __pictures.clear(); });
after(closeDom);
const name = (t: string) => `${t} [${runtime}]`;
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const JPEG = "data:image/jpeg;base64,/9j/AA==";

function setup() {
  const ui = createMockUi({ versions: 4 }) as unknown as CartonUi & Record<string, unknown>;
  const saved: string[] = [];
  ui.saveLandmarkPicture = async (key: string) => { saved.push(key); };
  // Compare: on, then off (the page's attachCompare)
  let comparing: unknown = null;
  const subs = new Set<() => void>();
  ui.comparing = () => comparing as never;
  ui.onCompare = (f: () => void) => { subs.add(f); return () => subs.delete(f); };
  const setComparing = (v: unknown) => act(() => { comparing = v; for (const f of [...subs]) f(); });
  const marks = indexLandmarks([{ kind: "exported", versionId: "v9", ref: "main@9", at: Date.now(), label: "1080p", picture: "main@9" } as unknown as Landmark]);
  let calls = 0;
  let answer: string | null = null;
  const capture = async () => { calls++; return answer; };
  function Panel() {
    useStagePictures({ marks, shownId: "v9", busy: false, capture });
    return null;
  }
  return { ui, saved, setComparing, Panel, capture, calls: () => calls, answer: (a: string | null) => { answer = a; } };
}

test(name("a landmark due while the stage is black gets its picture once the stage shows one, while History is open"), async () => {
  const s = setup();
  const m = await render(h(CartonProvider, { ui: s.ui }, h(s.Panel)));
  await wait(PICTURE_SETTLE_MS + 100);
  assert.equal(s.calls(), 1, "tried once it showed");
  assert.deepEqual(s.saved, [], "nothing to take: the stage is black");
  // the stage draws: the next try takes it
  s.answer(JPEG);
  await wait(PICTURE_RETRY_MS[0]! + 150);
  assert.equal(s.calls(), 2, "tried again");
  assert.deepEqual(s.saved, ["main@9"], "its picture made");
  await wait(PICTURE_RETRY_MS[1]! + 150);
  assert.equal(s.calls(), 2, "made: never asked again");
  await m.unmount();
});

test(name("comparing: no picture to take; Compare ends: tried again at once; History closed: nothing more"), async () => {
  const s = setup();
  const m = await render(h(CartonProvider, { ui: s.ui }, h(s.Panel)));
  await s.setComparing({ left: { ref: "main@1" }, right: { ref: "main@9" } });
  await wait(PICTURE_SETTLE_MS + 100);
  assert.equal(s.calls(), 1);
  s.answer(JPEG);
  await s.setComparing(null);
  await wait(PICTURE_SETTLE_MS + 150);
  assert.equal(s.calls(), 2, "Compare ended: tried again without waiting out the retry");
  assert.deepEqual(s.saved, ["main@9"]);
  await m.unmount();
  // History closed (the panel gone) with a picture still due: no tries
  __pictures.clear();
  const t = setup();
  const n = await render(h(CartonProvider, { ui: t.ui }, h(t.Panel)));
  await wait(PICTURE_SETTLE_MS + 100);
  assert.equal(t.calls(), 1);
  await n.unmount();
  await wait(PICTURE_RETRY_MS[0]! + 150);
  assert.equal(t.calls(), 1, "nothing while History is closed");
});
