// Sync errors reach the app (web-demo REQ-8): a host that refuses this replica (a hello refused because the host is
// older than the app's document schema, a token it doesn't accept, no host at all) is a `sync-error` event and
// `carton.sync.error()`, until a later welcome or ack clears it. Before, only a transport tap could see it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type CartonEvent, type SyncError } from "@carton/core";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, set } from "./fixture.ts";
import { copyStore, until, world } from "./world.ts";

const errorsOf = (c: Carton) => {
  const seen: (SyncError | null)[] = [];
  c.on((e: CartonEvent) => void (e.type === "sync-error" && seen.push(e.error)));
  return seen;
};

test("REQ-8: a token the host doesn't accept is a sync error until the host takes it and welcomes the replica", async () => {
  const w = world();
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  // bob's token isn't known to the host yet
  const b = await Carton.open({ adapter, store: await copyStore(sa), sync: { transport: w.host.transport, url: w.host.url, token: "tok-late" } });
  const seen = errorsOf(b);
  await b.head(); // opens the shared cut's sync
  await until(() => b.sync!.error() !== null, 5000, "the error");
  assert.deepEqual(b.sync!.error(), { code: "unauthorized", message: "unauthorized" });
  assert.deepEqual(seen, [{ code: "unauthorized", message: "unauthorized" }], "one event, not one per retry");
  // the host takes the token: the next attempt is welcomed and the error clears
  w.sync("late");
  await until(() => b.sync!.error() === null, 5000, "the error cleared");
  assert.deepEqual(seen.at(-1), null);
  assert.equal((await b.commit({ ops: [set("a", "name", "bob's")], wait: 5000 })).status, "confirmed");
  for (const c of [a, b]) await c.close();
  w.host.close();
});

test("REQ-8: a host older than the app's document schema refuses its hello: an `update-server` sync error", async () => {
  const w = world({ schemaVersion: 1 });
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  assert.equal(a.sync!.error(), null);
  // an app a schema version ahead of the host (H-SV: Cardboard's schema 2 against a host that accepts 1)
  const b = await Carton.open({ adapter: { ...adapter, schemaVersion: 2 }, store: await copyStore(sa), sync: w.sync("bob") });
  const seen = errorsOf(b);
  await b.head();
  await until(() => b.sync!.error() !== null, 5000, "the refusal");
  assert.equal(b.sync!.error()!.code, "update-server");
  assert.match(b.sync!.error()!.message, /schemaVersion 2 is newer than this server's 1/);
  assert.equal(seen.length, 1);
  assert.equal(b.sync!.error(a.cut)!.code, "update-server", "by cut too");
  for (const c of [a, b]) await c.close();
  w.host.close();
});
