// Displace, then install (§6.4) and the displaced-file hold rule (P10 settle-2), on real files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BUSY_BUDGET_MS, InstallGaveUp, displaceThenInstall, hardLinksWork, retryBusy, retryMissing, statStamp, type BusyOptions } from "../src/node/displace.ts";
import { DisplacedFiles } from "../src/node/displaced.ts";

const SCRATCH = process.env.CARTON_SCRATCH ?? path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "test");

function setup(t: test.TestContext, busy: BusyOptions = {}) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, "displace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "timeline.tsx");
  const tmpDir = path.join(dir, ".carton", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  let clock = 0;
  const held = new DisplacedFiles(path.join(dir, ".carton", "displaced"), { now: () => clock, holdMs: 150, quietMs: 150, ...busy });
  let k = 0;
  const tmp = (content: string) => {
    const p = path.join(tmpDir, `t${k++}`);
    fs.writeFileSync(p, content, { flag: "wx" });
    return p;
  };
  return { dir, target, held, tmp, advance: (ms: number) => (clock += ms) };
}

test("installs into an empty path without displacing anything", async (t) => {
  const { target, held, tmp } = setup(t);
  const r = await displaceThenInstall(target, tmp("v1"), held.next);
  assert.deepEqual(r.displaced, []);
  assert.equal(fs.readFileSync(target, "utf8"), "v1");
});

test("a foreign file at the path is moved aside, never overwritten", async (t) => {
  const { target, held, tmp } = setup(t);
  fs.writeFileSync(target, "foreign");
  const r = await displaceThenInstall(target, tmp("ours"), held.next);
  assert.equal(r.displaced.length, 1);
  assert.equal(fs.readFileSync(r.displaced[0]!, "utf8"), "foreign");
  assert.equal(fs.readFileSync(target, "utf8"), "ours");
});

