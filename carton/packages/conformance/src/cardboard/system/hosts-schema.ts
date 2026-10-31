// H-SV (e2e-qa): every Cardboard client sends its adapter's schema version (CARDBOARD_SCHEMA_VERSION) in `hello`, and a
// host's sequencer refuses a client newer than the version it accepts. When `82d8c70` raised it to 2 both hosts still
// defaulted to 1, and live sync stalled without a word to the person. These check what the hosts do with their
// defaults, not how their source spells them (a text match broke on the fix itself: CI run 41227528651):
// - server-node, started with no `schemaVersion`: a real Cardboard client shares a cut through it, its commit is
//   confirmed, and no sync error comes back;
// - server-cloudflare: the version the room configures its sequencer with (`schemaVersionOf`), unset and with the vars
//   its wrangler.toml ships, accepts Cardboard's clients.
// They run where the workspace has the hosts (the integration branch, CI) and are skipped where a host is still a stub;
// a host that is there but whose entry point moved fails, so the check is updated rather than skipped.
import test from "node:test";
import assert from "node:assert/strict";
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

interface NodeHostModule {
  startNodeHost(opts: Record<string, unknown>): Promise<{ urlFor(projectId: string): string; close(): Promise<void> }>;
  webSocketTransport(opts: Record<string, unknown>): Transport;
}
interface ServerModule {
  createHmacAuth(opts: { secret: string }): { issue(claims: Record<string, unknown>): string | Promise<string> };
}
interface RoomModule {
  schemaVersionOf(env: { SCHEMA_VERSION?: string }): number;
}

test("H-SV: server-node started with no schemaVersion takes a Cardboard client: it shares a cut and its commit is confirmed [real host]", async (t) => {
  if (!has("server-node/src/host.ts")) return t.skip("server-node's host isn't in this workspace (a stub)");
  const { startNodeHost, webSocketTransport } = await load<NodeHostModule>("@carton/server-node");
  const { createHmacAuth } = await load<ServerModule>("@carton/server");
  assert.ok(startNodeHost && webSocketTransport && createHmacAuth, "server-node's startNodeHost/webSocketTransport or @carton/server's createHmacAuth moved: update hosts-schema.ts");
  assert.equal(cardboardAdapter.schemaVersion, CARDBOARD_SCHEMA_VERSION, "a Cardboard client sends CARDBOARD_SCHEMA_VERSION");
  const secret = "test-only-secret-test-only-secret-0123";
  const auth = createHmacAuth({ secret });
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(SCRATCH, "hsv-node-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const host = await startNodeHost({ dataDir, auth, secret, durability: "normal" }); // no schemaVersion: the default
  t.after(() => host.close());
  const token = await auth.issue({ account: "alice", credential: "alice/dev", role: "owner", projectId: "p", ttlMs: 60_000 });
  const alice = { kind: "human" as const, id: "alice" };
  const carton = await Carton.open({
    adapter: cardboardAdapter,
    store: createMemoryStore(),
    actor: alice,
    init: { doc: fromHost({ tracks: [{ id: "V1", type: "video" }], timelineItems: [clip("X", 0, 10)] }, null) },
    sync: { transport: webSocketTransport({ keepaliveMs: 0 }), url: host.urlFor("p"), token, autoConnect: false },
  });
  t.after(() => carton.close());
  const errors: string[] = [];
  carton.on((e) => {
    const x = e as { type: string; error?: { code: string; message: string } | null };
    if (x.type === "sync-error" && x.error) errors.push(`${x.error.code}: ${x.error.message}`);
  });
  await carton.share();
  assert.ok(await carton.sync!.connect({ nonce: "hsv" }), `connected (${errors.join("; ")})`);
  const shared = async () => (await carton.cuts()).find((c) => c.id === carton.cut)?.sequencer.kind === "server";
  for (const end = Date.now() + 10_000; !(await shared()); await new Promise((r) => setTimeout(r, 20))) {
    assert.ok(Date.now() < end && !errors.length, `the host never took the cut: ${errors.join("; ") || "no answer"} (H-SV: does its default accept schema version ${CARDBOARD_SCHEMA_VERSION}?)`);
  }
  const h = await carton.head();
  const host0 = toHost(h.doc);
  const items = structuredClone(host0.timelineItems as Item[]);
  find(items, "X").name = "through the host";
  const r = await carton.commit({ doc: fromHost({ ...host0, timelineItems: items }, h.doc), author: alice });
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
