// UI audit 2026-11-02 P1-2: sharing a project wrote a version titled `Set 'clip.mp4' content to "8291f1d9…"` (a content
// hash) on both sides, and `cb compare` read "Cleared content on 'clip.mp4', cleared shared media". Carton's own media
// fields (contentHash, shared) are told in an editor's words, never by their values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, describe, describeVersion, diff, fork, type Doc, type Op, type Rec } from "@carton/core";
import { cardboardSchema, fromHost, MEDIA } from "../src/index.ts";

const TRACK = "7ba56a6c-9992-42a1-88be-b30091622288", M = "5ec72031-8f1e-4c55-a4e2-3c1f0b1d9a77";
const HASH = "8291f1d9926b57ac70e5c1f0a3b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6";
const doc = (): Doc =>
  fromHost({
    id: "p1",
    name: "Audit project",
    tracks: [{ id: TRACK, name: "Mine", type: "video", order: 0 }],
    timelineItems: [{ id: "IyUFHiQ2m7Kd0aXbT9pLw", type: "video", trackId: TRACK, mediaItemId: M, startTime: 0, endTime: 2, trimStart: 0, trimEnd: 2 }],
    media: [{ id: M, data: { type: "video", fileName: "clip.mp4" } }],
  });
const set = (path: (string | number)[], value: unknown): Op => ({ op: "set", path: path.map(String), value });

test("P1-2: sharing footage reads 'Linked 'clip.mp4' for sharing', never its hash; unsharing and later facts too", () => {
  const d = doc();
  const share: Op[] = [set([MEDIA, M, "contentHash"], HASH), set([MEDIA, M, "shared"], { kind: "video", size: 81920, mime: "video/mp4", durationSec: 2, original: "local-only" })];
  const v = describeVersion(share, d, cardboardSchema);
  assert.deepEqual(v.lines, ["Linked 'clip.mp4' for sharing"]);
  assert.equal(v.summary, "Linked 'clip.mp4' for sharing");
  const after = apply(fork(d, cardboardSchema), share, cardboardSchema);
  const back = describe(diff(after, d, cardboardSchema), after, cardboardSchema);
  assert.deepEqual(back, ["Unlinked 'clip.mp4' from sharing"], "cb compare the other way");
  const proxy = describe([set([MEDIA, M, "shared", "proxy"], { profile: "720p", encoder: "nvenc", hash: HASH, size: 1 }), set([MEDIA, M, "shared", "t1", "poster"], { hash: HASH, size: 2 })], after, cardboardSchema);
  assert.deepEqual(proxy, ["Updated 'clip.mp4' for sharing"]);
  for (const l of [...v.lines, ...back, ...proxy]) assert.doesNotMatch(l, /[0-9a-f]{12,}|content|shared media/, l);
});

test("P1-2: no Cardboard media change prints an id: a clip's media swapped reads by name", () => {
  const d = doc();
  const two = { ...d, [MEDIA]: [...(d[MEDIA] as Rec[]), { id: "9c1f0b1d-8f1e-4c55-a4e2-3c1f0b1d9a77", data: { type: "video", fileName: "take2.mp4" } }] };
  const lines = describe([set(["timelineItems", "IyUFHiQ2m7Kd0aXbT9pLw", "mediaItemId"], "9c1f0b1d-8f1e-4c55-a4e2-3c1f0b1d9a77")], two, cardboardSchema);
  assert.deepEqual(lines, ["Changed 'clip.mp4' media"]);
});

test("P1-2 (review #3): adding or removing a clip's effect names the effect, never its id (the real schema)", () => {
  const d = doc();
  const UUID = "7ba56a6c-9992-42a1-88be-b30091622288";
  const withFx = (fx: Rec[]) => ({ ...d, timelineItems: (d.timelineItems as Rec[]).map((r) => ({ ...r, effects: fx })) });
  const a = withFx([]), b = withFx([{ id: UUID, type: "blur", amount: 4 }]);
  const added = describe(diff(a, b, cardboardSchema), a, cardboardSchema);
  const removed = describe(diff(b, a, cardboardSchema), b, cardboardSchema);
  assert.deepEqual([added, removed], [["Added effect \"blur\" on 'clip.mp4'"], ["Removed effect \"blur\" on 'clip.mp4'"]]);
});

test("regress 2026-11-02 P3-1: the first effect on a clip that had none (no effects field) is named as any other", () => {
  const d = doc();
  const UUID = "7ba56a6c-9992-42a1-88be-b30091622288";
  const plain = { ...d, timelineItems: (d.timelineItems as Rec[]).map(({ effects: _e, ...r }) => r) };
  const fx = { ...d, timelineItems: (d.timelineItems as Rec[]).map((r) => ({ ...r, effects: [{ id: UUID, type: "sharpen", amount: 2 }] })) };
  const two = { ...d, timelineItems: (d.timelineItems as Rec[]).map((r) => ({ ...r, effects: [{ id: UUID, type: "sharpen", amount: 2 }, { id: UUID.replace("7", "8"), type: "glow", amount: 1 }] })) };
  assert.deepEqual(describe(diff(plain, fx, cardboardSchema), plain, cardboardSchema), ["Added effect \"sharpen\" on 'clip.mp4'"]);
  assert.deepEqual(describe(diff(plain, two, cardboardSchema), plain, cardboardSchema), ["Added effect \"sharpen\" on 'clip.mp4', added effect \"glow\""]);
});
