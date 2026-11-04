// Carton UX v2, History (N2): the pure parts. Bring back's clip list (clipChoices), landmarks by version, grouping that
// never crosses a landmark and folded days that keep them, the search's highlight, and the Compare seam's fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bringBackLine, clipChoices, type ClipChoice } from "../src/components/GoBack.ts";
import { remoteUi, serveUi } from "../src/remote.ts";
import { needsMore } from "../src/components/CutPicker.ts";
import { indexLandmarks, landmarkTitle } from "../src/components/LandmarkRow.ts";
import { openCompareVia } from "../src/components/CompareMenu.ts";
import { groupHistory } from "../src/history-groups.ts";
import { words } from "../src/words.ts";
import { createMockUi, people } from "../src/mock.ts";
import type { Change, Landmark, Version } from "../src/model.ts";

const c = (itemId: string | undefined, kind: Change["kind"], text: string, at?: number, end?: number, o: Partial<Change> = {}): Change => ({ key: itemId ? `timelineItems/${itemId}` : text, text, kind, clip: "video", ...(itemId ? { itemId } : {}), ...(at !== undefined ? { at, end: end ?? at } : {}), ...o });

test("clipChoices: one row per clip, in three groups by what happened, with how it was then and is now", () => {
  const fwd = [
    c("intro", "change", "Trimmed “Intro”, now ends at 0:05", 0, 5, { author: people.terminal, when: 20 }),
    c("intro", "change", "Moved “Intro” 1 s later", 1, 5, { author: people.alice, when: 30 }),
    c("broll", "remove", "Removed “B-roll pier”", 6, 9, { author: people.alice, when: 25 }),
    c("drone", "add", "Added “Drone shot”", 12, 16, { author: people.terminal, when: 10 }),
    c(undefined, "change", "Changed the frame rate to 30 fps"),
  ];
  const back = [c("intro", "change", "Trimmed “Intro”, now ends at 0:06", 0, 6), c("broll", "add", "Added “B-roll pier”", 6, 9)];
  const out = clipChoices(fwd, back);
  assert.deepEqual(out.map((x) => [x.itemId, x.how, x.name]), [["intro", "changed", "Intro"], ["broll", "deleted", "B-roll pier"], ["drone", "added", "Drone shot"]]);
  const intro = out[0]!;
  assert.deepEqual([intro.then, intro.now], [[0, 6], [0, 5]], "then from the way back, now from the way there");
  assert.equal(intro.author, people.alice, "who made the newest change to it");
  assert.deepEqual(out[1]!.then, [6, 9], "a deleted clip was there");
  assert.equal(out[2]!.now?.[0], 12);
  assert.ok(!out.some((x) => x.text.includes("frame rate")), "a change with no clip isn't one to bring back");
  assert.deepEqual(clipChoices([]), []);
});

const lm = (kind: Landmark["kind"], versionId: string, at: number, o: Partial<Landmark> = {}): Landmark => ({ id: `${kind}:${versionId}`, kind, versionId, ref: `main@${versionId}`, at, by: people.alice, personal: kind === "start" || kind === "before", local: kind !== "named" && kind !== "turn", picture: `main@${versionId}`, ...o });

test("indexLandmarks: by version, each row's best first (Named, Sent, Exported, Before, Start)", () => {
  const idx = indexLandmarks([lm("start", "5", 5), lm("exported", "5", 5), lm("named", "5", 5), lm("before", "3", 3)]);
  assert.deepEqual(idx.byVersion.get("5")!.map((l) => l.kind), ["named", "exported", "start"]);
  assert.deepEqual([...idx.ids].sort(), ["3", "5"]);
  assert.equal(landmarkTitle(lm("exported", "1", 1, { label: "1080p for the client" }), words, "x"), "1080p for the client");
  assert.equal(landmarkTitle(lm("sent", "1", 1, { label: "Leo" }), words, "x"), "Shared with Leo");
  assert.equal(landmarkTitle(lm("start", "1", 1), words, "x"), "How it was when you opened it");
  assert.equal(landmarkTitle(lm("before", "1", 1, { before: "restore" }), words, "x"), "Restoring an earlier version");
});

const v = (n: number, at: number, o: Partial<Version> = {}): Version => ({ id: `v${n}`, seq: n, ref: `main@${n}`, at, author: people.alice, kind: "edit", summary: `change ${n}`, changes: 1, ...o });

test("groupHistory: a person's run never crosses a landmark; a folded day keeps its landmarks; a search folds with nothing kept", () => {
  const t0 = new Date(2026, 10, 3, 9, 0).getTime();
  const vs = [v(1, t0), v(2, t0 + 60_000), v(3, t0 + 120_000), v(4, t0 + 180_000), v(5, t0 + 240_000)];
  // without landmarks: one run of five
  const plain = groupHistory(vs, () => false, { group: true });
  assert.deepEqual(plain.filter((r) => r.kind === "group").map((r) => (r as { ids: readonly string[] }).ids), [["v5", "v4", "v3", "v2", "v1"]]);
  // v3 exported: it is its own row, and the runs stop at it
  const marked = new Set(["v3"]);
  const rows = groupHistory(vs, () => false, { group: true, alone: (x) => marked.has(x.id), anchor: (x) => marked.has(x.id) });
  assert.deepEqual(rows.filter((r) => r.kind !== "day").map((r) => (r.kind === "group" ? r.ids.join(",") : (r as { id: string }).id)), ["v5,v4", "v3", "v2,v1"]);
  // folded, the landmark stays and the header counts it
  const shut = groupHistory(vs, () => true, { group: true, alone: (x) => marked.has(x.id), anchor: (x) => marked.has(x.id) });
  assert.deepEqual(shut.map((r) => r.kind === "day" ? `day:${r.count}/${r.hidden}` : (r as { id: string }).id), ["day:5/4", "v3"]);
  // a search's folded day keeps nothing, even a named version
  const named = vs.map((x, i) => (i === 1 ? { ...x, name: "Rough cut" } : x));
  const search = groupHistory(named, () => true, { anchor: () => false });
  assert.deepEqual(search.map((r) => r.kind), ["day"]);
});