test("a foreign write landing between displace and install is displaced too (EEXIST loop)", async (t) => {
  const { target, held, tmp } = setup(t);
  fs.writeFileSync(target, "first");
  let raced = false;
  const r = await displaceThenInstall(target, tmp("ours"), held.next, {
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

test("Carton's own displaced install is held, then deleted only if its bytes and stamp are unchanged", async (t) => {
  const { target, held, tmp, advance } = setup(t);
  await displaceThenInstall(target, tmp("v1"), held.next);
  const own = { bytes: fs.readFileSync(target), stamp: (await statStamp(target))! };
  held.endRound();
  const r = await displaceThenInstall(target, tmp("v2"), held.next);
  held.hold(r.displaced, own);
  let rev = await held.review(() => true);
  assert.deepEqual([rev.own, rev.foreign.length, held.size], [0, 0, 1], "held during its own round");
  held.endRound();
  rev = await held.review(() => true);
  assert.equal(held.size, 1, "and until the hold time has passed");
  advance(150);
  rev = await held.review(() => true);
  assert.deepEqual([rev.own, rev.foreign.length, held.size], [1, 0, 0]);
  assert.equal(fs.readdirSync(held.dir).length, 0);
});

test("an in-place writer that wrote into our displaced inode after we displaced it is imported, not deleted", async (t) => {
  const { target, held, tmp, advance } = setup(t);
  await displaceThenInstall(target, tmp("v1"), held.next);
  const own = { bytes: fs.readFileSync(target), stamp: (await statStamp(target))! };
  const fd = fs.openSync(target, "r+"); // the writer resolved the path before the displace
  const r = await displaceThenInstall(target, tmp("v2"), held.next);
  held.hold(r.displaced, own);
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, "edited in place", 0);
  fs.closeSync(fd);
  held.endRound();
  advance(200);
  const rev = await held.review((b) => b.toString() === "edited in place");
  assert.equal(rev.own, 0);
  assert.deepEqual(rev.foreign.map((f) => f.bytes.toString()), ["edited in place"]);
});

test("a foreign file that doesn't parse yet waits for quiet, is reported once and kept, and is imported if it completes", async (t) => {
  const { target, held, tmp, advance } = setup(t);
  fs.writeFileSync(target, "{half");
  const r = await displaceThenInstall(target, tmp("ours"), held.next);
  held.hold(r.displaced, null);
  const parses = (b: Buffer) => b.toString().endsWith("}");
  let rev = await held.review(parses);
  assert.deepEqual([rev.foreign.length, rev.partial.length], [0, 0], "not quiet yet");
  advance(150);
  rev = await held.review(parses);
  assert.deepEqual([rev.foreign.length, rev.partial.length], [0, 1], "quiet and incomplete: reported");
  rev = await held.review(parses);
  assert.equal(rev.partial.length, 0, "reported once");
  assert.equal(held.size, 1, "kept, never dropped");
  fs.appendFileSync(r.displaced[0]!, "}"); // the writer finishes into the displaced inode
  rev = await held.review(parses);
  assert.deepEqual(rev.foreign.map((f) => f.bytes.toString()), ["{half}"]);
  await held.release(rev.foreign[0]!.path);
  assert.equal(fs.readdirSync(held.dir).length, 0);
});

test("without hard links (FAT/exFAT) it falls back to stat-then-rename and still displaces a foreign file", async (t) => {
  const { target, held, tmp } = setup(t);
  let r = await displaceThenInstall(target, tmp("v1"), held.next, { noLinks: true });
  assert.deepEqual(r.displaced, []);
  const ours = await statStamp(target);
  r = await displaceThenInstall(target, tmp("v2"), held.next, { noLinks: true, lastStamp: ours });
  assert.deepEqual(r.displaced, [], "our own file is replaced");
  fs.writeFileSync(target, "foreign");
  r = await displaceThenInstall(target, tmp("v3"), held.next, { noLinks: true, lastStamp: ours });
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
// made to happen on Linux, so a call on `file` fails that way (once, or for `ms`), then runs for real; `windows: true`
// acts out Windows, where busy errors are retried.
const WIN: BusyOptions = { windows: true };
const winErr = (code: string) => Object.assign(new Error(`${code}: busy (simulated)`), { code });
type FsCall = "renameSync" | "linkSync" | "unlinkSync" | "statSync" | "readFileSync";
function failFor(t: test.TestContext, name: FsCall, code: string, file: string, ms = 0): void {
  const real = fs[name] as (...a: unknown[]) => unknown;
  let since: number | null = null;
  let failed = false;
  t.mock.method(fs, name, (...a: unknown[]) => {
    if (a.includes(file)) {
      since ??= performance.now();
      if (ms ? performance.now() - since < ms : !failed) {
        failed = true;
        throw winErr(code);
      }
    }
    return real(...a);
  });
}

test("Windows busy errors at every step of displace-then-install are retried, and the foreign file is still kept", async (t) => {
  const { target, held, tmp } = setup(t);
  fs.writeFileSync(target, "foreign");
  const ours = tmp("ours");
  failFor(t, "renameSync", "EPERM", target);
  failFor(t, "linkSync", "EACCES", target);
  failFor(t, "unlinkSync", "EBUSY", ours);
  const counter = { busy: 0 };
  const r = await displaceThenInstall(target, ours, held.next, { ...WIN, counter });
  t.mock.restoreAll();
  assert.equal(counter.busy, 3);
  assert.deepEqual(r.displaced.map((d) => fs.readFileSync(d, "utf8")), ["foreign"]);
  assert.equal(fs.readFileSync(target, "utf8"), "ours");
  assert.equal(fs.existsSync(ours), false);
});

test("Windows: a delete-pending target's stat is retried too (the no-links fallback, and the displaced-file review)", async (t) => {
  const { target, held, tmp } = setup(t, WIN);
  fs.writeFileSync(target, "foreign");
  const counter = { busy: 0 };
  failFor(t, "statSync", "EPERM", target);
  const r = await displaceThenInstall(target, tmp("ours"), held.next, { ...WIN, noLinks: true, lastStamp: null, counter });
  t.mock.restoreAll();
  assert.equal(counter.busy, 1);
  assert.deepEqual(r.displaced.map((d) => fs.readFileSync(d, "utf8")), ["foreign"]);
  held.hold(r.displaced, null);
  failFor(t, "statSync", "EACCES", r.displaced[0]!);
  const rev = await held.review(() => true);
  t.mock.restoreAll();
  assert.deepEqual(rev.foreign.map((f) => f.bytes.toString()), ["foreign"]);
});

test("Windows: the event loop keeps running while a busy rename is retried", async (t) => {
  const { target, held, tmp } = setup(t);
  fs.writeFileSync(target, "foreign");
  failFor(t, "renameSync", "EPERM", target, 80); // a scanner holds the file for 80 ms
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const counter = { busy: 0 };
  try {
    const r = await displaceThenInstall(target, tmp("ours"), held.next, { ...WIN, counter });
    assert.deepEqual(r.displaced.map((d) => fs.readFileSync(d, "utf8")), ["foreign"]);
  } finally {
    clearInterval(timer);
    t.mock.restoreAll();
  }
  assert.ok(counter.busy >= 2, `retried ${counter.busy} times`);
  assert.ok(ticks >= 3, `the event loop ran ${ticks} timer ticks during an 80 ms busy wait (a blocked thread runs none)`);
  assert.equal(fs.readFileSync(target, "utf8"), "ours");
});

test("retryBusy: the budget is time (5 s by default, configurable), never other errors, and Windows only", async () => {
  assert.equal(BUSY_BUDGET_MS, 5_000);
  const counter = { busy: 0 };
  const busy = () => {
    throw winErr("EPERM");
  };
  const t0 = performance.now();
  await assert.rejects(retryBusy(busy, { ...WIN, counter, budgetMs: 100 }), { code: "EPERM" });
  const took = performance.now() - t0;
  assert.ok(took >= 50 && took < 1_000, `gave up after ${took} ms with a 100 ms budget`);
  assert.ok(counter.busy >= 2, `retried (${counter.busy} times; fewer on a loaded box, where each wait overshoots)`);
  let calls = 0;
  const gone = () => {
    calls++;
    throw winErr("ENOENT");
  };
  await assert.rejects(retryBusy(gone, WIN), { code: "ENOENT" });
  assert.equal(calls, 1);
  calls = 0;
  const denied = () => {
    calls++;
    throw winErr("EACCES");
  };
  await assert.rejects(retryBusy(denied, { windows: false }), { code: "EACCES" }); // Linux, macOS: a real permission error
  assert.equal(calls, 1);
});

test("a file held while a review waits on a busy file stays held; reviews run one at a time", async (t) => {
  const { target, held, tmp, dir } = setup(t, WIN);
  fs.writeFileSync(target, "first");
  const r = await displaceThenInstall(target, tmp("ours"), held.next);
  held.hold(r.displaced, null);
  failFor(t, "readFileSync", "EBUSY", r.displaced[0]!, 60_000); // busy until the scanner lets go (below)
  const first = held.review(() => true);
  await delay(10);
  const late = path.join(dir, "late");
  fs.writeFileSync(late, "second");
  held.holdForeign(late); // held while the first review waits on the busy file
  const second = held.review(() => true);
  t.mock.restoreAll(); // the scanner lets go
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.foreign.map((f) => f.bytes.toString()), ["first"]);
  assert.deepEqual(b.foreign.map((f) => f.bytes.toString()), ["second"], "not dropped by the first review, and not reported twice");
  assert.equal(held.size, 0);
});

// The Windows decision (PLAN §6.4; displace.ts's header). NTFS leaves the path missing longer between displace and
// install, so an install with no missing window was proposed for Windows: check the stamp, then rename over the target
// (MoveFileEx(REPLACE_EXISTING) replaces atomically), backing off when a writer holding the file makes it busy. On a
// closed file that rename is the same on every OS, so the interleaving can be shown here.
async function stampCheckedReplace(target: string, tmp: string, lastStamp: string | null, between: () => void): Promise<string[]> {
  const imported: string[] = [];
  if ((await statStamp(target)) !== lastStamp) imported.push(fs.readFileSync(target, "utf8"));
  between(); // a foreign save lands here
  fs.renameSync(tmp, target);
  return imported;
}
const saves: Record<string, (target: string, text: string) => void> = {
  "a temp+rename": (target, text) => {
    fs.writeFileSync(`${target}.w`, text);
    fs.renameSync(`${target}.w`, target);
  },
  "an in-place (open, write, close)": (target, text) => fs.writeFileSync(target, text),
};

for (const [kind, save] of Object.entries(saves)) {
  test(`Windows decision: a stamp-checked replace destroys ${kind} save landing after the check; displace keeps it`, async (t) => {
    const a = setup(t);
    await displaceThenInstall(a.target, a.tmp("v1"), a.held.next);
    const imported = await stampCheckedReplace(a.target, a.tmp("v2"), await statStamp(a.target), () => save(a.target, "the agent's save"));
    assert.deepEqual(imported, [], "the check ran before the save");
    assert.equal(fs.readFileSync(a.target, "utf8"), "v2");
    const everywhere = fs.readdirSync(a.dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(a.dir, f)).isFile());
    assert.ok(!everywhere.some((f) => fs.readFileSync(path.join(a.dir, f), "utf8") === "the agent's save"), "the save is gone");

    const b = setup(t);
    await displaceThenInstall(b.target, b.tmp("v1"), b.held.next);
    let once = false;
    const r = await displaceThenInstall(b.target, b.tmp("v2"), b.held.next, {
      between: () => {
        if (once) return;
        once = true;
        save(b.target, "the agent's save");
      },
    });
    assert.ok(r.displaced.some((d) => fs.readFileSync(d, "utf8") === "the agent's save"), "kept for import");
    assert.equal(fs.readFileSync(b.target, "utf8"), "v2");
  });
}

test("retryMissing: a reader rides out the install's missing window, and a file that stays missing still fails", async (t) => {
  const { dir } = setup(t);
  const file = path.join(dir, "timeline.tsx");
  setTimeout(() => fs.writeFileSync(file, "installed"), 20);
  const counter: { missing?: number } = {};
  assert.equal(await retryMissing(() => fs.readFileSync(file, "utf8"), { counter }), "installed");
  assert.ok((counter.missing ?? 0) >= 1);
  const t0 = performance.now();
  await assert.rejects(retryMissing(() => fs.readFileSync(path.join(dir, "never"), "utf8"), { missingMs: 40 }), { code: "ENOENT" });
  const took = performance.now() - t0;
  assert.ok(took >= 20 && took < 1_000, `gave up after ${took} ms with a 40 ms budget`);
  let calls = 0;
  await assert.rejects(
    retryMissing(() => {
      calls++;
      return fs.readFileSync(dir); // EISDIR: not the window, not retried
    }),
    { code: "EISDIR" },
  );
  assert.equal(calls, 1);
});

test("a writer that keeps re-creating the target makes the install give up, with nothing lost and the path never empty", async (t) => {
  const { target, held, tmp } = setup(t);
  let n = 0;
  const ours = tmp("ours");
  const err = await displaceThenInstall(target, ours, held.next, { maxDisplaced: 5, between: () => fs.writeFileSync(target, `runaway ${n++}`) }).catch((e: unknown) => e);
  assert.ok(err instanceof InstallGaveUp);
  assert.equal(err.displaced.length, 5);
  assert.deepEqual(err.displaced.map((d) => fs.readFileSync(d, "utf8")), ["runaway 0", "runaway 1", "runaway 2", "runaway 3", "runaway 4"]);
  assert.equal(fs.readFileSync(target, "utf8"), "runaway 5", "the writer's last file stays at the path");
  assert.ok(fs.existsSync(ours), "our temp is left for the caller to remove");
});
