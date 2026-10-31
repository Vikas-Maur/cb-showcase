// Core behaviour the web demo needs and asks foundation-core for (core changes go only through foundation-core,
// BOARD.md 10:00 UTC). Each is a `todo` test: it runs and reports, and fails until core has it, without failing this
// suite. The request and its reason are in the web-demo notes ("Requests to foundation-core").
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type Actor } from "@carton/core";
import type { AuthContext, AuthProvider } from "@carton/core/plugins";
import { cardboardAdapter } from "@carton/cardboard";
import { createInProcessHost } from "@carton/server";
import { createMemoryStore } from "@carton/store-memory";
import { demoDoc } from "../src/demo-doc.ts";
import { sqliteStorage } from "../../../packages/conformance/src/system/sqlite.ts";

const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice" };
const media = [1, 2].map((i) => ({ id: `media-${i}`, name: `S${i}`, hash: String(i).repeat(64), size: 1, duration: 6 }));
const setName = (id: string, v: string) => ({ op: "set" as const, path: ["timelineItems", id, "name"], value: v });
async function until(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a shared Published cut is read-only to restore, undo and fold too, not only commit (web-demo review R1-6, REQ-1)", async () => {
  const tokens = new Map<string, AuthContext>([["tok", { account: "alice", credential: "alice/i", role: "owner", projectId: "p", expires: Date.now() + 3600_000 }]]);
  const auth: AuthProvider = { kind: "table", async verify(t) { return tokens.get(t) ?? null; } };
  const host = createInProcessHost({ storage: sqliteStorage(), auth });
  const a = await Carton.open({ adapter: cardboardAdapter, store: createMemoryStore(), init: { doc: demoDoc(media), projectId: "p" }, actor: alice, sync: { transport: host.transport, url: host.url, token: "tok" } });
  try {
    await a.share();
    await until(async () => (await a.cuts()).find((c) => c.id === a.cut)!.sequencer.kind === "server");
    const main = a.cut;
    await a.commit({ ops: [setName("clip-1", "one")], wait: 5000 });
    const pub = await a.publish({ name: "Published" });
    await a.share(pub.id);
    await until(async () => (await a.cuts()).find((c) => c.id === pub.id)?.sequencer.kind === "server");
    await assert.rejects(a.commit({ cut: pub.id, ops: [setName("clip-1", "x")] }), /read-only/, "commit (already refused)");
    await assert.rejects(a.restore(`${main}@0`, { cut: pub.id }), /read-only/, "restore");
    await assert.rejects(a.undo(undefined, { cut: pub.id }), /read-only/, "undo");
    assert.equal((await a.commit({ ops: [setName("clip-1", "two")], wait: 5000 })).status, "confirmed");
    await assert.rejects(a.fold(main, { into: pub.id }), /read-only/, "fold");
  } finally {
    await a.close();
    host.close();
  }
});
