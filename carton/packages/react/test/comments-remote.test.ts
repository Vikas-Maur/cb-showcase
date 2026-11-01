// serveComments / remoteComments: the comments view model across a structured-clone channel (the Windows app's worker
// and renderer). Threads go once, then only the ones that changed; unchanged threads keep their objects; calls return.
import test from "node:test";
import assert from "node:assert/strict";
import { createMockComments, remoteComments, serveComments, type CommentsClientMessage, type CommentsServerMessage } from "../src/index.ts";

function wire() {
  const served = createMockComments();
  const wireLog: CommentsServerMessage[] = [];
  let server!: ReturnType<typeof serveComments>;
  const client = remoteComments((m: CommentsClientMessage) => queueMicrotask(() => server.receive(structuredClone(m))));
  server = serveComments(served, (m) => {
    wireLog.push(m);
    queueMicrotask(() => client.receive(structuredClone(m)));
  });
  return { served, client, wireLog };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("the renderer mirrors the worker's threads; a change sends that thread only; others keep their objects", async () => {
  const { served, client, wireLog } = wire();
  await client.ready;
  assert.deepEqual(client.ui.threads().map((t) => t.root.body), served.threads().map((t) => t.root.body));
  const before = client.ui.threads();
  const target = served.threads()[2]!;
  served.setPlacement(target.id, { status: "moved", range: [50, 50] });
  await tick();
  const delta = wireLog.at(-1)!;
  assert.equal(delta.t, "c-threads");
  assert.deepEqual((delta as { changed: unknown[] }).changed.length, 1);
  const after = client.ui.threads();
  assert.equal(after[2]!.placement?.status, "moved");
  assert.notEqual(after[2], before[2]);
  for (const i of [0, 1, 3, 4]) assert.equal(after[i], before[i], `thread ${i} kept its object`);
});

test("calls go through and return; status and notices follow", async () => {
  const { served, client } = wire();
  await client.ready;
  await client.ui.add("From the renderer", [3, 3]);
  assert.deepEqual(served.calls.at(-1), ["add", "From the renderer", [3, 3]]);
  await tick();
  assert.equal(client.ui.threads().at(-1)!.root.body, "From the renderer");
  await assert.rejects(client.ui.edit(served.threads()[0]!.id, "not mine"), /only its author/);
  served.setStatus({ state: "offline", waiting: 2 });
  served.setNotice("refused");
  await tick();
  assert.deepEqual([client.ui.status(), client.ui.notice()], [{ state: "offline", waiting: 2 }, "refused"]);
  client.ui.dismissNotice();
  await tick();
  await tick();
  assert.equal(client.ui.notice(), null);
});
