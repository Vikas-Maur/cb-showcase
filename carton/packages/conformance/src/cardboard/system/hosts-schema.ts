// H-SV (e2e-qa): every Cardboard client sends its adapter's schema version (CARDBOARD_SCHEMA_VERSION) in `hello`, and a
// host's sequencer refuses a client newer than the version it accepts. When `82d8c70` raised it to 2 both hosts still
// defaulted to 1, and live sync stalled without a word to the person. These check what the hosts do with their
// defaults, not how their source spells them (a text match broke on the fix itself: CI run 41227528651):
// - server-node, started with no `schemaVersion` in a process of its own (hsv-node-host.ts): a real Cardboard client
//   shares a cut through it, its commit is confirmed, and no sync error comes back. Every step has a time limit, and the
//   host's process is ended whatever happens, so a stuck close fails in seconds instead of hanging CI's step;
// - server-cloudflare: the version the room configures its sequencer with (`schemaVersionOf`), unset and with the vars
//   its wrangler.toml ships, accepts Cardboard's clients.
// They run where the workspace has the hosts (the integration branch, CI) and are skipped where a host is still a stub;
// a host that is there but whose entry point moved fails, so the check is updated rather than skipped.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Carton } from "@carton/core";
import type { Transport } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { CARDBOARD_SCHEMA_VERSION, cardboardAdapter, fromHost, toHost } from "@carton/cardboard";
import { SCRATCH, clip, find, type Item } from "./world.ts";

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const has = (rel: string) => fs.existsSync(path.join(PACKAGES, rel));
/** A module by a specifier the type checker doesn't follow: the hosts' real code is only in some workspaces. */
const load = async <T>(spec: string): Promise<Partial<T>> => (await import(spec)) as Partial<T>;
const HOST_SCRIPT = fileURLToPath(new URL("./hsv-node-host.ts", import.meta.url));
/** `p`, or a failure naming `what` after `ms`: a step that never returns fails the test in seconds, not at CI's step limit. */
function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`${what}: no answer in ${ms} ms`)), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

interface NodeHostModule {
  webSocketTransport(opts: Record<string, unknown>): Transport;
}
interface ServerModule {
  createHmacAuth(opts: { secret: string }): { issue(claims: Record<string, unknown>): string | Promise<string> };
}
interface RoomModule {
  schemaVersionOf(env: { SCHEMA_VERSION?: string }): number;
}

