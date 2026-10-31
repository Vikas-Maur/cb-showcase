// serveUi / remoteUi: the view model across a process boundary (structuredClone + async delivery, like IPC).
import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteUi, serveUi, type ClientMessage, type ServerMessage } from "../src/remote.ts";
import { createMockUi, people } from "../src/mock.ts";
import type { CartonUi } from "../src/model.ts";

function pipe(served: CartonUi) {
  const toServer: ClientMessage[] = [];
  const toClient: ServerMessage[] = [];
  let server!: ReturnType<typeof serveUi>;
  // eslint-disable-next-line prefer-const
  let client!: ReturnType<typeof remoteUi>;
  server = serveUi(served, (m) => {
    toClient.push(m);
    const copy = structuredClone(m);
    setTimeout(() => client.receive(copy), 0);
  });
  client = remoteUi((m) => {
    toServer.push(m);
    const copy = structuredClone(m);
    setTimeout(() => server.receive(copy), 0);
  });
  return { client, server, toServer, toClient };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("the client mirrors History and topics after one init", async () => {
  const served = createMockUi({ versions: 10_000 });
  const { client, toClient } = pipe(served);
  await client.ready;
  const h = client.ui.history();
  assert.equal(h.count("all"), served.history().count("all"));
  assert.equal(h.count("named"), served.history().count("named"));
  assert.deepEqual(h.at("all", 0), served.history().at("all", 0));
  assert.deepEqual(client.ui.cuts(), served.cuts());
  assert.equal(client.ui.me().key, people.alice.key);
  assert.equal(client.ui.actor(people.explore.parent!)?.name, "Director", "parents of subagents travel with them");
  assert.equal(toClient.filter((m) => m.t === "init").length, 1);
});

test("a new version costs one row on the wire, and rows that didn't change keep their identity", async () => {
  const served = createMockUi({ versions: 10_000 });
  const { client, toClient } = pipe(served);
  await client.ready;
  const before = client.ui.history().at("all", 5);
  let notified = 0;
  client.ui.subscribe("history", () => notified++);
  toClient.length = 0;
  served.addVersion({ author: people.bob, summary: "Moved 'Intro' 0:00.0 → 0:01.0" });
  await tick();
  const hist = toClient.filter((m) => m.t === "history");
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.t === "history" && hist[0]!.rows.length, 1);
  assert.equal(client.ui.history().count("all"), served.history().count("all"));
  assert.equal(client.ui.history().at("all", 0)!.summary, "Moved 'Intro' 0:00.0 → 0:01.0");
  assert.equal(client.ui.history().at("all", 6), before, "unchanged rows keep their object on the client");
  assert.equal(notified, 1);
});

test("small topics travel whole; ghosts at 20 Hz don't touch History", async () => {
  const served = createMockUi({ versions: 100 });
  const { client, toClient } = pipe(served);
  await client.ready;
  toClient.length = 0;
  for (let i = 0; i < 20; i++) served.setGhosts([{ actorKey: people.bob.key, itemId: "x", trackId: "V1", start: i, end: i + 1 }]);
  served.setSync({ kind: "offline", waiting: 2 });
  await tick();
  assert.deepEqual(client.ui.sync(), { kind: "offline", waiting: 2 });
  assert.equal(client.ui.ghosts()[0]!.start, 19);
  assert.equal(toClient.filter((m) => m.t === "history").length, 0);
  assert.ok(toClient.filter((m) => m.t === "topic" && m.topic === "ghosts").length <= 2, "a burst of ghost moves is coalesced");
});

test("calls round-trip, and errors come back as errors", async () => {
  const served = createMockUi({ versions: 10 });
  const { client } = pipe(served);
  await client.ready;
  const cut = await client.ui.newCut("Teaser", "main@3");
  assert.equal(cut.name, "Teaser");
  await tick();
  assert.equal(client.ui.cuts().find((c) => c.current)?.name, "Teaser");
  const c = await client.ui.compare("main@3", "main@9");
  assert.match(String(c.diff.shots), /^\d+$/);
  const r = await client.ui.undo("not-the-top");
  assert.equal(r.ok, false);
  served.renameCut = async () => {
    throw new Error("Renaming a cut isn't available yet");
  };
  await assert.rejects(client.ui.renameCut!("cut-main", "x"), /isn't available yet/);
  client.ui.openPreview("main@3", "Sent to client, Monday");
  await tick();
  assert.equal(client.ui.preview()?.label, "Sent to client, Monday");
  client.ui.blockEdit();
  await tick();
  assert.equal(client.ui.preview()?.blockedEdit, true);
});

test("a renderer reload says hello again and gets everything again", async () => {
  const served = createMockUi({ versions: 50 });
  const { client, server, toClient } = pipe(served);
  await client.ready;
  toClient.length = 0;
  server.receive({ t: "hello" });
  await tick();
  assert.equal(toClient.filter((m) => m.t === "init").length, 1);
  served.addVersion({});
  await tick();
  assert.equal(toClient.filter((m) => m.t === "history").length, 1, "one subscription after the second hello, not two");
});
