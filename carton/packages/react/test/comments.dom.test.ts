// The Comments panel and timeline markers in a DOM, on React 19 and on preact/compat (npm test runs this file twice).
import { $, $$, React, act, byText, cleanup, click, closeDom, flush, key, render, renders, runtime, type } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { CommentMarkers, CommentsPanel, createMockComments, markerGroups, type ThreadView } from "../src/index.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);
const name = (t: string) => `${t} [${runtime}]`;
const texts = (els: Element[]) => els.map((e) => e.textContent?.trim());

test(name("threads in timeline order with where they sit: timecode, Moved, May be outdated, whole version, replies"), async () => {
  const ui = createMockComments();
  const m = await render(h(CommentsPanel, { comments: ui }));
  const threads = $$(m.container, "[role=listitem]");
  assert.equal(threads.length, 4, "the resolved thread is under Resolved");
  assert.deepEqual(texts(threads.map((t) => $(t, ".carton-comment-at")!)), ["0:12.4", "0:31.0–0:34.5", "0:47.2", "Whole version"]);
  assert.equal(byText(threads[1]!, ".carton-badge", "Moved")?.dataset.tone, "info");
  assert.equal(byText(threads[2]!, ".carton-badge", "May be outdated")?.dataset.tone, "warning");
  assert.equal($(threads[2]!, ".carton-badge")?.getAttribute("data-carton-tip"), "What's there changed since this comment was made.");
  assert.equal($$(threads[0]!, ".carton-thread-replies .carton-comment").length, 1);
  assert.match(threads[0]!.getAttribute("aria-label")!, /Bob Okafor's comment at 0:12.4/);
  assert.deepEqual(texts($$(m.container, "[role=tab]")), ["Open 4", "Resolved 1", "All 5"]);
  await click(byText(m.container, "[role=tab]", "Resolved 1"));
  assert.match($(m.container, "[role=listitem] .carton-thread-resolved")!.textContent!, /Resolved by You/);
});

test(name("a new comment is pinned where the playhead was when writing began; Ctrl+Enter posts it"), async () => {
  const ui = createMockComments({ seed: false });
  let playhead = 12.5;
  const m = await render(h(CommentsPanel, { comments: ui, at: () => playhead }));
  const box = $(m.container, ".carton-comments-compose textarea")!;
  await act(() => box.dispatchEvent(new FocusEvent("focus")));
  await act(() => box.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  await flush();
  playhead = 40; // the playhead moves while typing
  await type(box, "Too loud here");
  await act(() => box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
  await flush();
  assert.deepEqual(ui.calls, [["add", "Too loud here", [12.5, 12.5]]]);
  assert.equal(byText(m.container, ".carton-badge", "Waiting to sync")?.dataset.tone, "muted");
  assert.equal((box as HTMLTextAreaElement).value, "");
});

test(name("typing in the panel never reaches the editor's shortcuts"), async () => {
  const ui = createMockComments({ seed: false });
  const seen: string[] = [];
  const listen = (e: Event) => seen.push((e as KeyboardEvent).key);
  document.addEventListener("keydown", listen);
  try {
    const m = await render(h(CommentsPanel, { comments: ui }));
    await key($(m.container, "textarea"), " ");
    await key($(m.container, "textarea"), "Delete");
    assert.deepEqual(seen, []);
  } finally {
    document.removeEventListener("keydown", listen);
  }
});

test(name("reply, resolve and reopen; edit and delete only one's own"), async () => {
  const ui = createMockComments();
  const m = await render(h(CommentsPanel, { comments: ui }));
  const first = () => $$(m.container, "[role=listitem]")[0]!;
  await click(byText(first(), ".carton-thread-actions button", "Reply"));
  await type($(first(), "textarea"), "Moved it");
  await click(byText(first(), "button", "Reply"));
  assert.deepEqual(ui.calls.at(-1), ["reply", ui.threads()[0]!.id, "Moved it"]);
  assert.equal($$(first(), ".carton-thread-replies .carton-comment").length, 2);
  // Bob's first comment: no edit or delete for Alice; her reply has them
  assert.equal($(first(), ":scope > .carton-comment .carton-comment-mine"), null);
  const mine = $$(first(), ".carton-thread-replies .carton-comment-mine");
  assert.equal(mine.length, 2);
  await click($(mine[0]!, "[aria-label=Edit]"));
  const editBox = $(first(), ".carton-thread-replies textarea") as HTMLTextAreaElement;
  assert.equal(editBox.value, "Agreed, moving it after “all of it”.");
  await type(editBox, "Agreed.");
  await click(byText(first(), "button", "Save"));
  assert.equal(ui.calls.at(-1)?.[0], "edit");
  assert.match(first().textContent!, /Agreed\. \(edited\)/);
  await click($($$(first(), ".carton-thread-replies .carton-comment-mine")[0]!, "[aria-label=Delete]"));
  assert.match(first().textContent!, /Comment deleted/);
  await click(byText(first(), ".carton-thread-actions button", "Resolve"));
  assert.equal($$(m.container, "[role=listitem]").length, 3, "a resolved thread leaves Open");
  await click(byText(m.container, "[role=tab]", "Resolved 2"));
  await click(byText($$(m.container, "[role=listitem]")[0]!, ".carton-thread-actions button", "Reopen"));
  assert.deepEqual(ui.calls.at(-1)?.slice(0, 1).concat(ui.calls.at(-1)?.[2] as never), ["resolve", false]);
});

test(name("a viewer reads only; refusals, waiting comments and an old server are said"), async () => {
  const ui = createMockComments({ canComment: false });
  const m = await render(h(CommentsPanel, { comments: ui }));
  assert.equal($(m.container, ".carton-comments-compose"), null);
  assert.equal($(m.container, ".carton-comments-readonly")?.textContent, "You can read comments here but not write them.");
  assert.equal($$(m.container, ".carton-thread-actions").length, 0);
  // a viewer's own comments (written before the role changed) are read only too
  assert.ok(ui.threads().some((t) => t.root.mine || t.replies.some((r) => r.mine)), "the mock has some of mine");
  assert.equal($$(m.container, ".carton-comment-mine").length, 0, "no edit or delete");
  await act(() => ui.setNotice("viewers can read comments but not write them"));
  await flush();
  assert.equal($(m.container, "[role=alert]")?.textContent, "viewers can read comments but not write them");
  await click($(m.container, "[role=alert] [aria-label=Dismiss]"));
  assert.equal($(m.container, "[role=alert]"), null);
  await act(() => ui.setStatus({ state: "offline", waiting: 3 }));
  await flush();
  assert.equal($(m.container, "[role=status]")?.textContent, "Comments waiting to sync: 3");
  await act(() => ui.setStatus({ state: "unsupported", waiting: 3 }));
  await flush();
  assert.match($(m.container, "[role=status]")!.textContent!, /doesn't carry comments yet/);
});

test(name("one thread changing re-renders that thread only"), async () => {
  const ui = createMockComments();
  const m = await render(h(CommentsPanel, { comments: ui }));
  renders.clear();
  const t = ui.threads()[1]!;
  await act(() => ui.setPlacement(t.id, { status: "outdated", range: [31, 34.5], why: "changed" }));
  await flush();
  assert.equal(renders.get("Thread"), 1);
  assert.equal(byText($$(m.container, "[role=listitem]")[1]!, ".carton-badge", "May be outdated")?.textContent, "May be outdated");
});

test(name("markers: placed where threads sit, a bar for a range, outdated marked, close ones grouped, clicks cycle"), async () => {
  const ui = createMockComments();
  const picked: string[] = [];
  const [a, b, c] = ui.threads() as ThreadView[];
  await act(() => ui.setPlacement(b!.id, { status: "moved", range: [13, 13] }));
  let selected: string | null = null;
  const view = () => h(CommentMarkers, { comments: ui, timeToX: (t: number) => t * 10, selected, onSelect: (id: string) => picked.push((selected = id)) });
  const m = await render(view());
  const markers = $$(m.container, ".carton-comment-marker");
  assert.equal(markers.length, 2, "12.4 s and 13 s are 6 px apart: one group; whole-version and resolved have none");
  assert.equal(markers[0]!.getAttribute("aria-label"), "2 comments at 0:12.4");
  assert.equal(markers[0]!.dataset.status, "moved");
  assert.equal($(markers[0]!, ".carton-comment-marker-count")?.textContent, "2");
  assert.equal(markers[1]!.dataset.status, "outdated");
  assert.match(markers[1]!.style.transform, /translateX\(472px\)/);
  await click(markers[0]);
  await m.rerender(view());
  await click($$(m.container, ".carton-comment-marker")[0]);
  assert.deepEqual(picked, [a!.id, b!.id]);
  assert.equal($$(m.container, ".carton-comment-marker")[0]!.dataset.selected, "");
  void c;
});

test("marker groups: ranges are bars, removed and whole-version threads have no marker", () => {
  const ui = createMockComments();
  const ts = ui.threads();
  const groups = markerGroups(ts, (t) => t * 2, 10, true);
  assert.deepEqual(groups.map((g) => [g.ids.length, g.x0, g.x1, g.status]), [[1, 24.8, 24.8, "exact"], [1, 36, 42, "exact"], [1, 62, 69, "moved"], [1, 94.4, 94.4, "outdated"]]);
  ui.setPlacement(ts[0]!.id, { status: "removed", range: [12.4, 12.4] });
  assert.equal(markerGroups(ui.threads(), (t) => t * 2, 10, false).length, 2);
});
