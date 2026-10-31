// The §17 story at the protocol level, against a real server-node host (HTTP API + WebSocket + blob-fs): seed, Alice
// and Bob join from invites with empty stores, the Director bot edits captions while Bob trims, Alice undoes the
// agent's turn, Bob edits offline and rebases (one real clash becomes a card, the other edit lands), Alice publishes
// and a viewer follows the Published cut and sees newer edits. The browser e2e (e2e/web) drives the same through UI.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseNode, type Carton, type CartonEvent, type Rec } from "@carton/core";
import { cardboardAdapter } from "@carton/cardboard";
import { createMemoryStore } from "@carton/store-memory";
import { webSocketTransport } from "@carton/server-node/transport";
import { serveDemo, type DemoNodeHost } from "../scripts/serve-node.ts";
import { seedDemo, type SeedResult } from "../scripts/seed.ts";
import { Director } from "../scripts/director.ts";
import { parseJoinHash } from "../src/descriptor.ts";
import { trimOps } from "../src/edit.ts";
import { Follower } from "../src/follow.ts";
import { openProject } from "../src/project.ts";
import { Session, memoryKeys } from "../src/session.ts";

const scratch = join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "test-live");
const fakeMedia = [1, 2, 3, 4].map((i) => ({ id: `media-${i}`, name: `Sample ${i}`, hash: String(i).repeat(64), size: 1000, duration: 6 }));
let host: DemoNodeHost;
let seed: SeedResult;

