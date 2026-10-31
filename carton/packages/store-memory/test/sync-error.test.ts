// Sync errors reach the app (web-demo REQ-8): a host that refuses this replica (a hello refused because the host is
// older than the app's document schema, a token it doesn't accept, no host at all) is a `sync-error` event and
// `carton.sync.error()`, until a later welcome or ack clears it. Before, only a transport tap could see it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, type CartonEvent, type SyncError } from "@carton/core";
import { transportError, type Transport } from "@carton/core/plugins";
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
  // the host's words (this branch's server, or hosts-plugins' since 9d52fc4, which also sends `code: "schema-too-new"`)
  assert.match(b.sync!.error()!.message, /schemaVersion 2 is newer than this server's 1|schema version 2, newer than this server accepts \(up to 1\)/);
  assert.equal(seen.length, 1);
  assert.equal(b.sync!.error(a.cut)!.code, "update-server", "by cut too");
  for (const c of [a, b]) await c.close();
  w.host.close();
});

/** The host's transport, with its refusals rewritten as hosts-plugins' host words them (9d52fc4). */
function asNewHost(t: Transport, code: boolean): Transport {
  return {
    async connect(url, o) {
      const c = await t.connect(url, o);
      return {
        get open() {
          return c.open;
        },
        send: (m) => c.send(m),
        onMessage: (l) =>
          c.onMessage((m) => {
            const v = m.type === "error" && /schemaVersion (\d+) is newer than this server's (\d+)/.exec(m.reason);
            if (!v) return l(m);
            l({ type: "error", reason: `this client's documents are schema version ${v[1]}, newer than this server accepts (up to ${v[2]}): update the server`, ...(code ? { code: "schema-too-new" as const } : {}) });
          }),
        onClose: (l) => c.onClose(l),
        close: () => c.close(),
      };
    },
  };
}

for (const code of [true, false])
  test(`REQ-9: an older host's refusal in its new words${code ? ", with its code" : " (no code: matched by the words)"} is \`update-server\``, async () => {
    const w = world({ schemaVersion: 1 });
    const sa = createMemoryStore();
    const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, sync: w.sync("alice") });
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
    const b = await Carton.open({ adapter: { ...adapter, schemaVersion: 2 }, store: await copyStore(sa), sync: { ...w.sync("bob"), transport: asNewHost(w.host.transport, code) } });
    await b.head();
    await until(() => b.sync!.error() !== null, 5000, "the refusal");
    assert.deepEqual(b.sync!.error(), { code: "update-server", message: "this client's documents are schema version 2, newer than this server accepts (up to 1): update the server" });
    for (const c of [a, b]) await c.close();
    w.host.close();
  });

test("REQ-9: a failed connect is classified by its transport's code: unreachable even when the words mention the token", async () => {
  const w = world();
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  for (const [code, words, expected] of [
    ["unreachable", "connection refused or dropped (check the token and URL)", "unreachable"],
    ["unauthorized", "the host refused this session", "unauthorized"],
  ] as const) {
    const refusing: Transport = { connect: async () => Promise.reject(transportError(words, code)) };
    const b = await Carton.open({ adapter, store: await copyStore(sa), sync: { transport: refusing, url: w.host.url, token: "tok-x" } });
    await b.head();
    await until(() => b.sync!.error() !== null, 5000, "the connect failure");
    assert.deepEqual(b.sync!.error(), { code: expected, message: words });
    await b.close();
  }
  await a.close();
  w.host.close();
});

test("REQ-9b: through a real host: an offline host is `unreachable`, a token it refuses `unauthorized`", async () => {
  const w = world();
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const copy = await copyStore(sa);
  // a token the host doesn't accept
  const bad = await Carton.open({ adapter, store: await copyStore(sa), sync: { transport: w.host.transport, url: w.host.url, token: "tok-nobody" } });
  await bad.head();
  await until(() => bad.sync!.error() !== null, 5000, "the refusal");
  assert.equal(bad.sync!.error()!.code, "unauthorized");
  await bad.close();
  await a.close();
  // the host is gone: offline, whatever the token
  w.host.close();
  const offline = await Carton.open({ adapter, store: copy, sync: w.sync("bob") });
  await offline.head();
  await until(() => offline.sync!.error() !== null, 5000, "the connect failure");
  assert.equal(offline.sync!.error()!.code, "unreachable", JSON.stringify(offline.sync!.error()));
  await offline.close();
});

test("REQ-9b: a transport from before codes (server-node's old offline words mention the token) is `unreachable`", async () => {
  const w = world();
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, sync: w.sync("alice") });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === "server", 5000, "the hand-off");
  const old: Transport = { connect: async () => Promise.reject(new Error("connection refused or dropped (check the token and URL)")) };
  const b = await Carton.open({ adapter, store: await copyStore(sa), sync: { transport: old, url: w.host.url, token: "tok-x" } });
  await b.head();
  await until(() => b.sync!.error() !== null, 5000, "the connect failure");
  assert.deepEqual(b.sync!.error(), { code: "unreachable", message: "connection refused or dropped (check the token and URL)" });
  for (const c of [a, b]) await c.close();
  w.host.close();
});
