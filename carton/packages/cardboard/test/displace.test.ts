// Displace, then install (§6.4) and the displaced-file hold rule (P10 settle-2), on real files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { displaceThenInstall, hardLinksWork, retryBusy, statStamp } from "../src/node/displace.ts";
import { DisplacedFiles } from "../src/node/displaced.ts";

const SCRATCH = process.env.CARTON_SCRATCH ?? path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "test");

function setup(t: test.TestContext) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, "displace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "timeline.tsx");
  const tmpDir = path.join(dir, ".carton", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  let clock = 0;
  const held = new DisplacedFiles(path.join(dir, ".carton", "displaced"), { now: () => clock, holdMs: 150, quietMs: 150 });
  let k = 0;
  const tmp = (content: string) => {
    const p = path.join(tmpDir, `t${k++}`);
    fs.writeFileSync(p, content, { flag: "wx" });
    return p;
  };
  return { dir, target, held, tmp, advance: (ms: number) => (clock += ms) };
}

test("installs into an empty path without displacing anything", (t) => {
  const { target, held, tmp } = setup(t);
  const r = displaceThenInstall(target, tmp("v1"), held.next);
  assert.deepEqual(r.displaced, []);
  assert.equal(fs.readFileSync(target, "utf8"), "v1");
});

test("a foreign file at the path is moved aside, never overwritten", (t) => {
  const { target, held, tmp } = setup(t);
  fs.writeFileSync(target, "foreign");
  const r = displaceThenInstall(target, tmp("ours"), held.next);
  assert.equal(r.displaced.length, 1);
  assert.equal(fs.readFileSync(r.displaced[0]!, "utf8"), "foreign");
  assert.equal(fs.readFileSync(target, "utf8"), "ours");
});

test("a foreign write landing between displace and install is displaced too (EEXIST loop)", (t) => {
  const { target, held, tmp } = setup(t);
  fs.writeFileSync(target, "first");
  let raced = false;
  const r = displaceThenInstall(target, tmp("ours"), held.next, {
    between: () => {
      if (raced) return;
      raced = true;
      fs.writeFileSync(target, "second"); // a temp+rename writer would land the same way
    },
  });
  assert.equal(r.eexist, 1);
  assert.deepEqual(r.displaced.map((d) => fs.readFileSync(d, "utf8")), ["first", "second"]);
  assert.equal(fs.readFileSync(target, "utf8"), "ours");
});

test("Carton's own displaced install is held, then deleted only if its bytes and stamp are unchanged", (t) => {
  const { target, held, tmp, advance } = setup(t);
  displaceThenInstall(target, tmp("v1"), held.next);
  const own = { bytes: fs.readFileSync(target), stamp: statStamp(target)! };
  held.endRound();
  const r = displaceThenInstall(target, tmp("v2"), held.next);
  held.hold(r.displaced, own);
  let rev = held.review(() => true);
  assert.deepEqual([rev.own, rev.foreign.length, held.size], [0, 0, 1], "held during its own round");
  held.endRound();
  rev = held.review(() => true);
  assert.equal(held.size, 1, "and until the hold time has passed");
  advance(150);
  rev = held.review(() => true);
  assert.deepEqual([rev.own, rev.foreign.length, held.size], [1, 0, 0]);
  assert.equal(fs.readdirSync(held.dir).length, 0);
});

test("an in-place writer that wrote into our displaced inode after we displaced it is imported, not deleted", (t) => {
  const { target, held, tmp, advance } = setup(t);
  displaceThenInstall(target, tmp("v1"), held.next);
  const own = { bytes: fs.readFileSync(target), stamp: statStamp(target)! };
  const fd = fs.openSync(target, "r+"); // the writer resolved the path before the displace
  const r = displaceThenInstall(target, tmp("v2"), held.next);
  held.hold(r.displaced, own);
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, "edited in place", 0);
  fs.closeSync(fd);
  held.endRound();
  advance(200);
  const rev = held.review((b) => b.toString() === "edited in place");
  assert.equal(rev.own, 0);
  assert.deepEqual(rev.foreign.map((f) => f.bytes.toString()), ["edited in place"]);
});

test("a foreign file that doesn't parse yet waits for quiet, is reported once and kept, and is imported if it completes", (t) => {
  const { target, held, tmp, advance } = setup(t);
  fs.writeFileSync(target, "{half");
  const r = displaceThenInstall(target, tmp("ours"), held.next);
  held.hold(r.displaced, null);
  const parses = (b: Buffer) => b.toString().endsWith("}");
  let rev = held.review(parses);
  assert.deepEqual([rev.foreign.length, rev.partial.length], [0, 0], "not quiet yet");
  advance(150);
  rev = held.review(parses);
  assert.deepEqual([rev.foreign.length, rev.partial.length], [0, 1], "quiet and incomplete: reported");
  rev = held.review(parses);
  assert.equal(rev.partial.length, 0, "reported once");
  assert.equal(held.size, 1, "kept, never dropped");
  fs.appendFileSync(r.displaced[0]!, "}"); // the writer finishes into the displaced inode
  rev = held.review(parses);
  assert.deepEqual(rev.foreign.map((f) => f.bytes.toString()), ["{half}"]);
  held.release(rev.foreign[0]!.path);
  assert.equal(fs.readdirSync(held.dir).length, 0);
});