test("openCompareVia: the editor's Compare when the host has it; else the fallback between refs of the cut, never a cut id", async () => {
  const ui = createMockUi({ versions: 4 });
  const asked: [string, string][] = [];
  const via = openCompareVia(ui, (a, b) => void asked.push([a, b]));
  const head = ui.cuts().find((x) => x.current)!.head;
  await via("main@2", null);
  await via("main@1", "main@3");
  await via("cut-ig", null);
  assert.deepEqual(asked, [["main@2", head], ["main@1", "main@3"]], "your edit is the head; another cut has no in-panel view");
  const opened: unknown[] = [];
  ui.openCompare = async (a, b) => void opened.push([a, b]);
  await openCompareVia(ui, () => assert.fail("the fallback"))("cut-ig", null);
  assert.deepEqual(opened, [["cut-ig", null]]);
});

test("N0b: Bring back's confirmation says where the clip goes and what else moves (DESIGN-V2 §3.2)", () => {
  const base: ClipChoice = { itemId: "broll", name: "B-roll pier", clip: "video", how: "deleted", then: [6, 9], text: "" };
  assert.equal(bringBackLine({ ...base, place: { placed: "same" }, ripple: { direction: "later", by: 3, at: 6, moved: 4 } }, "10:20 am", words), "It goes back where it was, at 0:06. Everything after it moves 3 s later. Ctrl+Z takes it back.");
  assert.equal(
    bringBackLine({ ...base, place: { placed: "new-track", trackId: "v1-2", takenBy: [{ itemId: "drone", name: "Drone shot" }] }, ripple: null }, "10:20 am", words),
    "Its place is taken by “Drone shot”, so it goes on a new track above, at 0:06. Nothing else moves. Ctrl+Z takes it back.",
  );
  assert.equal(bringBackLine({ ...base, how: "changed", now: [0, 5], then: [0, 6], place: { placed: "same" }, ripple: null }, "10:20 am", words), "It goes back to how it was at 10:20 am: its timing, text, look and settings. Nothing else moves. Ctrl+Z takes it back.");
  assert.equal(bringBackLine({ ...base, how: "added", then: undefined, now: [12, 16], ripple: { direction: "earlier", by: 4, at: 12, moved: 2 } } as ClipChoice, "10:20 am", words), "It wasn't in this version, so it comes out of your edit. Everything after it moves 4 s earlier. Ctrl+Z puts it back.");
  // an engine that doesn't preview (no ripple): nothing said of what moves
  assert.equal(bringBackLine(base, "10:20 am", words), "It goes back where it was, at 0:06. Ctrl+Z takes it back.");
  assert.equal(words.restMovesLater(1.5), "Everything after it moves 1.5 s later.");
});

test("N0b: a refusal crosses the worker bridge with its code and the new token (ChangedSince)", async () => {
  const ui = createMockUi({ versions: 4 });
  ui.restoreClip = async () => {
    throw Object.assign(new Error("“Intro” just changed again. Nothing was brought back."), { code: "CHANGED_SINCE", token: "t2" });
  };
  let client: ReturnType<typeof remoteUi> | null = null;
  const server = serveUi(ui, (m) => queueMicrotask(() => client!.receive(m)));
  client = remoteUi((m) => queueMicrotask(() => server.receive(m)));
  await client.ready;
  const e = (await client.ui.restoreClip!("main@1", "item-intro", { expect: "t1" }).catch((x: unknown) => x)) as Error & { code?: string; token?: string };
  assert.equal(e.message, "“Intro” just changed again. Nothing was brought back.");
  assert.deepEqual([e.code, e.token], ["CHANGED_SINCE", "t2"]);
  server.close();
});

test("N2c: another cut's next page is read when the last row on screen nears the end of what is loaded", () => {
  assert.equal(needsMore(0, 100, 11901), false, "the top of the first page");
  assert.equal(needsMore(59, 100, 11901), false);
  assert.equal(needsMore(61, 100, 11901), true, "40 rows from the end");
  assert.equal(needsMore(95, 100, undefined), false, "the cut's start is loaded");
  // (a tall view: the first row 0, 70 rows in view, review of feat/ux2-n2c #3)
  assert.equal(needsMore(0 + 70, 100, 11901), true);
});

test("design QA v2: a Before landmark's title from the row after it, a clip's own name kept whole", () => {
  assert.equal(words.safetyTitleOf("Restored the 11:02 am version"), "Restoring the 11:02 am version");
  assert.equal(words.safetyTitleOf("Brought back “B-roll 3” from 12:20 pm"), "Bringing back “B-roll 3”");
  // (" from " inside the name: cut after its closing quote only; review of fix/ux2-qa #1)
  assert.equal(words.safetyTitleOf("Brought back “View from the pier” from 10:20 am"), "Bringing back “View from the pier”");
  assert.equal(words.safetyTitleOf("Brought back a clip from an earlier version"), "Bringing back a clip");
  assert.equal(words.safetyTitleOf("Folded in “30s cut”"), "Folding in “30s cut”");
  assert.equal(words.safetyTitleOf("Trimmed “Intro”, now ends at 0:05"), null);
});
