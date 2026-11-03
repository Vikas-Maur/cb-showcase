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

test(name("threads in timeline order with where they sit: timecode, Moved with its clip, a changed moment, whole video, replies"), async () => {
  const ui = createMockComments();
  const m = await render(h(CommentsPanel, { comments: ui }));
  const threads = $$(m.container, "[role=listitem]");
  assert.equal(threads.length, 4, "the resolved thread is under Resolved");
  // PLAN 9.1: times as the editor shows them (0:06), "Whole video"
  assert.deepEqual(texts(threads.map((t) => $(t, ".carton-comment-at")!)), ["0:12", "0:31–0:35", "0:47", "Whole video"]);
  // a note that followed its clip says so in the grey line a changed moment uses, never a pill (design QA G26)
  assert.equal($(threads[1]!, ".carton-badge"), null);
  assert.equal($(threads[1]!, ".carton-comment-changed")?.textContent, "Moved with its clip.");
  // laptop report: no tooltip over the next thread; the hint is the line's title, as a changed moment's is
  assert.equal($(threads[1]!, ".carton-comment-changed")?.getAttribute("title"), "The clip moved; the comment followed it.");
  assert.equal($(threads[1]!, ".carton-comment-changed")?.getAttribute("data-carton-tip"), null);
  // a moment that changed since says so in a line of its own, not a badge (PLAN 9.1)
  assert.equal($(threads[2]!, ".carton-badge"), null);
  assert.equal($(threads[2]!, ".carton-comment-changed")?.textContent, "That moment changed since.", "no host to view it: no link");
  assert.equal($(threads[2]!, ".carton-comment-changed")?.getAttribute("title"), "What's there changed since this comment was made.");
  assert.equal($$(threads[0]!, ".carton-thread-replies .carton-comment").length, 1);
  // screen readers hear a sentence, the teammate by first name as on screen (design QA G22, G27)
  assert.equal(threads[0]!.getAttribute("aria-label"), "Bob's comment at 0:12");
  assert.equal($(threads[0]!, ".carton-comment-name")?.textContent, "Bob");
  const whole = threads[3]!, who = $(whole, ".carton-comment-name")?.textContent;
  assert.equal(whole.getAttribute("aria-label"), who === "You" ? "Your comment on the whole video" : `${who}'s comment on the whole video`);
  // You is "Y" here, as in History (design QA G11)
  const mine = threads.find((t) => $(t, ".carton-comment-name")?.textContent === "You");
  assert.ok(mine, "one of the threads is yours");
  assert.equal($(mine!, ".carton-avatar")?.textContent, "Y");
  assert.equal(mine!.getAttribute("aria-label")?.startsWith("Your comment "), true);
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
  assert.equal(byText(m.container, ".carton-badge", "Not sent yet")?.dataset.tone, "muted");
  assert.equal((box as HTMLTextAreaElement).value, "");
});

// UX redesign PLAN 9.1 (DESIGN §6.8, after/comments-384.png): no second "Comments" heading; the box says where the note
// goes before writing begins, and follows the playhead until then; Open/Resolved/All once something is resolved; a
// moment that changed since offers the version the note was made on.
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
test(name("PLAN 9.1: the box says where the note goes; no second heading; tabs once a note is resolved"), async () => {
  const ui = createMockComments({ seed: false });
  let playhead: number | null = 13.2;
  const m = await render(h(CommentsPanel, { comments: ui, at: () => playhead }));
  assert.equal($(m.container, "h2, .carton-comments-title"), null, "the panel's tab says Comments; nothing under it does");
  assert.equal($(m.container, "section")?.getAttribute("aria-label"), "Comments");
  assert.equal($(m.container, "[role=tab]"), null, "nothing resolved: no Open/Resolved/All");
  const box = $(m.container, ".carton-comments-compose textarea") as HTMLTextAreaElement;
  assert.equal(box.placeholder, "Add a note at 0:13…");
  assert.equal($(m.container, ".carton-comment-where")?.textContent, "At the playhead · 0:13");
  // before writing begins it follows the playhead (read twice a second)
  playhead = 21;
  await wait(600);
  assert.equal(box.placeholder, "Add a note at 0:21…");
  // no playhead: the whole video
  playhead = null;
  await wait(600);
  assert.equal(box.placeholder, "Add a note…");
  assert.equal($(m.container, ".carton-comment-where")?.textContent, "Whole video");
  // writing began: pinned there, whatever the playhead does
  playhead = 6.4;
  await wait(600);
  await act(() => box.dispatchEvent(new FocusEvent("focus")));
  await act(() => box.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  playhead = 30;
  await wait(600);
  assert.equal(box.placeholder, "Add a note at 0:06…");
  assert.equal($(m.container, ".carton-comment-where")?.textContent, "At the playhead · 0:06");
  await m.unmount();
  const n = await render(h(CommentsPanel, { comments: createMockComments() }));
  assert.deepEqual(texts($$(n.container, "[role=tab]")), ["Open 4", "Resolved 1", "All 5"], "one resolved: the tabs");
});

test(name("PLAN 9.1: That moment changed since. See it as it was: the version it was made on, through the host"), async () => {
  const ui = createMockComments();
  const seen: ThreadView[] = [];
  let fail = false;
  const onSeeAsItWas = async (t: ThreadView) => {
    seen.push(t);
    if (fail) throw new Error("Couldn't load this version. Try again.");
  };
  const m = await render(h(CommentsPanel, { comments: ui, onSeeAsItWas }));
  const changed = () => $$(m.container, "[role=listitem]")[2]!;
  const line = $(changed(), ".carton-comment-changed")!;
  assert.equal(line.textContent, "That moment changed since.See it as it was");
  await click(byText(line, "button", "See it as it was"));
  assert.deepEqual(seen.map((t) => t.made), [{ cut: "main", seq: 12 }], "the thread, with the version it was made on");
  // it can't be shown: said in the thread
  fail = true;
  await click(byText($(changed(), ".carton-comment-changed")!, "button", "See it as it was"));
  await flush();
  assert.equal($(changed(), ".carton-comment-changed [role=alert]")?.textContent, "Couldn't show that version. Try again.");
  // a clip removed: the same line, its own reason in the tooltip
  await act(() => ui.setPlacement(ui.threads()[0]!.id, { status: "removed", range: [12.4, 12.4] }));
  await flush();
  const removed = $$(m.container, "[role=listitem]").find((t) => /Bob's comment at 0:12/.test(t.getAttribute("aria-label") ?? ""))!;
  assert.equal($(removed, ".carton-comment-changed")?.getAttribute("title"), "The clip this comment was on was removed.");
  // the others have no "changed" line: the whole video, and a moved one, whose line says it moved with its clip (G26)
  assert.equal($$(m.container, ".carton-comment-changed:not([data-moved])").length, 2);
  assert.deepEqual(texts($$(m.container, ".carton-comment-changed[data-moved]")), ["Moved with its clip."]);
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
  assert.equal($(m.container, "[role=status]")?.textContent, "Comments not sent yet: 3");
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
  assert.equal($($$(m.container, "[role=listitem]")[1]!, ".carton-comment-changed")?.textContent, "That moment changed since.");
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
  assert.equal(markers[0]!.getAttribute("aria-label"), "2 comments at 0:12");
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
