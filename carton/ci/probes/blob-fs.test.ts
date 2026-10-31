// CI probe: @carton/blob-fs on the runner's own file system, for the two items hosts-plugins could only reason about
// on Linux (notes: "needs a Windows run").
// - Another process holding an object open. On Windows a handle opened without FILE_SHARE_DELETE (Defender, the
//   search indexer, a media player) makes rename and unlink of that file fail with EPERM/EBUSY; blob-fs retries them
//   for about 1.3 s. A shorter hold must not fail a write or a delete, and a longer one must fail cleanly with the old
//   object intact. The holder is PowerShell's File.Open with FileShare.Read, which is how such programs open files;
//   Node's own fs.open always shares delete, so it can't stand in. Elsewhere the holder is a plain Node process (POSIX
//   renames over an open file), which checks only that nothing waits for it.
// - A store deeper than Windows' classic MAX_PATH (260 characters): a Cardboard library under a long OneDrive path.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFsBlobStore } from "@carton/blob-fs";

const WIN = process.platform === "win32";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

function fresh(name: string): string {
  const d = path.join(process.env.CARTON_SCRATCH ?? os.tmpdir(), "ci-probe-blob-fs", `${name}-${process.pid}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Opens `file` in another process and keeps it open for `ms`; resolves once the handle is open.
function hold(file: string, ms: number): Promise<{ done: Promise<void> }> {
  const child = WIN
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$f = [System.IO.File]::Open($env:HOLD_FILE, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $f.Close()`], { env: { ...process.env, HOLD_FILE: file }, stdio: ["ignore", "pipe", "inherit"] })
    : spawn(process.execPath, ["-e", `const fd = require("fs").openSync(process.env.HOLD_FILE, "r"); console.log("held"); setTimeout(() => require("fs").closeSync(fd), ${ms});`], { env: { ...process.env, HOLD_FILE: file }, stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise<void>((resolve, reject) => child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`holder exited ${code}`)))));
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (d) => {
      out += d;
      if (out.includes("held")) resolve({ done });
    });
    child.on("error", reject);
    done.catch(reject);
  });
}

const objectFile = (root: string, key: string) => path.join(root, "objects", ...key.split("/").slice(0, -1), key.split("/").at(-1) + "~b");

test("a put replacing an object another process holds open lands once the holder lets go", async (t) => {
  const root = fresh("put");
  const s = createFsBlobStore({ root });
  const key = `media/${"ab".repeat(32)}`;
  await s.put(key, enc("v1"));
  const file = objectFile(root, key);
  assert.equal(fs.readFileSync(file, "utf8"), "v1");
  const h = await hold(file, 400);
  const t0 = performance.now();
  await s.put(key, enc("v2"));
  const waited = performance.now() - t0;
  await h.done;
  t.diagnostic(`put waited ${waited.toFixed(0)} ms for a 400 ms hold`);
  assert.equal(dec(await s.get(key)), "v2");
  // On Windows the rename must have been refused while the handle was open, or this probe tested nothing.
  if (WIN) assert.ok(waited > 150, `the put didn't wait for the holder (${waited.toFixed(0)} ms): the hold did not block the rename`);
});

test("a delete of an object another process holds open lands once the holder lets go", async (t) => {
  const root = fresh("delete");
  const s = createFsBlobStore({ root });
  const key = `media/${"cd".repeat(32)}`;
  await s.put(key, enc("bytes"));
  const h = await hold(objectFile(root, key), 400);
  const t0 = performance.now();
  await s.delete(key);
  const waited = performance.now() - t0;
  await h.done;
  t.diagnostic(`delete waited ${waited.toFixed(0)} ms for a 400 ms hold`);
  assert.equal(await s.get(key), null);
  if (WIN) assert.ok(waited > 150, `the delete didn't wait for the holder (${waited.toFixed(0)} ms)`);
});

test("a hold longer than the retry window fails the put with the OS error and leaves the old object readable", { skip: !WIN && "only Windows refuses to replace an open file" }, async (t) => {
  const root = fresh("long-hold");
  const s = createFsBlobStore({ root });
  const key = `media/${"ef".repeat(32)}`;
  await s.put(key, enc("old"));
  const h = await hold(objectFile(root, key), 4000);
  const err = await s.put(key, enc("new")).then(
    () => null,
    (e: NodeJS.ErrnoException) => e,
  );
  await h.done;
  t.diagnostic(`put under a 4 s hold: ${err ? err.code : "succeeded"}`);
  assert.ok(err, "the put succeeded while the file was held");
  assert.ok(["EPERM", "EBUSY", "EACCES"].includes(err.code ?? ""), `unexpected error ${err.code}: ${err.message}`);
  assert.equal(dec(await s.get(key)), "old");
  // and the store works again once the holder is gone
  await s.put(key, enc("new"));
  assert.equal(dec(await s.get(key)), "new");
});

test("a store deeper than 260 characters: put, get, list, stream, multipart and delete", async (t) => {
  let root = fresh("long-path");
  while (root.length < 280) root = path.join(root, "a-long-folder-name-like-onedrive-documents-cardboard");
  const s = createFsBlobStore({ root });
  const key = `media/${"01".repeat(32)}`;
  t.diagnostic(`object path: ${objectFile(root, key).length} characters`);
  assert.ok(objectFile(root, key).length > 300);
  await s.put(key, enc("deep bytes"), { contentType: "video/mp4" });
  assert.equal(dec(await s.get(key)), "deep bytes");
  assert.equal((await s.head(key))?.contentType, "video/mp4");
  assert.deepEqual((await s.list("media/")).blobs.map((b) => b.key), [key]);
  const stream = await s.getStream!(key, { offset: 5, length: 5 });
  let got = "";
  for await (const chunk of stream!) got += dec(chunk);
  assert.equal(got, "bytes");
  const up = await s.createMultipart("media/multi");
  const p1 = await up.uploadPart(1, enc("part one, "));
  const p2 = await up.uploadPart(2, enc("part two"));
  assert.equal((await up.listParts()).length, 2);
  await up.complete([p1, p2]);
  assert.equal(dec(await s.get("media/multi")), "part one, part two");
  await s.delete(key);
  await s.delete("media/multi");
  assert.deepEqual((await s.list("media/")).blobs, []);
});
