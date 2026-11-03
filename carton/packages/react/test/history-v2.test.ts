// Carton UX v2, History (N2): the pure parts. Bring back's clip list (clipChoices), landmarks by version, grouping that
// never crosses a landmark and folded days that keep them, the search's highlight, and the Compare seam's fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipChoices } from "../src/components/GoBack.ts";
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
