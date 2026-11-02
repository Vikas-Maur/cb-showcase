// Comments through a real server-node (HMAC tokens, WebSocket, node:sqlite on disk), two people and a watch link.
// The server half is ours (`@carton/comments/server`); `@carton/server` routes its two message kinds (REQ-C1,
// hosts-plugins' e712920).
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createHmacAuth } from "@carton/server";
import { startNodeHost, webSocketTransport, type NodeHost } from "@carton/server-node";
import type { Role } from "@carton/core/plugins";
import { Comments } from "../src/comments.ts";
import { BOB, ME, clip, openCarton, scratch, until } from "./helpers.ts";

const PROJECT = "comments-e2e";
const SECRET = "test-only-secret-test-only-secret-0123";

async function host(): Promise<{ node: NodeHost; token(role: Role, account: string, branches?: string[]): Promise<string> }> {
  const auth = createHmacAuth({ secret: SECRET });
  const node = await startNodeHost({ dataDir: path.join(scratch("node"), "data"), auth, durability: "normal", idleTimeoutMs: 0 });
  let dev = 0;
  return {
    node,
    token: (role, account, branches) => auth.issue({ account, credential: `${account}/dev-${++dev}`, role, projectId: PROJECT, ttlMs: 600_000, ...(branches ? { branches } : {}) }),
  };
}

async function client(h: Awaited<ReturnType<typeof host>>, who: { id: string; name: string }, role: Role = "editor", branches?: string[]) {
  const carton = await openCarton([clip("a", 0, 10), clip("c", 10, 20)]);
  const comments = await Comments.open({ carton, me: who, sync: { transport: webSocketTransport({ keepaliveMs: 0 }), url: h.node.urlFor(PROJECT), token: await h.token(role, who.id, branches) } });
  return { carton, comments };
}

/** The host carries comments: the stream catches up (a host from before REQ-C1 would say `unsupported`). */
async function caughtUp(c: Comments): Promise<void> {
  await until(() => ["up-to-date", "unsupported"].includes(c.syncStatus()?.state ?? ""), 5000, "the comment stream");
  assert.equal(c.syncStatus()?.state, "up-to-date", "the host routes comments (REQ-C1)");
}

test("server-node: two people converge on a thread; a third catches up from the server's storage", async () => {
  const h = await host();
  const a = await client(h, ME);
  const b = await client(h, BOB);
  try {
    await caughtUp(a.comments);
    const c = await a.comments.add({ body: "The logo is cut off", range: [3, 4] });
    await until(() => !!b.comments.get(c.id), 5000, "bob sees it");
    const r = await b.comments.reply(c.id, "Fixed in the next version");
    await b.comments.resolve(c.id);
    await until(() => a.comments.threads()[0]?.replies[0]?.id === r.id && !!a.comments.get(c.id)?.resolved, 5000, "alice sees the reply and the resolve");
    assert.equal(a.comments.get(c.id)!.author.id, "alice", "the author is the session's account");
    // a third person joins later: catch-up from the server's storage
    const late = await client(h, { id: "cora", name: "Cora" }, "commenter");
    await until(() => late.comments.threads()[0]?.replies.length === 1, 5000, "catch-up");
    await late.comments.close();
  } finally {
    await Promise.all([a.comments.close(), b.comments.close()]);
    await h.node.close();
  }
});

test("server-node: a viewer is refused; a watch link reads only its Published cut's comments, and no account id", async () => {
  const h = await host();
  const ed = await client(h, ME);
  const closers: (() => Promise<void>)[] = [];
  try {
    await caughtUp(ed.comments);
    const pub = await ed.carton.fork("For the client");
    const forClient = await ed.comments.add({ body: "Client: check the music", range: [1, 2], cut: pub.id });
    const internal = await ed.comments.add({ body: "Internal note", range: [1, 2] });
    const guest = await openCarton([clip("a", 0, 10)]);
    // the watch session names its Published cut in every message
    const watchView = await Comments.open({
      carton: guest,
      cut: () => pub.id,
      me: { id: "guest", name: "Guest" },
      sync: { transport: webSocketTransport({ keepaliveMs: 0 }), url: h.node.urlFor(PROJECT), token: await h.token("viewer", "guest", [pub.id]) },
    });
    closers.push(() => watchView.close());
    await until(() => watchView.all().some((x) => x.id === forClient.id), 5000, "the watch link's comment");
    assert.ok(!watchView.all().some((x) => x.id === internal.id));
    // the author as a link sees it: no people-record name here, so a label; nothing of alice's account
    assert.deepEqual(watchView.get(forClient.id)?.author, { id: "teammate:1", name: "Teammate 1" });
    assert.ok(!JSON.stringify(watchView.all()).includes(ME.id), "no account id in what the watch link keeps");
    assert.equal(ed.comments.get(forClient.id)?.author.id, ME.id, "the team sees the account");
    const refusals: string[] = [];
    watchView.on((e) => void (e.type === "refused" && refusals.push(e.refused)));
    await watchView.add({ body: "Can I?", range: [1, 2] });
    await until(() => refusals.length > 0, 5000, "the refusal");
    assert.deepEqual(refusals, ["forbidden"]);
  } finally {
    for (const f of closers) await f();
    await ed.comments.close();
    await h.node.close();
  }
});
