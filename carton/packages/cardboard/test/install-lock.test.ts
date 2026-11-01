// The bundle's install lock (`.carton/install.lock/`), shared with the app's facade, and readers that wait while it is
// held (`retryMissing` with `bundle`).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { INSTALL_LOCK, retryMissing } from "../src/node/displace.ts";
import { InstallLockBusy, installLockHeld, withInstallLock } from "../src/node/install-lock.ts";

const SCRATCH = process.env.CARTON_SCRATCH ?? path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "test");

function bundle(t: test.TestContext): string {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, "lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A lock left by another process, in the facade's format, silent for `silentMs`. */
function foreignLock(b: string, pid: number, silentMs: number): string {
  const dir = path.join(b, INSTALL_LOCK);
  fs.mkdirSync(dir, { recursive: true });
  const owner = path.join(dir, "owner");
  fs.writeFileSync(owner, JSON.stringify({ pid, me: `${pid}.facade` }));
  const t = new Date(Date.now() - silentMs);
  fs.utimesSync(owner, t, t);
  return dir;
}

test("install lock: one holder at a time; the owner file names the holder; released after", async (t) => {
  const b = bundle(t);
  const order: string[] = [];
  const hold = (name: string, ms: number) =>
    withInstallLock(b, async (mine) => {
      order.push(`${name} in`);
      const owner = JSON.parse(fs.readFileSync(path.join(b, INSTALL_LOCK, "owner"), "utf8")) as { pid: number; me: string };
      assert.equal(owner.pid, process.pid);
      assert.ok(mine());
      await delay(ms);
      order.push(`${name} out`);
    });
  await Promise.all([hold("a", 40), delay(5).then(() => hold("b", 1))]);
  assert.deepEqual(order, ["a in", "a out", "b in", "b out"]);
  assert.equal(installLockHeld(b), false);
});

test("install lock: the holder touches its owner file while it holds the lock", async (t) => {
  const b = bundle(t);
  await withInstallLock(
    b,
    async () => {
      const owner = path.join(b, INSTALL_LOCK, "owner");
      const old = new Date(Date.now() - 30_000);
      fs.utimesSync(owner, old, old);
      await delay(80);
      assert.ok(Date.now() - fs.statSync(owner).mtimeMs < 5_000, "the heartbeat moved the mtime");
    },
    { beatMs: 10 },
  );
});

test("install lock: taken over from a holder whose pid is gone after 10 s of silence, from any holder after 60 s", async (t) => {
  const b = bundle(t);
  foreignLock(b, 999_999, 11_000);
  assert.equal(await withInstallLock(b, async (mine) => mine(), { alive: () => false }), true, "dead and silent: taken over");
  foreignLock(b, 4242, 11_000);
  await assert.rejects(withInstallLock(b, async () => true, { alive: () => true, waitMs: 60 }), InstallLockBusy, "alive and silent 11 s: still its lock");
  assert.ok(installLockHeld(b), "and left in place");
  fs.rmSync(path.join(b, INSTALL_LOCK), { recursive: true });
  foreignLock(b, 4242, 61_000);
  assert.equal(await withInstallLock(b, async (mine) => mine(), { alive: () => true }), true, "silent 61 s: taken over even if the pid runs");
});

test("install lock: a lock the facade holds blocks the materializer until the facade releases it", async (t) => {
  const b = bundle(t);
  const dir = foreignLock(b, process.pid, 0);
  setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 40);
  const t0 = performance.now();
  await withInstallLock(b, async () => undefined);
  assert.ok(performance.now() - t0 >= 30, "waited for the facade");
});

test("install lock: on Windows a lock folder still being deleted (EPERM) is waited out", async (t) => {
  const b = bundle(t);
  fs.mkdirSync(path.join(b, ".carton"));
  const dir = path.join(b, INSTALL_LOCK);
  const real = fs.mkdirSync;
  let failed = 0;
  t.mock.method(fs, "mkdirSync", (p: fs.PathLike, o?: fs.MakeDirectoryOptions) => {
    if (p === dir && failed < 2) {
      failed++;
      throw Object.assign(new Error("EPERM: delete pending (simulated)"), { code: "EPERM" });
    }
    return real(p, o);
  });
  assert.equal(await withInstallLock(b, async (mine) => mine(), { windows: true }), true);
  assert.equal(failed, 2);
  await assert.rejects(
    (async () => {
      failed = 0;
      return withInstallLock(b, async () => true, { windows: false });
    })(),
    { code: "EPERM" },
    "on Linux and macOS EPERM is a real permission error",
  );
});

test("readers: a missing file is waited for while the install lock is held, and only briefly without it", async (t) => {
  const b = bundle(t);
  const file = path.join(b, "timeline.tsx");
  const dir = foreignLock(b, process.pid, 0);
  setTimeout(() => {
    fs.writeFileSync(file, "installed");
    fs.rmSync(dir, { recursive: true, force: true });
  }, 150);
  assert.equal(await retryMissing(() => fs.readFileSync(file, "utf8"), { bundle: b, missingMs: 20 }), "installed", "held: waited past missingMs");
  fs.rmSync(file);
  const t0 = performance.now();
  await assert.rejects(retryMissing(() => fs.readFileSync(file, "utf8"), { bundle: b, missingMs: 20 }), { code: "ENOENT" });
  assert.ok(performance.now() - t0 < 1_000, "not held: only missingMs");
});

test("install lock: a taker that stalled between its look and its rename puts back a lock taken afresh meanwhile", async (t) => {
  const b = bundle(t);
  const dir = foreignLock(b, 999_999, 11_000); // abandoned: dead pid, silent 11 s
  const owner = path.join(dir, "owner");
  const real = fs.renameSync;
  let stalled = false;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (!stalled && from === dir) {
      // while this taker stalls, another takes the abandoned lock over and holds it afresh
      stalled = true;
      const other = `${dir}.other`;
      real(dir, other);
      fs.rmSync(other, { recursive: true, force: true });
      fs.mkdirSync(dir);
      fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, me: "successor" }));
    }
    return real(from, to);
  });
  await assert.rejects(withInstallLock(b, async () => true, { alive: () => false, waitMs: 60 }), InstallLockBusy, "the successor's lock is live: wait");
  assert.ok(stalled);
  assert.equal(JSON.parse(fs.readFileSync(owner, "utf8")).me, "successor", "the successor still holds its lock");
  assert.deepEqual(fs.readdirSync(path.join(b, ".carton")).filter((n) => n.includes("abandoned")), [], "nothing left aside");
});