test("without hard links (FAT/exFAT) it falls back to stat-then-rename and still displaces a foreign file", (t) => {
  const { target, held, tmp } = setup(t);
  let r = displaceThenInstall(target, tmp("v1"), held.next, { noLinks: true });
  assert.deepEqual(r.displaced, []);
  const ours = statStamp(target);
  r = displaceThenInstall(target, tmp("v2"), held.next, { noLinks: true, lastStamp: ours });
  assert.deepEqual(r.displaced, [], "our own file is replaced");
  fs.writeFileSync(target, "foreign");
  r = displaceThenInstall(target, tmp("v3"), held.next, { noLinks: true, lastStamp: ours });
  assert.deepEqual(r.displaced.map((d) => fs.readFileSync(d, "utf8")), ["foreign"]);
  assert.equal(fs.readFileSync(target, "utf8"), "v3");
});

test("hard links are detected on this volume", (t) => {
  const { dir } = setup(t);
  assert.equal(hardLinksWork(dir), true);
});

test("displaced slot names never repeat across instances", (t) => {
  const { dir } = setup(t);
  const a = new DisplacedFiles(path.join(dir, "d"));
  const b = new DisplacedFiles(path.join(dir, "d"));
  const names = new Set([a.next(), a.next(), b.next(), b.next()]);
  assert.equal(names.size, 4);
});

// Windows: a file another process has open, or a name deleted while something (Defender, the indexer) still had it
// open ("delete pending"), fails rename, link, unlink and stat with EPERM, EBUSY or EACCES for a moment. These can't be
// made to happen on Linux, so the calls fail that way once each, then run for real.
const winErr = (code: string) => Object.assign(new Error(`${code}: busy (simulated)`), { code });
function failOnce(t: test.TestContext, name: "renameSync" | "linkSync" | "unlinkSync" | "statSync", code: string) {
  const real = fs[name] as (...a: unknown[]) => unknown;
  let failed = false;
  t.mock.method(fs, name, (...a: unknown[]) => {
    if (!failed) {
      failed = true;
      throw winErr(code);
    }
    return real(...a);
  });
}

test("Windows busy errors at every step of displace-then-install are retried, and the foreign file is still kept", (t) => {
  const { target, held, tmp } = setup(t);
  fs.writeFileSync(target, "foreign");
  const ours = tmp("ours");
  failOnce(t, "renameSync", "EPERM");
  failOnce(t, "linkSync", "EACCES");
  failOnce(t, "unlinkSync", "EBUSY");
  const counter = { busy: 0 };
  const r = displaceThenInstall(target, ours, held.next, { counter });
  t.mock.restoreAll();
  assert.equal(counter.busy, 3);
  assert.deepEqual(r.displaced.map((d) => fs.readFileSync(d, "utf8")), ["foreign"]);
  assert.equal(fs.readFileSync(target, "utf8"), "ours");
  assert.equal(fs.existsSync(ours), false);
});

test("Windows: a delete-pending target's stat is retried too (the no-links fallback, and the displaced-file review)", (t) => {
  const { target, held, tmp } = setup(t);
  fs.writeFileSync(target, "foreign");
  const counter = { busy: 0 };
  failOnce(t, "statSync", "EPERM");
  const r = displaceThenInstall(target, tmp("ours"), held.next, { noLinks: true, lastStamp: null, counter });
  t.mock.restoreAll();
  assert.equal(counter.busy, 1);
  assert.deepEqual(r.displaced.map((d) => fs.readFileSync(d, "utf8")), ["foreign"]);
  held.hold(r.displaced, null);
  failOnce(t, "statSync", "EACCES");
  const rev = held.review(() => true);
  t.mock.restoreAll();
  assert.deepEqual(rev.foreign.map((f) => f.bytes.toString()), ["foreign"]);
});

test("retryBusy gives up after its attempts, and never retries other errors", () => {
  const counter = { busy: 0 };
  const busy = () => {
    throw winErr("EPERM");
  };
  assert.throws(() => retryBusy(busy, counter, 2), { code: "EPERM" });
  assert.equal(counter.busy, 2);
  let calls = 0;
  const gone = () => {
    calls++;
    throw winErr("ENOENT");
  };
  assert.throws(() => retryBusy(gone, counter), { code: "ENOENT" });
  assert.equal(calls, 1);
});
