// A conflict card names the teammate on the other side (REQ-U1, fixed by foundation-core 2c58dbd: `absorbed` fires
// after the settle, so every consumer reads current state at the event). Over a real server-node host: Bob
// trims a clip end offline, Alice trims the same end differently, Bob reconnects: his rebase makes a card, and its
// other side is Alice's edit. History names her; the card said "Someone".
//
// It said "Someone" while core emitted `absorbed` before the settle put the confirmed rows, Alice's change among them,
// into History: `carton.credits(record)` asked at that event answered null, and fromCarton's `nameOtherSide` asks then.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Carton, CartonEvent, Rec } from "@carton/core";
import { fromCarton } from "@carton/react";
import { createMemoryStore } from "@carton/store-memory";
import { webSocketTransport } from "@carton/server-node/transport";
import { serveDemo, type DemoNodeHost } from "../scripts/serve-node.ts";
import { seedDemo } from "../scripts/seed.ts";
import { parseJoinHash } from "../src/descriptor.ts";
import { trimOps } from "../src/edit.ts";
import { openProject } from "../src/project.ts";
import { Session, memoryKeys } from "../src/session.ts";

async function until(pred: () => boolean | Promise<boolean>, ms = 8000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface World {
  host: DemoNodeHost;
  alice: Carton;
  bob: Carton;
  /** Bob's rebase card, and what Bob's Carton credits for the clip when the card's event came. */
  creditAtEvent: unknown;
  ui: ReturnType<typeof fromCarton>;
}

async function rebaseCard(name: string): Promise<World> {
  const scratch = join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", `test-card-author-${name}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const host = await serveDemo({ dataDir: join(scratch, "host"), staticDir: scratch });
  const seed = await seedDemo({ baseUrl: host.url, adminToken: host.adminToken, media: { given: [1, 2, 3, 4].map((i) => ({ id: `media-${i}`, name: `S${i}`, hash: String(i).repeat(64), size: 1, duration: 6 })) } });
  const person = async (link: string, account: string, who: string) => {
    const j = parseJoinHash(new URL(link).hash)!;
    const session = await Session.join({ baseUrl: host.url, projectId: j.projectId, invite: j.invite, account, keys: memoryKeys() });
    const me = { kind: "human" as const, id: account, name: who, group: account };
    const { carton } = await openProject({ session, me, store: createMemoryStore(), transport: webSocketTransport() });
    await carton.setIdentity({ id: account, name: who }); // as the editor does at boot
    await until(() => carton.sync!.status === "up-to-date", 8000, `${who} connected`);
    return carton;
  };
  const alice = await person(seed.alice, "acct-alice", "Alice");
  const bob = await person(seed.bob, "acct-bob", "Bob");
  const ui = fromCarton(bob, { me: { kind: "human", id: "acct-bob", name: "Bob", group: "acct-bob" } });
  await ui.ready;
  const clip = async (c: Carton) => ((await c.head()).doc.timelineItems as Rec[]).find((r) => r.id === "clip-4")!;
  await bob.sync!.disconnect();
  await bob.commit({ ops: trimOps(await clip(bob), "end", ((await clip(bob)).endTime as number) - 0.5) });
  await alice.commit({ ops: trimOps(await clip(alice), "end", ((await clip(alice)).endTime as number) - 1.2), wait: 5000 });
  const world: World = { host, alice, bob, creditAtEvent: "unasked", ui };
  bob.on((e: CartonEvent) => {
    if (e.type === "absorbed" && e.cards.length && world.creditAtEvent === "unasked")
      void bob.credits(["timelineItems", "clip-4"], { cut: e.branchId }).then((w) => (world.creditAtEvent = w));
  });
  await bob.sync!.connect();
  await until(() => ui.conflicts().length > 0 && world.creditAtEvent !== "unasked", 8000, "Bob's rebase card");
  return world;
}

const done = async (w: World) => {
  w.ui.dispose?.();
  await w.alice.close();
  await w.bob.close();
  await w.host.close();
};

test("REQ-U1: credits asked at the card's event already names Alice", async () => {
  const w = await rebaseCard("cause");
  try {
    assert.equal((w.creditAtEvent as { name?: string } | null)?.name, "Alice", "at the absorbed event");
    await until(async () => (await w.bob.credits(["timelineItems", "clip-4"]))?.name === "Alice", 5000, "credits names Alice");
  } finally {
    await done(w);
  }
});

test("REQ-U1: a rebase card names the teammate on the other side", async () => {
  const w = await rebaseCard("card");
  try {
    await until(() => w.ui.conflicts()[0]?.theirs.author.name === "Alice", 5000, `the card naming Alice (it says ${w.ui.conflicts()[0]?.theirs.author.name})`);
  } finally {
    await done(w);
  }
});
