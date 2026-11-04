// A clip's or a track's mute in an editor's words (laptop, Carton UX v2 P2-4): the editor's change list read "Set the
// mute of “Intro” to on" for an unmute (Cardboard's "on" is the sound's). Now "Muted “Intro”" / "Unmuted “Intro”", in
// the editor's words (cardboardValue) and cb's alike; and a mute undone by an unmute (false where it wasn't set) is no
// change at all, so Compare counts nothing for it (P3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { changeList, countChanges, describe, diff, type Doc } from "@carton/core";
import { cardboardSchema, cardboardValue, fromHost } from "../src/index.ts";

const base = (): Doc =>
  fromHost({ name: "P", aspectRatio: "16:9", tracks: [{ id: "V1", name: "V1", order: 0, locked: false, visible: true, muted: false }], timelineItems: [{ id: "c1", trackId: "V1", type: "video", name: "Intro", startTime: 0, endTime: 5, trimStart: 0, trimEnd: 5 }] }, null);
const withClip = (d: Doc, f: Record<string, unknown>): Doc => ({ ...d, timelineItems: (d.timelineItems as Record<string, unknown>[]).map((x) => (x.id === "c1" ? { ...x, ...f } : x)) });
const withTrack = (d: Doc, f: Record<string, unknown>): Doc => ({ ...d, tracks: (d.tracks as Record<string, unknown>[]).map((x) => ({ ...x, ...f })) });
const rows = (a: Doc, b: Doc) => changeList(diff(a, b, cardboardSchema), a, cardboardSchema, { value: cardboardValue }).map((r) => r.text);
const plain = (a: Doc, b: Doc) => changeList(diff(a, b, cardboardSchema), a, cardboardSchema).map((r) => r.text);
const count = (a: Doc, b: Doc) => countChanges(diff(a, b, cardboardSchema), a, cardboardSchema);

test("mute in words: Muted / Unmuted, in the editor's words and cb's", () => {
  const a = base(), muted = withClip(a, { muted: true }), unmuted = withClip(a, { muted: false });
  assert.deepEqual(rows(a, muted), ["Muted “Intro”"]);
  assert.deepEqual(rows(muted, unmuted), ["Unmuted “Intro”"], "never “Set the mute of “Intro” to on”");
  assert.deepEqual(plain(muted, unmuted), ["Unmuted “Intro”"], "cb's (no value words) the same");
  assert.deepEqual(describe(diff(muted, unmuted, cardboardSchema), muted, cardboardSchema), ["Unmuted 'Intro'"]);
  // a track's mute too
  assert.deepEqual(rows(a, withTrack(a, { muted: true })), ["Muted track “V1”"]);
  assert.deepEqual(rows(withTrack(a, { muted: true }), a), ["Unmuted track “V1”"]);
  // with another change on the clip: both said
  assert.deepEqual(rows(a, withClip(a, { muted: true, volume: 0.5 })), ["Muted “Intro”, set its volume to 50%"]);
});

test("muted then unmuted is no change: nothing listed, nothing counted (laptop P3)", () => {
  const a = base(), unmuted = withClip(a, { muted: false });
  assert.deepEqual(rows(a, unmuted), []);
  assert.equal(count(a, unmuted), 0);
  assert.equal(count(unmuted, a), 0, "and back (not set where it was off)");
  // a real change beside it is still one
  assert.equal(count(a, withClip(a, { muted: false, volume: 0.5 })), 1);
  assert.deepEqual(rows(a, withClip(a, { muted: false, volume: 0.5 })), ["Set the volume of “Intro” to 50%"]);
});
