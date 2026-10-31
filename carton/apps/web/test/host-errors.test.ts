// A host that refuses this client (H-SV: an older host than the document's schema) shows in the sync status instead of
// a silent stall: the transport watcher, then the real path over a server-node host behind the documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Transport, TransportConnection } from "@carton/core/plugins";
import { createMemoryStore } from "@carton/store-memory";
import { webSocketTransport } from "@carton/server-node/transport";
import { serveDemo } from "../scripts/serve-node.ts";
import { seedDemo } from "../scripts/seed.ts";
import { parseJoinHash } from "../src/descriptor.ts";
import { problemWords, watchHostErrors } from "../src/host-errors.ts";
import { openProject } from "../src/project.ts";
import { Session, memoryKeys } from "../src/session.ts";

function fakeTransport() {
  const listeners: ((m: unknown) => void)[] = [];
  const conn = { open: true, send() {}, onMessage: (l: (m: unknown) => void) => void listeners.push(l), onClose() {}, close() {} } as unknown as TransportConnection;
  const transport: Transport = { connect: async () => conn };
  return { transport, deliver: (m: unknown) => listeners.forEach((l) => l(m)) };
}

test("a host's error is the sync problem until the host answers again", async () => {
  const f = fakeTransport();
  const w = watchHostErrors(f.transport);
  const seen: (string | null)[] = [];
  w.subscribe((p) => seen.push(p));
  await w.transport.connect("ws://x", { token: "t" });
  f.deliver({ type: "error", reason: "schemaVersion 2 is newer than this server's 1: update the server" });
  assert.equal(w.current(), "schemaVersion 2 is newer than this server's 1: update the server");
  f.deliver({ type: "error", reason: "schemaVersion 2 is newer than this server's 1: update the server" });
  f.deliver({ type: "history", req: 1, rows: [] });
  assert.ok(w.current(), "a history answer after a refused hello isn't the cut syncing");
  f.deliver({ type: "hello", branchId: "b", head: 0, rows: [], confirmed: [] });
  assert.equal(w.current(), null);
  assert.deepEqual(seen, ["schemaVersion 2 is newer than this server's 1: update the server", null], "told once, cleared once");
  assert.match(problemWords("schemaVersion 2 is newer than this server's 1: update the server"), /^Can't sync: this project needs a newer server/);
  assert.equal(problemWords("internal: boom"), "Can't sync: internal: boom");
});

test("over a real host behind the documents' schema: the refusal reaches the sync problem, nothing stalls silently", async () => {
  const scratch = join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "test-host-errors");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const fakeMedia = [1, 2, 3, 4].map((i) => ({ id: `media-${i}`, name: `S${i}`, hash: String(i).repeat(64), size: 1, duration: 6 }));
  // seeding goes over HTTP and a local Carton handing off: an up-to-date host for that, then an older one on the same data
  const seedHost = await serveDemo({ dataDir: join(scratch, "host"), staticDir: scratch });
  const seed = await seedDemo({ baseUrl: seedHost.url, adminToken: seedHost.adminToken, media: { given: fakeMedia } });
  await seedHost.close();
  const old = await serveDemo({ dataDir: join(scratch, "host"), staticDir: scratch, schemaVersion: 0 });
  try {
    const j = parseJoinHash(new URL(seed.bob).hash)!;
    const session = await Session.join({ baseUrl: old.url, projectId: j.projectId, invite: j.invite, account: "bob", keys: memoryKeys() });
    const problems = watchHostErrors(webSocketTransport());
    const { carton } = await openProject({ session, me: { kind: "human", id: "bob" }, store: createMemoryStore(), transport: problems.transport });
    try {
      const end = Date.now() + 8000;
      while (!problems.current() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      assert.match(problems.current() ?? "", /schemaVersion \d+ is newer than this server's 0/);
      assert.notEqual(carton.sync!.status, "up-to-date");
    } finally {
      await carton.close();
    }
  } finally {
    await old.close();
  }
});
