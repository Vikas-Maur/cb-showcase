// The watch file behind a watch link is there before the link is given out, and only written when missing (R3-3).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CutRecord, Doc } from "@carton/core";
import { parseWatchDescriptor, watchKey } from "../src/descriptor.ts";
import { ensureWatchFile } from "../src/watch-file.ts";

const rec: CutRecord = { id: "pub-1", name: "Main cut (published)", forkOf: "main-1@7", owner: "alice", kind: "published", source: "main-1", sequencer: { kind: "server", since: 0 } };
const project = { name: "Weekend", media: { "media-1": { id: "media-1", name: "S1", hash: "1".repeat(64), size: 1, duration: 6 }, "media-2": { id: "media-2", name: "S2", hash: "2".repeat(64), size: 1, duration: 6 } } } as never;
const doc = { name: "Weekend", timelineItems: [{ id: "clip-1", mediaItemId: "media-2" }, { id: "cap-1" }] } as unknown as Doc;

function world(o: { file?: boolean; failPuts?: number } = {}) {
  const blobs = new Map<string, Uint8Array>();
  if (o.file) blobs.set(watchKey(rec.id), new TextEncoder().encode("{}"));
  const marks = new Map<string, string>();
  let fails = o.failPuts ?? 0;
  const calls = { read: 0, put: 0, checkout: 0 };
  const io = {
    read: async (k: string) => (calls.read++, blobs.get(k) ?? null),
    put: async (k: string, b: Uint8Array) => {
      calls.put++;
      if (fails-- > 0) throw new Error("network down");
      blobs.set(k, b);
    },
    checkout: async () => (calls.checkout++, doc),
    keys: { get: (k: string) => marks.get(k) ?? null, set: (k: string, v: string) => void marks.set(k, v) },
  };
  return { blobs, calls, io };
}

test("a publication with no watch file (made before it existed) gets one: name, used media only, its source (R3-3)", async () => {
  const w = world();
  await ensureWatchFile(rec, project, w.io);
  const d = parseWatchDescriptor(new TextDecoder().decode(w.blobs.get(watchKey(rec.id))!));
  assert.deepEqual(Object.keys(d.media), ["media-2"]);
  assert.deepEqual(d.source, { branchId: "main-1", at: 7 });
  // known now: the next open asks nothing
  await ensureWatchFile(rec, project, w.io);
  assert.deepEqual(w.calls, { read: 1, put: 1, checkout: 1 });
});

test("an existing watch file is kept, not rewritten", async () => {
  const w = world({ file: true });
  await ensureWatchFile(rec, project, w.io);
  assert.equal(w.calls.put, 0);
  assert.equal(new TextDecoder().decode(w.blobs.get(watchKey(rec.id))!), "{}");
});

test("a write cut off is retried on the next open, and no link is given meanwhile (the caller waits for it)", async () => {
  const w = world({ failPuts: 1 });
  await assert.rejects(ensureWatchFile(rec, project, w.io), /network down/);
  await ensureWatchFile(rec, project, w.io);
  assert.ok(w.blobs.has(watchKey(rec.id)));
  assert.equal(w.calls.put, 2);
});
