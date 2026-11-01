// Comments in the web demo (REQ-C3) over a real server-node host: the editor's wiring (openEditorComments: the
// project's transport, URL and token, placed again when the head moves) and the watch page's (openWatchComments over
// FollowedVersion). Alice comments at a moment on a clip, Bob sees it and replies; a viewer reads and is refused a
// comment; Alice moves the clip and the comment follows; a watch link reads only its Published cut's comments, with
// authors by name or "Teammate N" and no account id. The browser e2e drives the same through the panel.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Carton, Rec } from "@carton/core";
import type { Comments } from "@carton/comments";
import { createMemoryStore } from "@carton/store-memory";
import { webSocketTransport } from "@carton/server-node/transport";
import { serveDemo, type DemoNodeHost } from "../scripts/serve-node.ts";
import { seedDemo, type SeedResult } from "../scripts/seed.ts";
import { FollowedVersion, gatedTransport, openEditorComments, openWatchComments } from "../src/comments.ts";
import { parseJoinHash } from "../src/descriptor.ts";
import { moveOps } from "../src/edit.ts";
import { openProject } from "../src/project.ts";
import { Session, memoryKeys } from "../src/session.ts";

const scratch = join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "test-comments");
const fakeMedia = [1, 2, 3, 4].map((i) => ({ id: `media-${i}`, name: `Sample ${i}`, hash: String(i).repeat(64), size: 1000, duration: 6 }));
let host: DemoNodeHost;
let seed: SeedResult;
const open: { close(): Promise<void> }[] = [];

