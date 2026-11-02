// A host that refuses this client (H-SV: an older host than the document's schema) shows in the sync status instead of
// a silent "Syncing": Carton's sync error (REQ-8) over a real server-node host behind the documents, and its words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CartonEvent } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { webSocketTransport } from "@carton/server-node/transport";
import { serveDemo } from "../scripts/serve-node.ts";
import { seedDemo } from "../scripts/seed.ts";
import { parseJoinHash } from "../src/descriptor.ts";
import { shownProblem, syncProblemWords } from "../src/sync-problem.ts";
import { openProject, readDescriptor } from "../src/project.ts";
import { Session, memoryKeys } from "../src/session.ts";

let seenCode: string | undefined; // what core called the real refusal (REQ-9 below)

test("the words say what is wrong and what to do; an unreachable host is left to the sync words", () => {
  assert.equal(syncProblemWords({ code: "update-server", message: "…: update the server" }), "Can't sync: this project needs a newer server");
  assert.equal(syncProblemWords({ code: "server", message: "internal: boom" }), "Can't sync: internal: boom");
  // the server's daily limit (cf review finding 2): when the kept edits sync, in the editor's own time
  const until = Date.UTC(2026, 10, 3, 0, 0, 30);
  const at = new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  assert.equal(syncProblemWords({ code: "write-limit", message: "…", until }), `The server's daily limit is reached: your edits are kept and will sync after ${at}`);
  assert.doesNotMatch(syncProblemWords({ code: "write-limit", message: "…" }), /Can't sync|undefined/);
  const refused = { code: "unauthorized" as const, message: "…" };
  assert.equal(shownProblem(refused), refused, "a refused link is shown");
  assert.equal(shownProblem({ code: "unreachable", message: "…" }), null, "unreachable: the sync words say Offline: n edits waiting");
});

test("over a real host behind the documents' schema: the refusal is the cut's sync error, nothing stalls silently", async () => {
  const scratch = join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "test-sync-problem");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const fakeMedia = [1, 2, 3, 4].map((i) => ({ id: `media-${i}`, name: `S${i}`, hash: String(i).repeat(64), size: 1, duration: 6 }));
  // seeding needs a host that syncs: an up-to-date one, then an older one on the same data
  const seedHost = await serveDemo({ dataDir: join(scratch, "host"), staticDir: scratch });
  const seed = await seedDemo({ baseUrl: seedHost.url, adminToken: seedHost.adminToken, media: { given: fakeMedia } });
  await seedHost.close();
  const old = await serveDemo({ dataDir: join(scratch, "host"), staticDir: scratch, schemaVersion: 0 });
  try {
    const j = parseJoinHash(new URL(seed.bob).hash)!;
    const session = await Session.join({ baseUrl: old.url, projectId: j.projectId, invite: j.invite, account: "bob", keys: memoryKeys() });
    const { carton } = await openProject({ session, me: { kind: "human", id: "bob" }, store: createMemoryStore(), transport: webSocketTransport() });
    const events: CartonEvent[] = [];
    carton.on((e) => e.type === "sync-error" && events.push(e));
    try {
      const end = Date.now() + 8000;
      while (!carton.sync!.error() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      const err = carton.sync!.error();
      seenCode = err?.code;
      assert.ok(err, "a sync error, not a silent Syncing");
      assert.match(err.message, /update the server/);
      assert.ok(events.length > 0, "told as a sync-error event too");
      assert.notEqual(carton.sync!.status, "up-to-date");
    } finally {
      await carton.close();
    }
  } finally {
    await old.close();
  }
});

test("REQ-9: core classifies the hosts' refusal by its code as update-server", () => {
  assert.equal(seenCode, "update-server");
});

test("REQ-9b: a host that has gone away is unreachable, not a refused link", async () => {
  const scratch = join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "test-sync-gone");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const fakeMedia = [1, 2, 3, 4].map((i) => ({ id: `media-${i}`, name: `S${i}`, hash: String(i).repeat(64), size: 1, duration: 6 }));
  const host = await serveDemo({ dataDir: join(scratch, "host"), staticDir: scratch });
  const seed = await seedDemo({ baseUrl: host.url, adminToken: host.adminToken, media: { given: fakeMedia } });
  const j = parseJoinHash(new URL(seed.bob).hash)!;
  const session = await Session.join({ baseUrl: host.url, projectId: j.projectId, invite: j.invite, account: "bob", keys: memoryKeys() });
  const descriptor = await readDescriptor(session); // kept in the browser, as when a project reopens offline
  await host.close();
  const { carton } = await openProject({ session, me: { kind: "human", id: "bob" }, store: createMemoryStore(), transport: webSocketTransport(), descriptor });
  try {
    const end = Date.now() + 8000;
    while (!carton.sync!.error() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.equal(carton.sync!.error()?.code, "unreachable", JSON.stringify(carton.sync!.error()));
    assert.equal(shownProblem(carton.sync!.error()), null, "the sync status says offline, not a refusal");
  } finally {
    await carton.close();
  }
});
