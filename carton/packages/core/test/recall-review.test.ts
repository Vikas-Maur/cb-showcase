// Review of feat/ux2-n0 (GPT 6.1 Sol, one round): its five findings, each a test. A field filter never lets a clip's
// name pass for text (#3); Bring back's choices see a clip whose own part changed (#4); bringing back a part another
// clip shares now leaves that clip's alone, the brought-back clip getting a copy of its own (#1); a retried id answers
// as the first try did (#5); a version recorded as a landmark keeps its state through a compaction (#2).
import test from "node:test";
import assert from "node:assert/strict";
import { Carton, defineSchema } from "../src/index.ts";
import type { Doc, Op, Rec } from "../src/types.ts";
import { createMemoryStore } from "../../store-memory/src/index.ts";

const schema = defineSchema({
  collections: {
    tracks: { key: "id", seq: true },
    items: { key: "id", parent: { collection: "tracks", field: "trackId" }, noun: "clip", words: (r) => (typeof r.text === "string" ? [r.text] : []) },
    media: { key: "id", partOf: { collection: "items", field: "mediaId" }, nounOf: (r) => (r.own ? null : undefined), words: (r) => [String(r.content)] },
  },
  label: (_c, r) => String(r?.name ?? r?.content ?? "?"),
  timeline: { collection: "items", lanes: "tracks", lane: "trackId", start: "start", end: "end", source: "trimStart", sourceEnd: "trimEnd", speed: "speed" },
});
const adapter = { name: "test", schema, schemaVersion: 1, fromHost: (d: Doc) => d, toHost: (d: Doc) => d };
const doc = (): Doc => ({
  tracks: [{ id: "track", name: "Track", "#pos": "a" }],
  items: [
    { id: "clip-a", name: "Intro", trackId: "track", mediaId: "text-part", start: 0, end: 5, trimStart: 0, trimEnd: 5, speed: 1, text: "Original" },
    { id: "clip-b", name: "Other", trackId: "track", start: 5, end: 10, trimStart: 0, trimEnd: 5, speed: 1 },
  ],
  media: [{ id: "text-part", own: true, content: "Original" }],
}) as unknown as Doc;
const set = (c: string, id: string, f: string, value: unknown): Op => ({ op: "set", path: [c, id, f], value });
const open = (o: { clock?: () => number; keyframeEvery?: number } = {}) => Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc() }, actor: { kind: "human", id: "alice" }, ...o });

test("review #3: a text-only find never matches a clip's name", async () => {
  const c = await open();
  try {
    await c.commit({ ops: [set("items", "clip-a", "end", 4)] });
    assert.equal((await c.find("Intro", { fields: ["text"] })).total, 0);
    assert.equal((await c.find("Intro", { fields: ["clip"] })).total, 1);
  } finally {
    await c.close();
  }
});

test("review #4: Bring back's choices list a clip whose own part (a title's text entry) changed", async () => {
  const c = await open();
  try {
    await c.commit({ ops: [set("media", "text-part", "content", "Changed")] });
    const ch = await c.bringBackChoices(`${c.cut}@0`);
    assert.deepEqual(ch.changed.map((x) => x.record), ["items/clip-a"]);
    assert.equal(ch.same, 1);
  } finally {
    await c.close();
  }
});

test("review #1: bringing back a part another clip shares now leaves that clip's as it is (a copy for this one)", async () => {
  const c = await open();
  try {
    await c.commit({ ops: [set("items", "clip-b", "mediaId", "text-part"), set("media", "text-part", "content", "Other title now")] });
    const r = await c.restoreClip(`${c.cut}@0`, "items/clip-a");
    const head = (await c.head()).doc;
    const media = new Map((head.media as Rec[]).map((m) => [m.id, m]));
    assert.equal(media.get("text-part")!.content, "Other title now", "the other clip's part is untouched");
    const a = (head.items as Rec[]).find((x) => x.id === "clip-a")!;
    assert.notEqual(a.mediaId, "text-part");
    assert.equal(media.get(a.mediaId as string)!.content, "Original", "the brought-back clip has its own copy, as it was");
    assert.ok(r.brought.parts.includes(`media/${a.mediaId}`));
  } finally {
    await c.close();
  }
});

test("review #5: a retried id answers as the first try (a deleted clip: added, with its parts)", async () => {
  const c = await open();
  try {
    await c.commit({ ops: [{ op: "remove", path: ["items", "clip-a"] }, { op: "remove", path: ["media", "text-part"] }] });
    const a = await c.restoreClip(`${c.cut}@0`, "items/clip-a", { id: "review.10" });
    const b = await c.restoreClip(`${c.cut}@0`, "items/clip-a", { id: "review.10" });
    assert.equal(a.brought.how, "added");
    assert.deepEqual(b.brought, a.brought);
    // nothing to bring back: a retry says the same
    const s1 = await c.restoreClip(`${c.cut}@0`, "items/clip-b", { id: "review.11" });
    const s2 = await c.restoreClip(`${c.cut}@0`, "items/clip-b", { id: "review.11" });
    assert.equal(s1.brought.how, "same");
    assert.equal(s2.brought.how, "same");
  } finally {
    await c.close();
  }
});

test("review #2: a version recorded as a landmark keeps its state through a compaction", async () => {
  let now = 0;
  const c = await open({ keyframeEvery: 2, clock: () => ++now });
  try {
    await c.commit({ ops: [set("items", "clip-a", "end", 4)] });
    const l = (await c.mark("exported"))!;
    for (let i = 0; i < 6; i++) await c.commit({ ops: [set("items", "clip-a", "end", 5 + i)] });
    await c.compact({ olderThanDays: 0 });
    const d = await c.checkout(l.ref);
    assert.equal((d.items as Rec[]).find((x) => x.id === "clip-a")!.end, 4);
  } finally {
    await c.close();
  }
});