async function until(pred: () => boolean | Promise<boolean>, ms = 8000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Person {
  carton: Carton;
  session: Session;
  comments: Comments;
  ui: Awaited<ReturnType<typeof openEditorComments>>["ui"];
}

async function person(link: string, account: string, name: string): Promise<Person> {
  const j = parseJoinHash(new URL(link).hash)!;
  const session = await Session.join({ baseUrl: host.url, projectId: j.projectId, invite: j.invite, account, keys: memoryKeys() });
  const transport = webSocketTransport();
  const { carton } = await openProject({ session, me: { kind: "human", id: account, name, group: account }, store: createMemoryStore(), transport });
  await carton.setIdentity({ id: account, name });
  await until(() => carton.sync!.status === "up-to-date", 8000, `${name} connected`);
  const listeners = new Set<() => void>();
  carton.on((e) => e.type === "change" && listeners.forEach((l) => l()));
  const { comments, ui } = await openEditorComments({
    carton,
    sync: { transport, url: session.wsUrl, token: () => session.token() },
    versions: { on: (l) => (listeners.add(l), () => listeners.delete(l)) },
    canComment: () => session.role !== "viewer",
  });
  open.push({ close: async () => (ui.close(), await comments.close(), await carton.close()) });
  return { carton, session, comments, ui };
}

const clip = async (c: Carton, id: string) => ((await c.head()).doc.timelineItems as Rec[]).find((r) => r.id === id)!;

before(async () => {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  host = await serveDemo({ dataDir: join(scratch, "host"), staticDir: scratch });
  seed = await seedDemo({ baseUrl: host.url, adminToken: host.adminToken, media: { given: fakeMedia } });
});
after(async () => {
  for (const o of open.reverse()) await o.close().catch(() => {});
  await host?.close();
});

test("comments over a real host: live with replies, a viewer reads only, a moved clip takes its comment along, a watch link sees its cut's only", async () => {
  const alice = await person(seed.alice, "acct-alice-7f3", "Alice");
  const bob = await person(seed.bob, "acct-bob-91c", "Bob");

  // Alice comments at a moment inside clip-2, in the first half second (no caption over it there)
  const c2 = await clip(alice.carton, "clip-2");
  const at = (c2.startTime as number) + 0.25;
  const root = await alice.comments.add({ body: "Music comes in too early", range: [at, at] });
  await until(() => bob.comments.threads().some((t) => t.root.id === root.id), 8000, "Bob sees Alice's comment");
  assert.equal(bob.comments.get(root.id)?.author.name, "Alice", "the team sees authors by name");
  await bob.comments.reply(root.id, "Agreed, I'll look");
  await until(() => alice.comments.threads().find((t) => t.root.id === root.id)?.replies.length === 1, 8000, "Alice sees Bob's reply");
  assert.ok(await alice.comments.settled());

  // a viewer reads them and can't write one: the panel offers no box, and the host refuses one sent anyway
  const viewer = await person(seed.viewer, "acct-viewer-2d4", "Vic");
  assert.equal(viewer.ui.canComment(), false);
  await until(() => viewer.comments.threads().some((t) => t.root.id === root.id), 8000, "the viewer reads the comment");
  const refused = new Promise<string>((r) => viewer.comments.on((e) => e.type === "refused" && r(e.reason)));
  const sneaky = await viewer.comments.add({ body: "a viewer's comment", range: [1, 1] });
  assert.match(await refused, /viewer/i);
  await until(() => !viewer.comments.get(sneaky.id), 8000, "the refused comment is gone from the viewer's view");
  assert.ok(!(await alice.comments.settled(500)) || !alice.comments.get(sneaky.id), "nobody else ever sees it");

  // Alice moves clip-2 past the end, where nothing else shows: the comment follows it there, "moved"
  const before = await alice.comments.placements();
  assert.equal(before.get(root.id)?.status, "exact");
  const end = Math.max(...((await alice.carton.head()).doc.timelineItems as Rec[]).map((r) => r.endTime as number));
  const by = end + 1 - (c2.startTime as number);
  await alice.carton.commit({ ops: moveOps(c2, (c2.startTime as number) + by), wait: 5000 });
  const after = await alice.comments.placements();
  assert.equal(after.get(root.id)?.status, "moved", JSON.stringify(after.get(root.id)));
  assert.ok(Math.abs(after.get(root.id)!.range![0] - (at + by)) < 1e-3, JSON.stringify(after.get(root.id)));
  await until(async () => (await bob.comments.placements()).get(root.id)?.status === "moved", 8000, "Bob's copy follows too");

  // publish; Alice comments on the Published cut; a watch link reads that comment and nothing else
  const pub = await alice.carton.publish({ name: "Main cut (published)" });
  await alice.carton.share(pub.id);
  await until(async () => (await alice.carton.cuts()).find((c) => c.id === pub.id)?.sequencer.kind === "server", 8000, "the published cut handed off");
  const onPub = await alice.comments.add({ body: "Lovely ending", range: [at + by, at + by], cut: pub.id });
  assert.ok(await alice.comments.settled());

  const watchInvite = await alice.session.invite("viewer", 60_000, [pub.id]);
  const ws = await Session.join({ baseUrl: host.url, projectId: seed.projectId, invite: watchInvite, account: "viewer", keys: memoryKeys() });
  const { doc } = await alice.carton.head(pub.id);
  const version = new FollowedVersion(pub.id, alice.carton.schema, 0, doc);
  const sent: string[] = [];
  const inner = webSocketTransport();
  // every frame the watch link receives, to check that no account id reaches it
  const spy = gatedTransport(
    {
      async connect(url, o) {
        const c = await inner.connect(url, o);
        c.onMessage((m) => sent.push(JSON.stringify(m)));
        return c;
      },
    },
    () => true,
  );
  const watch = await openWatchComments({ version, sync: { transport: spy.transport, url: ws.wsUrl, token: () => ws.token() } });
  open.push({ close: async () => (watch.ui.close(), await watch.comments.close()) });
  await until(() => watch.comments.threads().length > 0, 8000, "the watch link reads the published cut's comments");
  await new Promise((r) => setTimeout(r, 300)); // anything else would have come by now
  assert.deepEqual(
    watch.comments.threads().map((t) => t.root.id),
    [onPub.id],
    "the Published cut's comment only",
  );
  const author = watch.comments.get(onPub.id)!.author;
  assert.ok(author.name === "Alice" || /^Teammate \d+$/.test(author.name), author.name);
  const traffic = sent.join("\n") + JSON.stringify(watch.comments.all());
  for (const acct of ["acct-alice-7f3", "acct-bob-91c", "acct-viewer-2d4"]) assert.ok(!traffic.includes(acct), `no ${acct} in what the watch link got`);
  assert.equal(watch.ui.canComment(), false);
  const placed = await watch.comments.placements();
  assert.equal(placed.get(onPub.id)?.status, "exact", "placed on the version the page shows");
});

test("Go offline closes the comments' connection and refuses new ones until back", async () => {
  let online = true;
  const closed: string[] = [];
  const inner = {
    async connect() {
      return { open: true, send() {}, onMessage() {}, onClose: () => void closed.push("listening"), close: () => void closed.push("closed") };
    },
  };
  const gate = gatedTransport(inner as never, () => online);
  await gate.transport.connect("ws://x", { token: "t" });
  online = false;
  gate.drop();
  assert.deepEqual(closed, ["listening", "closed"]);
  await assert.rejects(gate.transport.connect("ws://x", { token: "t" }), (e: Error & { code?: string }) => e.code === "unreachable");
  online = true;
  await gate.transport.connect("ws://x", { token: "t" });
});
