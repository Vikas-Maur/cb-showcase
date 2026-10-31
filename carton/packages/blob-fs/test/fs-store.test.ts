// What the conformance suite can't see from outside: the files on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, utimesSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FsBlobStore, writeAll, retrying } from "../src/index.ts";
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

test("complete holds one part open at a time (an upload may have thousands of parts)", async (t) => {
  if (!existsSync("/proc/self/fd")) return t.skip("counts open handles through /proc (Linux)");
  const dir = fresh();
  const s = new FsBlobStore({ root: dir, durable: false });
  const up = await s.createMultipart("many");
  const parts = [];
  for (let i = 1; i <= 120; i++) parts.push(await up.uploadPart(i, new Uint8Array(64).fill(i)));
  const base = readdirSync("/proc/self/fd").length;
  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, readdirSync("/proc/self/fd").length - base)), 0);
  const info = await up.complete(parts);
  clearInterval(timer);
  assert.equal(info.size, 120 * 64);
  assert.ok(peak < 20, `${peak} more descriptors open during complete`);
  rmSync(dir, { recursive: true });
});

test("a 1024-byte key of capitals, under a deep store root, keeps the whole path under 1024 bytes and lists by prefix", async () => {
  const root = fresh();
  const dir = join(root, "deep", "a".repeat(100), "b".repeat(100), "c".repeat(100));
  const s = new FsBlobStore({ root: dir });
  const key = Array.from({ length: 5 }, () => "B".repeat(199)).join("/") + "/" + "C".repeat(24);
  assert.equal(Buffer.byteLength(key), 1024);
  await s.put(key, enc("max"));
  const files: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name)); };
  walk(join(dir, "objects"));
  for (const f of files) assert.ok(Buffer.byteLength(f) < 1024, `${Buffer.byteLength(f)}-byte path`);
  assert.equal(new TextDecoder().decode((await s.get(key))!), "max");
  assert.deepEqual((await s.list("BBB")).blobs.map((b) => b.key), [key]);
  assert.deepEqual((await s.list(key.slice(0, 400))).blobs.map((b) => b.key), [key], "a narrowed prefix finds a flat key");
  await s.delete(key);
  assert.equal(await s.head(key), null);
  rmSync(root, { recursive: true, force: true });
});

test("Windows retries: a file held busy is retried within the budget, then the error surfaces", async () => {
  let busyFor = 3, calls = 0;
  const flaky = async () => {
    calls++;
    if (busyFor-- > 0) throw Object.assign(new Error("busy"), { code: "EPERM" });
    return "ok";
  };
  assert.equal(await retrying(flaky, 2000, true), "ok");
  assert.equal(calls, 4);
  const start = Date.now();
  await assert.rejects(retrying(async () => { throw Object.assign(new Error("held"), { code: "EBUSY" }); }, 300, true), /held/);
  const took = Date.now() - start;
  assert.ok(took >= 150 && took < 1500, `gave up after ${took} ms with a 300 ms budget`);
  // not on Windows, or not a busy file: no retry
  let once = 0;
  await assert.rejects(retrying(async () => { once++; throw Object.assign(new Error("x"), { code: "EPERM" }); }, 2000, false));
  await assert.rejects(retrying(async () => { once++; throw Object.assign(new Error("x"), { code: "ENOENT" }); }, 2000, true));
  assert.equal(once, 2);
});
