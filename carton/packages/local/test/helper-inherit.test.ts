// A helper opens carton.db as the process that started it does (R2-03: under another adapter the same rows hash
// differently, so its pins can't be checked out by anyone else; core now refuses such an open). On real processes:
//   - a caller's own helperFactory is what its helper runs;
//   - with none, a caller starts what the app's engine thread recorded (its factory, its adapter);
//   - a caller on another adapter than Cardboard's, with no factory of its own and none recorded, starts no helper and
//     says why, rather than a helper with Cardboard's adapter;
//   - under Electron (the app's library worker, a utility process) the helper is started as Node, not a second app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openLocal } from "../src/open.ts";
import { EngineThread } from "../src/engine-thread.ts";
import { NO_HELPER } from "../src/client.ts";
import { helperEntry, helperEnv } from "../src/helper.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const marker = here("./support/marker-factory.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 15_000, what = "condition") {
  for (const end = Date.now() + ms; !f(); await sleep(50)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}
/** Pids that ran the marker factory (written by each of them). */
const ran = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : []);

async function project(name: string) {
  const { dir, projectId } = bundle(name);
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: { kind: "human", id: "human:me" } });
  const dbPath = init.dbPath;
  await init.close();
  return { dir, projectId, dbPath };
}
/** A write that always needs a helper (sharing starts the pusher); its own outcome doesn't matter here. */
async function needHelper(local: Awaited<ReturnType<typeof openLocal>>) {
  return local.write({ kind: "share" });
}
async function stopHelper(local: Awaited<ReturnType<typeof openLocal>>) {
  const row = await local.lease.read();
  if (row && row.pid !== process.pid) try { process.kill(row.pid, "SIGKILL"); } catch {}
}

test("a caller's own helperFactory is what its helper runs", async () => {
  const p = await project("inherit-own");
  const file = join(p.dir, "ran-own");
  const local = await openLocal({ projectDir: p.dir, projectId: p.projectId, adapter, helperFactory: marker, helperConfig: { marker: file } });
  try {
    await needHelper(local);
    await until(() => ran(file).length > 0, 15_000, "the helper to run the caller's factory");
    assert.ok(ran(file).every((pid) => pid !== process.pid), "run by the helper, not this process");
  } finally {
    await stopHelper(local);
    await local.close();
  }
});

test("with no factory of its own, a caller's helper runs the one the app's engine thread recorded", async () => {
  const p = await project("inherit-app");
  const file = join(p.dir, "ran-app");
  // the app: its engine thread records how helpers should run (B7), then the app closes
  const app = await EngineThread.start({ dbPath: p.dbPath, factory: marker, config: { marker: file } });
  await app.stop();
  const appRuns = ran(file).length;
  assert.equal(appRuns, 1, "the app's engine thread ran it once");
  const local = await openLocal({ projectDir: p.dir, projectId: p.projectId, adapter });
  try {
    await needHelper(local);
    await until(() => ran(file).length > appRuns, 15_000, "the helper to run the app's factory");
  } finally {
    await stopHelper(local);
    await local.close();
  }
});

test("a caller on another adapter, with no factory of its own and none recorded, starts no helper and says why", async () => {
  const p = await project("inherit-none");
  const local = await openLocal({ projectDir: p.dir, projectId: p.projectId, adapter });
  try {
    const r = await needHelper(local);
    assert.equal(r.status, "error", JSON.stringify(r));
    assert.equal((r as { code?: string }).code, NO_HELPER);
    assert.match(String((r as { error?: string }).error), /helperFactory/);
    await sleep(300);
    assert.equal(await local.lease.read(), null, "no helper took the lease");
  } finally {
    await local.close();
  }
});

test("under Electron a helper is started as Node (ELECTRON_RUN_AS_NODE=1), not as a second copy of the app", () => {
  // the app's library worker: execPath is Cardboard.exe and the variable isn't set there (cb's shims set it)
  const worker = { PATH: "/bin", CARDBOARD_HOME: "/home/me/Cardboard" };
  const env = helperEnv(worker, "43.7.0");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.CARDBOARD_HOME, "/home/me/Cardboard", "the rest of the environment is passed on");
  assert.equal(worker.hasOwnProperty("ELECTRON_RUN_AS_NODE"), false, "the caller's own environment is left alone");
  // already Node (cb's shim, or plain Node): unchanged
  assert.equal(helperEnv({ ELECTRON_RUN_AS_NODE: "1" }, "43.7.0").ELECTRON_RUN_AS_NODE, "1");
  assert.deepEqual(helperEnv(worker, undefined), worker, "plain Node: nothing added");
});

test("spawnHelper in an Electron utility process (the app's library worker): the spawn runs the app's binary as Node", () => {
  // as windows' built-bundle test does it (scripts/carton/test/patches.test.js): a process where Electron is detected
  // at run time and ELECTRON_RUN_AS_NODE isn't set, the spawn intercepted. With no env passed, and with one passed
  const probe = `
    const cp = require("node:child_process"), { syncBuiltinESMExports } = require("node:module");
    process.versions.electron = "39.0.0";
    delete process.env.ELECTRON_RUN_AS_NODE;
    const seen = [];
    cp.spawn = (cmd, args, o) => (seen.push({ cmd, args, asNode: o.env.ELECTRON_RUN_AS_NODE === "1", path: o.env.PATH === process.env.PATH, own: o.env.OWN ?? null }), { unref() {}, pid: 0 });
    syncBuiltinESMExports();
    import(${JSON.stringify(here("../src/helper.ts"))}).then((h) => {
      h.spawnHelper({ dbPath: "/x/carton.db", seen: null, factory: "/x/factory.js" });
      h.spawnHelper({ dbPath: "/x/carton.db", seen: null, factory: "/x/factory.js", env: { PATH: process.env.PATH, OWN: "1" } });
      console.log(JSON.stringify({ seen, envAfter: process.env.ELECTRON_RUN_AS_NODE ?? null }));
    });`;
  const r = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "" } });
  const out = JSON.parse(r.stdout.trim().split("\n").pop() || "{}");
  assert.equal(out.seen?.length, 2, r.stderr);
  for (const s of out.seen) {
    assert.equal(s.cmd, process.execPath, "the app's own binary");
    assert.equal(s.args[0], helperEntry(), "running helper-main");
    assert.equal(s.args[s.args.indexOf("--factory") + 1], "/x/factory.js");
    assert.equal(s.asNode, true, "as Node, not a second copy of the app");
    assert.equal(s.path, true, "with the rest of the environment");
  }
  assert.equal(out.seen[1].own, "1", "a caller's own env is kept (plus the variable)");
  assert.equal(out.envAfter, null, "the worker's own environment is left alone");
});

