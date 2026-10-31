// openLocal({ sync }): the app's library worker opens its own handle with sync, so that handle can be the lease
// holder's engine (it connects under the lease nonce) and its shared-cut writes and status are its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthContext, AuthProvider } from "@carton/core/plugins";
import { createInProcessHost } from "@carton/server";
import { sqliteStorage } from "../../conformance/src/system/sqlite.ts";
import { openLocal } from "../src/open.ts";
import { adapter, bundle, doc0, schema } from "./support/real.ts";

const set = (id: string, f: string, v: unknown) => ({ op: "set", path: ["timelineItems", id, f], value: v });

test("openLocal passes sync to Carton.open: the handle shares a cut and its edits confirm through the host", async () => {
  const tokens = new Map<string, AuthContext>([["tok", { account: "alice", credential: "alice/install", role: "owner", projectId: "p", expires: Date.now() + 3600_000 }]]);
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth, timeline: schema.timeline!, groupOf: (c, f) => schema.collections[c]?.groupOf.get(f)?.name });
  const { dir, projectId } = bundle("open-sync");
  const lc = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: { kind: "human", id: "human:alice" }, sync: { transport: host.transport, url: host.url, token: "tok", autoConnect: false } });
  try {
    assert.ok(lc.carton.sync, "the handle has sync");
    assert.equal(lc.carton.sync!.state().status, "offline", "a local cut is not synced");
    await lc.carton.share();
    assert.equal(await lc.carton.sync!.connect({ timeoutMs: 5000 }), true);
    const deadline = Date.now() + 5000;
    while ((await lc.carton.cuts())[0]!.sequencer.kind !== "server" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await lc.carton.cuts())[0]!.sequencer.kind, "server", "handed off");
    const r = await lc.carton.commit({ ops: [set("c1", "opacity", 0.5)] as any, wait: 5000 });
    assert.equal(r.status, "confirmed");
    assert.equal(lc.carton.sync!.state().status, "up-to-date");
  } finally {
    await lc.carton.sync?.disconnect();
    await lc.close();
    host.close();
  }
});

test("openLocal without sync keeps the handle local-only (sync is null)", async () => {
  const { dir, projectId } = bundle("open-nosync");
  const lc = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: { kind: "human", id: "human:alice" } });
  try {
    assert.equal(lc.carton.sync, null);
  } finally {
    await lc.close();
  }
});
