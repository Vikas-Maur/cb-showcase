// e2e-qa's B7 on real processes: a helper started by a plain `cb` (no setup of its own, the app closed) runs what the
// project's recipe says (`lease ["helper"]`): the factory and config with the sync server, so a write on a shared cut
// works instead of "cut is shared; open Carton with sync". The recipe: the app's engine thread is authoritative; a
// helper that was given a sync config fills a gap only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createMemoryStore } from "@carton/store-memory";
import { openLocal } from "../src/open.ts";
import { Lease, readHelperRecipe, recordHelperRecipe } from "../src/lease.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
async function until<T>(f: () => Promise<T | null | false | undefined>, ms = 30_000, what = "condition"): Promise<T> {
  for (const end = Date.now() + ms; ; await sleep(50)) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
}

test("the helper recipe: the app's is authoritative; a helper's fills a gap only", async () => {
  const store = createMemoryStore();
  assert.equal(await readHelperRecipe(store), null);
  assert.ok(await recordHelperRecipe(store, { factory: "/helper.ts", config: { sync: { url: "ws://a" } } }, "helper"));
  assert.ok(!(await recordHelperRecipe(store, { factory: "/other.ts", config: {} }, "helper")), "a second helper doesn't override");
  assert.ok(await recordHelperRecipe(store, { factory: "/app.ts", config: { sync: { url: "ws://b" } } }, "worker"));
  assert.ok(!(await recordHelperRecipe(store, { factory: "/helper.ts", config: {} }, "helper")), "nor overrides the app's");
  assert.deepEqual([(await readHelperRecipe(store))?.factory, (await readHelperRecipe(store))?.by], ["/app.ts", "worker"]);
});

test("B7: a plain cb write on a shared cut, the app closed, starts a helper that reaches the sync server", async () => {
  const { dir, projectId } = bundle("b7");
  const host = spawn(process.execPath, [here("./support/host.ts"), dir, projectId], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CARDBOARD_ACTOR: "", CLAUDECODE: "" } });
  let helperPid: number | null = null;
  try {
    await new Promise<void>((r) => createInterface({ input: host.stdout! }).once("line", () => r()));
    const { url } = JSON.parse(readFileSync(join(dir, "host.json"), "utf8"));
    const syncCfg = { url, tokenFile: join(dir, "token-alice") };
    const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: { kind: "human", id: "human:alice" } });
    await init.close();
    // someone with the setup shares the cut (its helper knows the server, and leaves that for others)
    const setup = await openLocal({ projectDir: dir, projectId, adapter, actor: { kind: "human", id: "human:alice" }, helperFactory: here("./support/real-sync-factory.ts"), helperConfig: syncCfg });
    assert.equal((await setup.write({ kind: "share" })).status, "confirmed");
    const cut = setup.carton.cut;
    await until(async () => (await setup.carton.cuts()).find((c) => c.id === cut)!.sequencer.kind === "server", 30_000, "the cut to be shared");
    // that helper goes away (crash, or idle exit): nothing holds the lease
    helperPid = (await setup.lease.read())!.pid;
    process.kill(helperPid, "SIGKILL");
    await setup.close();
    // a plain cb call, no helper setup: it starts the recorded recipe, not local's default factory without sync
    const plain = await openLocal({ projectDir: dir, projectId, adapter, actor: { kind: "agent", id: "codex/b7", name: "Codex" } });
    try {
      const r = await plain.write({ kind: "commit", ops: [set("c1", "name", "from a plain cb")] });
      assert.ok(r.status === "confirmed" || r.status === "pending", JSON.stringify(r));
      helperPid = (await plain.lease.read())?.pid ?? null;
    } finally {
      await plain.close();
    }
  } finally {
    if (helperPid && helperPid !== process.pid) try { process.kill(helperPid, "SIGKILL"); } catch {}
    host.kill("SIGKILL");
  }
});
