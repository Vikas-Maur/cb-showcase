// What the conformance suite can't see from outside: the files on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, utimesSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FsBlobStore, writeAll } from "../src/index.ts";
import { scratchDir } from "./scratch.ts";

const fresh = () => mkdtempSync(join(scratchDir(), "fs-"));
const enc = (s: string) => new TextEncoder().encode(s);

test("objects are plain files a person can open, under readable names", async () => {
  const dir = fresh();
  const s = new FsBlobStore({ root: dir });
  const hash = "0f".repeat(32);
  await s.put(`media/${hash}`, enc("video bytes"));
  assert.equal(readFileSync(join(dir, "objects", "media", `${hash}~b`), "utf8"), "video bytes");
  assert.ok(!existsSync(join(dir, "objects", "media", `${hash}~m`)), "no sidecar without metadata");
  rmSync(dir, { recursive: true });
});

test("an upload id can't climb out of the uploads folder", async () => {
  const dir = fresh();
  const s = new FsBlobStore({ root: dir });
  for (const id of ["../objects", "..", "/etc", "C:\\Windows", "0".repeat(31), "g".repeat(32)]) {
    const up = await s.resumeMultipart("k", id);
    await assert.rejects(up.listParts(), /NoSuchUpload|no multipart upload/);
    await assert.rejects(up.abort(), /NoSuchUpload|no multipart upload/);
  }
  rmSync(dir, { recursive: true });
});

test("leftover temp files from a crash are swept when the store opens", async () => {
  const dir = fresh();
  await new FsBlobStore({ root: dir }).head("x"); // creates the layout
  const old = join(dir, "tmp", "deadbeef"), recent = join(dir, "tmp", "cafebabe");
  writeFileSync(old, "half a write");
  writeFileSync(recent, "in flight");
  const twoHoursAgo = (Date.now() - 2 * 3600_000) / 1000;
  utimesSync(old, twoHoursAgo, twoHoursAgo);
  await new FsBlobStore({ root: dir }).head("x");
  assert.deepEqual(readdirSync(join(dir, "tmp")), ["cafebabe"]);
  rmSync(dir, { recursive: true });
});

test("a key with a segment too long for a file name is stored hashed, and still listed and read back", async () => {
  const dir = fresh();
  const s = new FsBlobStore({ root: dir });
  const key = `long/${"Ω".repeat(200)}/clip`;
  await s.put(key, enc("deep"));
  assert.equal(new TextDecoder().decode((await s.get(key))!), "deep");
  const listed = await s.list("long/");
  assert.deepEqual(listed.blobs.map((b) => b.key), [key]);
  rmSync(dir, { recursive: true });
});

test("metadata from an older version is never paired with newer bytes", async () => {
  const dir = fresh();
  const s = new FsBlobStore({ root: dir });
  await s.put("k", enc("v1"), { contentType: "video/mp4", sha256: "11".repeat(32) });
  await s.put("k", enc("version 2"));
  const h = await s.head("k");
  assert.equal(h?.sha256, undefined);
  assert.equal(h?.contentType, undefined);
  // and a sidecar left by a crash between its write and the object's rename is ignored
  await s.put("j", enc("old"), { sha256: "22".repeat(32) });
  writeFileSync(join(dir, "objects", "j~m"), JSON.stringify({ fp: "stale", sha256: "33".repeat(32) }));
  assert.equal((await s.head("j"))?.sha256, undefined);
  rmSync(dir, { recursive: true });
});

test("a cancelled stream closes its file handle", async (t) => {
  if (!existsSync("/proc/self/fd")) return t.skip("counts open handles through /proc (Linux)");
  const dir = fresh();
  const s = new FsBlobStore({ root: dir });
  await s.put("big", new Uint8Array(4 << 20));
  const before = readdirSync("/proc/self/fd").length;
  for (let i = 0; i < 20; i++) {
    const r = (await s.getStream("big"))!.getReader();
    await r.read();
    await r.cancel();
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(readdirSync("/proc/self/fd").length <= before + 2, "file handles leak");
  rmSync(dir, { recursive: true });
});

test("a completed multipart upload leaves no upload folder or temp file behind", async () => {
  const dir = fresh();
  const s = new FsBlobStore({ root: dir });
  const up = await s.createMultipart("mp", { contentType: "video/mp4" });
  const a = await up.uploadPart(1, new Uint8Array(1000).fill(1));
  const b = await up.uploadPart(2, new Uint8Array(10).fill(2));
  await up.complete([a, b]);
  assert.deepEqual(readdirSync(join(dir, "uploads")), []);
  assert.deepEqual(readdirSync(join(dir, "tmp")), []);
  assert.equal((await s.head("mp"))?.contentType, "video/mp4");
  rmSync(dir, { recursive: true });
});

test("writeAll finishes short writes and refuses a write that makes no progress", async () => {
  const got: number[] = [];
  const short = { write: async (b: Uint8Array, off: number, len: number) => { const n = Math.min(3, len); got.push(...b.subarray(off, off + n)); return { bytesWritten: n, buffer: b }; } };
  await writeAll(short as never, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 8);
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7, 8]);
  const stuck = { write: async (b: Uint8Array) => ({ bytesWritten: 0, buffer: b }) };
  await assert.rejects(writeAll(stuck as never, new Uint8Array(4), 4), /no progress/);
});

test("complete copies the part it validated, even if the part is replaced meanwhile", async () => {
  const dir = fresh();
  const s = new FsBlobStore({ root: dir });
  const up = await s.createMultipart("race");
  const old = await up.uploadPart(1, new Uint8Array(1000).fill(1));
  const done = up.complete([old]);
  await up.uploadPart(1, new Uint8Array(1000).fill(2)).catch(() => {}); // races the copy
  const info = await done.catch((e) => e);
  if (!(info instanceof Error)) {
    const got = (await s.get("race"))!;
    assert.ok(got.every((x) => x === 1), "complete([old]) published the replacement's bytes");
  }
  rmSync(dir, { recursive: true });
});