async function until(pred: () => boolean | Promise<boolean>, ms = 8000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const clip = async (c: Carton, id: string) => ((await c.head()).doc.timelineItems as Rec[]).find((r) => r.id === id)!;

async function person(link: string, account: string): Promise<{ carton: Carton; session: Session }> {
  const j = parseJoinHash(new URL(link).hash)!;
  const session = await Session.join({ baseUrl: host.url, projectId: j.projectId, invite: j.invite, account, keys: memoryKeys() });
  const me = { kind: "human" as const, id: account, name: account[0]!.toUpperCase() + account.slice(1), group: account };
  const { carton } = await openProject({ session, me, store: createMemoryStore(), transport: webSocketTransport() });
  await until(() => carton.sync!.status === "up-to-date", 8000, `${account} connected`);
  return { carton, session };
}

// CARTON_LIVE_HOST=cloudflare runs the same story against the Worker under `wrangler dev` (local only)
before(async () => {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  if (process.env.CARTON_LIVE_HOST === "cloudflare") {
    const { startHost } = await import("../../../e2e/web/harness.ts");
    const h = await startHost("cloudflare", "live");
    host = { url: h.url, adminToken: h.adminToken, close: h.close } as DemoNodeHost;
  } else host = await serveDemo({ dataDir: join(scratch, "host"), staticDir: scratch });
  seed = await seedDemo({ baseUrl: host.url, adminToken: host.adminToken, media: { given: fakeMedia } });
});
after(async () => {
  await host?.close();
});

test("the §17 story over a real host: join, live edits with an agent, undo its turn, offline rebase, publish and watch", async () => {
  const alice = await person(seed.alice, "alice");
  const bob = await person(seed.bob, "bob");
  assert.equal(alice.session.role, "owner");
  assert.equal(bob.session.role, "editor");
  assert.equal(alice.carton.cut, seed.descriptor.cut.id, "both hold the host's Main cut");
  assert.equal(bob.carton.cut, seed.descriptor.cut.id);

  // presence reaches the other replica (never stored)
  const seen: CartonEvent[] = [];
  bob.carton.on((e) => e.type === "presence" && seen.push(e));
  alice.carton.sync!.presence({ activity: "Editing", ghosts: [{ item: "clip-2", track: "t-video", start: 4.5, end: 8.5 }] });
  await until(() => seen.some((e) => e.type === "presence" && (e.actor as { id: string }).id === "alice"), 5000, "bob sees alice's ghost");

  // the Director rewrites captions while Bob trims a clip: different fields, both land
  const j = parseJoinHash(new URL(seed.bob).hash)!;
  const director = await Director.start({ baseUrl: host.url, projectId: j.projectId, invite: j.invite, forAccount: "alice", gapMs: 50 });
  const turn = director.turn("captions");
  const c2 = await clip(bob.carton, "clip-2");
  const trim = await bob.carton.commit({ ops: trimOps(c2, "end", (c2.endTime as number) - 1), wait: 5000 });
  assert.equal(trim.status, "confirmed");
  const done = await turn;
  assert.deepEqual(done.results.map((r) => r.status), ["confirmed", "confirmed", "confirmed", "confirmed"]);
  await until(async () => (await clip(alice.carton, "cap-4")).captionText === "Same time next weekend?", 5000, "alice sees the turn");
  await until(async () => (await clip(alice.carton, "clip-2")).endTime === (c2.endTime as number) - 1, 5000, "alice sees bob's trim");
  // the turn's last version is named with the prompt; a subagent is credited as itself
  const log = await alice.carton.log();
  assert.ok(log.some((v) => v.name === "punch up the captions"));
  assert.equal((await alice.carton.credits(["timelineItems", "cap-4"]))?.kind, "subagent");

  // Alice undoes the agent's turn (it acts for her): all four captions go back, Bob's trim stays
  const stack = await alice.carton.undoStack();
  assert.ok(stack.length >= 4 && stack.slice(0, 4).every((e) => e.author.turn === "turn-1"));
  const u = await alice.carton.undo();
  assert.ok(u.status === "pending" || u.status === "confirmed", u.status);
  await until(async () => (await clip(bob.carton, "cap-1")).captionText === "Saturday, 7 am", 5000, "bob sees the undo");
  assert.equal((await clip(bob.carton, "cap-4")).captionText, "See you next weekend");
  assert.equal((await clip(bob.carton, "clip-2")).endTime, (c2.endTime as number) - 1, "bob's trim kept");

  // Bob goes offline and edits twice; meanwhile Alice trims the same clip end: one real clash, one clean edit
  await bob.carton.sync!.disconnect();
  const c3 = await clip(bob.carton, "clip-3");
  await bob.carton.commit({ ops: trimOps(c3, "end", (c3.endTime as number) - 1.5) });
  await bob.carton.commit({ ops: [{ op: "set", path: ["timelineItems", "cap-1", "captionText"], value: "Bob was offline" }] });
  assert.equal(bob.carton.sync!.state().label, "Offline: 2 edits waiting");
  const a3 = await clip(alice.carton, "clip-3");
  assert.equal((await alice.carton.commit({ ops: trimOps(a3, "end", (a3.endTime as number) - 0.5), wait: 5000 })).status, "confirmed");
  const cards: CartonEvent[] = [];
  bob.carton.on((e) => (e.type === "absorbed" || (e.type === "notice" && e.notice.cards?.length)) && cards.push(e));
  await bob.carton.sync!.connect();
  await until(() => bob.carton.sync!.state().pending === 0, 8000, "bob's queue settles");
  await until(() => cards.length > 0, 5000, "a card for the clash");
  const card = cards.map((e) => (e.type === "absorbed" ? e.cards : e.type === "notice" ? e.notice.cards ?? [] : [])).flat()[0]!;
  assert.match(card.path, /timelineItems\/clip-3/);
  assert.equal((await clip(bob.carton, "clip-3")).endTime, (a3.endTime as number) - 0.5, "head's value stays until Bob picks (H5)");
  await until(async () => (await clip(alice.carton, "cap-1")).captionText === "Bob was offline", 5000, "bob's clean offline edit lands");

  // Alice publishes the cut: the Published cut goes to the host as its own shared cut; a viewer reads it from nothing
  const pub = await alice.carton.publish({ name: "Main cut (published)" });
  await alice.carton.share(pub.id);
  await until(async () => (await alice.carton.cuts()).find((c) => c.id === pub.id)?.sequencer.kind === "server", 8000, "the published cut handed off");
  const at = parseNode(pub.forkOf!).seq;
  const viewer = await Session.join({ baseUrl: host.url, projectId: j.projectId, invite: await alice.session.invite("viewer"), account: "viewer", keys: memoryKeys() });
  assert.equal(viewer.role, "viewer");
  let watched: { doc: unknown; head: number } | null = null;
  let newer = 0;
  const common = { transport: webSocketTransport(), url: viewer.wsUrl, token: () => viewer.token(), schema: cardboardAdapter.schema, schemaVersion: cardboardAdapter.schemaVersion };
  const f1 = new Follower({ ...common, branchId: pub.id, have: -1, onUpdate: (s) => (watched = s) }).start();
  const f2 = new Follower({ ...common, branchId: alice.carton.cut, have: at, onUpdate: (s) => (newer = s.head - at) }).start();
  await until(() => watched?.doc != null, 5000, "the viewer reads the published version");
  const pubCap = ((watched!.doc as { timelineItems: Rec[] }).timelineItems).find((r) => r.id === "cap-1")!;
  assert.equal(pubCap.captionText, "Bob was offline");
  await until(() => f2 !== null && newer === 0, 3000, "no newer edits yet");
  await bob.carton.commit({ ops: [{ op: "set", path: ["timelineItems", "cap-2", "captionText"], value: "after publishing" }], wait: 5000 });
  await until(() => newer === 1, 5000, "the viewer is told there are newer edits");
  // a viewer can't push (the sequencer checks the role)
  const pubDoc = (watched!.doc as { timelineItems: Rec[] }).timelineItems.find((r) => r.id === "cap-2")!;
  assert.notEqual(pubDoc.captionText, "after publishing", "the published version doesn't move");
  f1.stop();
  f2.stop();

  await director.stop();
  await alice.carton.close();
  await bob.carton.close();
});
