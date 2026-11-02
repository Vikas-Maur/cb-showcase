// The web demo on its own: a new project's empty timeline, a clip added from a file, and a clip that plays for
// teammates from its pieces while the whole file is still uploading.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryBlobStore } from "@carton/blob-memory";
import { LEAF_SIZE } from "@carton/media";
import { emptyDoc } from "../src/create.ts";
import { ITEMS, MEDIA, mediaOf } from "../src/demo-doc.ts";
import { pieceKey, piecesInfoKey, playbackOrder, withPieces } from "../src/pieces.ts";
import { addClipOps } from "../src/upload.ts";
import { apply } from "@carton/core";
import { cardboardAdapter } from "@carton/cardboard";

const cardboardSchema = cardboardAdapter.schema;

test("a new project: a captions track over a video track, nothing on them", () => {
  const d = emptyDoc("Trip");
  assert.equal(d.name, "Trip");
  assert.deepEqual((d.tracks as { type: string }[]).map((t) => t.type), ["caption", "video"]);
  assert.deepEqual(d[ITEMS], []);
  assert.deepEqual(d[MEDIA], []);
});

test("a file added goes at the end of the video track, with its media record; the timeline knows its length", () => {
  let d = emptyDoc("Trip");
  const m = { id: "media-1", hash: "a".repeat(64), fileName: "beach.mp4", duration: 4.25, size: 1000, width: 640, height: 360 };
  d = apply(d, addClipOps(d, m, "clip-1"), cardboardSchema);
  d = apply(d, addClipOps(d, { ...m, id: "media-2", hash: "b".repeat(64), fileName: "dunes.webm" }, "clip-2"), cardboardSchema);
  const clips = d[ITEMS] as { id: string; startTime: number; endTime: number; name: string; mediaItemId: string }[];
  assert.deepEqual(clips.map((c) => [c.id, c.startTime, c.endTime, c.name]), [["clip-1", 0, 4.25, "beach"], ["clip-2", 4.3, 8.55, "dunes"]]);
  const media = mediaOf(d, {});
  assert.equal(media["media-2"]!.hash, "b".repeat(64));
  assert.equal(media["media-2"]!.duration, 4.25);
  assert.equal(media["media-2"]!.poster, `t1/${"b".repeat(64)}/poster.jpg`);
  assert.equal(mediaOf(d, {})["media-1"], media["media-1"], "the same object for an unchanged record");
});

test("pieces go up index first when an MP4's index is at its end", () => {
  const P = 2 * LEAF_SIZE;
  assert.deepEqual(playbackOrder(4, P, null), [0, 1, 2, 3]);
  assert.deepEqual(playbackOrder(4, P, [3 * P + 10, 4 * P - 1]), [3, 0, 1, 2]);
  assert.deepEqual(playbackOrder(4, P, [100, 200]), [0, 1, 2, 3], "an index at the start goes first anyway");
});

test("a clip still uploading reads from its pieces, waits for one not there yet, then from the whole file", async () => {
  const store = createMemoryBlobStore();
  const hash = "c".repeat(64);
  const P = 2 * LEAF_SIZE, size = 2 * P + 5;
  const bytes = new Uint8Array(size).map((_, i) => i % 251);
  await store.put(piecesInfoKey(hash), new TextEncoder().encode(JSON.stringify({ v: 1, size, pieceSize: P, pieces: 3 })));
  await store.put(pieceKey(hash, 0), bytes.slice(0, P));
  const s = withPieces(store, { pollMs: 10, waitMs: 2000 });
  assert.equal((await s.head(`m/${hash}`))?.size, size);
  assert.deepEqual(await s.get(`m/${hash}`, { offset: 10, length: 20 }), bytes.slice(10, 30));
  // across pieces 0 and 1: piece 1 arrives while the read waits
  const across = s.get(`m/${hash}`, { offset: P - 4, length: 8 });
  setTimeout(() => void store.put(pieceKey(hash, 1), bytes.slice(P, 2 * P)), 50);
  assert.deepEqual(await across, bytes.slice(P - 4, P + 4));
  // the whole file lands (and the pieces go): reads move to it
  await store.put(`m/${hash}`, bytes);
  await store.delete(pieceKey(hash, 0));
  assert.deepEqual(await s.get(`m/${hash}`, { offset: 2 * P, length: 5 }), bytes.slice(2 * P));
  assert.equal(await s.head(`m/${"d".repeat(64)}`), null, "unknown media stays unknown");
});