test("H-SV: server-node started with no schemaVersion takes a Cardboard client: it shares a cut and its commit is confirmed [real host]", { timeout: 60_000 }, async (t) => {
  if (!has("server-node/src/host.ts")) return t.skip("server-node's host isn't in this workspace (a stub)");
  const { webSocketTransport } = await load<NodeHostModule>("@carton/server-node");
  const { createHmacAuth } = await load<ServerModule>("@carton/server");
  assert.ok(webSocketTransport && createHmacAuth, "server-node's webSocketTransport or @carton/server's createHmacAuth moved: update hosts-schema.ts");
  assert.equal(cardboardAdapter.schemaVersion, CARDBOARD_SCHEMA_VERSION, "a Cardboard client sends CARDBOARD_SCHEMA_VERSION");
  const secret = "test-only-secret-test-only-secret-0123";
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(SCRATCH, "hsv-node-"));
  // The host runs in a process of its own (hsv-node-host.ts), which the teardown can always end; the test's process
  // keeps no host handle that could stop node --test from exiting.
  const host = spawn(process.execPath, [HOST_SCRIPT, dataDir], { env: { ...process.env, HSV_SECRET: secret }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = new Promise<void>((ok) => host.once("exit", () => ok()));
  host.stdin!.on("error", () => {}); // ending the pipe of a host that just exited (EPIPE) is not a failure: its exit is checked
  let stderr = "";
  host.stderr!.setEncoding("utf8").on("data", (d: string) => void (stderr = (stderr + d).slice(-4000)));
  const open: { carton?: Carton } = {};
  // One hook, in order (node runs `t.after` hooks in the order they're added, and stops at the first that fails): the
  // client, then the host (its rooms' SQLite files close with it), then the folder. Windows refuses to remove a folder
  // whose database is still open (EPERM: route 36, CI run 41229566460). Each step has a time limit: a close that never
  // returns fails the test in seconds; a host that doesn't exit is killed.
  t.after(async () => {
    const failed: string[] = [];
    await within(5_000, "Carton's close", open.carton?.close() ?? Promise.resolve()).catch((e: Error) => void failed.push(e.message));
    if (host.exitCode === null && host.signalCode === null) {
      host.stdin!.end();
      await within(10_000, "the node host's close", exited).catch((e: Error) => {
        failed.push(`${e.message} (killed); its stderr: ${stderr}`);
        host.kill();
        return within(5_000, "the node host's exit after a kill", exited).catch((e2: Error) => void failed.push(e2.message));
      });
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (e) {
      failed.push(`removing the host's data folder: ${(e as Error).message}`);
    }
    assert.deepEqual(failed, [], "teardown");
  }, { timeout: 30_000 });
  const started = await within(20_000, "the node host's start", new Promise<{ url?: string; error?: string }>((ok, no) => {
    let out = "";
    host.stdout!.setEncoding("utf8").on("data", (d: string) => {
      out += d;
      const nl = out.indexOf("\n");
      if (nl >= 0) ok(JSON.parse(out.slice(0, nl)) as { url?: string; error?: string });
    });
    host.once("error", no);
    void exited.then(() => no(new Error(`the node host exited (${host.exitCode ?? host.signalCode}) before it started: ${stderr}`)));
  }));
  assert.ok(started.url, `the node host didn't start: ${started.error ?? JSON.stringify(started)}`);
  const auth = createHmacAuth({ secret });
  const token = await auth.issue({ account: "alice", credential: "alice/dev", role: "owner", projectId: "p", ttlMs: 60_000 });
  const alice = { kind: "human" as const, id: "alice" };
  const carton = (open.carton = await Carton.open({
    adapter: cardboardAdapter,
    store: createMemoryStore(),
    actor: alice,
    init: { doc: fromHost({ tracks: [{ id: "V1", type: "video" }], timelineItems: [clip("X", 0, 10)] }, null) },
    sync: { transport: webSocketTransport({ keepaliveMs: 0 }), url: started.url, token, autoConnect: false },
  }));
  const errors: string[] = [];
  carton.on((e) => {
    const x = e as { type: string; error?: { code: string; message: string } | null };
    if (x.type === "sync-error" && x.error) errors.push(`${x.error.code}: ${x.error.message}`);
  });
  await within(10_000, "share", carton.share());
  assert.ok(await within(10_000, "connect", carton.sync!.connect({ nonce: "hsv" })), `connected (${errors.join("; ")})`);
  const shared = async () => (await carton.cuts()).find((c) => c.id === carton.cut)?.sequencer.kind === "server";
  for (const end = Date.now() + 10_000; !(await shared()); await new Promise((r) => setTimeout(r, 20))) {
    assert.ok(Date.now() < end && !errors.length, `the host never took the cut: ${errors.join("; ") || "no answer"} (H-SV: does its default accept schema version ${CARDBOARD_SCHEMA_VERSION}?)`);
  }
  const h = await carton.head();
  const host0 = toHost(h.doc);
  const items = structuredClone(host0.timelineItems as Item[]);
  find(items, "X").name = "through the host";
  const r = await within(10_000, "the commit", carton.commit({ doc: fromHost({ ...host0, timelineItems: items }, h.doc), author: alice }));
  const o = r.status === "pending" ? await carton.sync!.waitFor(r.id, 5000) : r;
  assert.equal(o.status, "confirmed", `${JSON.stringify(o)} ${errors.join("; ")}`);
  assert.deepEqual(errors, []);
});

test("H-SV: server-cloudflare's room accepts Cardboard's schema version unset and with the vars its wrangler.toml ships [real host]", async (t) => {
  if (!has("server-cloudflare/src/room.ts")) return t.skip("server-cloudflare's room isn't in this workspace (a stub)");
  const { schemaVersionOf } = await load<RoomModule>(pathToFileURL(path.join(PACKAGES, "server-cloudflare/src/room.ts")).href);
  assert.ok(schemaVersionOf, "server-cloudflare's schemaVersionOf (what the room gives its sequencer) moved: update hosts-schema.ts");
  assert.ok(schemaVersionOf({}) >= CARDBOARD_SCHEMA_VERSION, `with no SCHEMA_VERSION the room accepts up to ${schemaVersionOf({})}; Cardboard clients send ${CARDBOARD_SCHEMA_VERSION}`);
  // the deployment's own setting, if its config pins one (an uncommented SCHEMA_VERSION in [vars])
  const toml = path.join(PACKAGES, "server-cloudflare/wrangler.toml");
  const pinned = fs.existsSync(toml) ? /^[ \t]*SCHEMA_VERSION[ \t]*=[ \t]*"?([^"\r\n]*)"?/m.exec(fs.readFileSync(toml, "utf8"))?.[1] : undefined;
  if (pinned !== undefined) {
    const v = schemaVersionOf({ SCHEMA_VERSION: pinned });
    assert.ok(v >= CARDBOARD_SCHEMA_VERSION, `wrangler.toml pins SCHEMA_VERSION ${pinned}: the room accepts up to ${v}, Cardboard clients send ${CARDBOARD_SCHEMA_VERSION}. Raise it with the bump.`);
  }
  t.diagnostic(`wrangler.toml ${pinned === undefined ? "leaves SCHEMA_VERSION unset" : `pins SCHEMA_VERSION ${pinned}`}`);
});
