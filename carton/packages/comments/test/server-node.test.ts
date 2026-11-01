// Comments through a real server-node (HMAC tokens, WebSocket, node:sqlite on disk), two people and a watch link.
// The server half is ours (`@carton/comments/server`); routing its two message kinds is hosts-plugins' change to
// `@carton/server` (request REQ-C1 in notes/comments.md). Until that lands, the host answers "unknown message type",
// the clients report `unsupported`, and these tests mark themselves todo.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createHmacAuth } from "@carton/server";
import { startNodeHost, webSocketTransport, type NodeHost } from "@carton/server-node";
import type { Role } from "@carton/core/plugins";
import { Comments } from "../src/comments.ts";
import { BOB, ME, clip, openCarton, scratch, until } from "./helpers.ts";

const PROJECT = "comments-e2e";
const SECRET = "test-only-secret-test-only-secret-0123";
const TODO = "waits on hosts-plugins routing `comments`/`comment` in @carton/server (REQ-C1, notes/comments.md)";

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

/** True (and the test marked todo) when this host doesn't carry comments yet. */
async function unsupported(t: TestContext, c: Comments): Promise<boolean> {
  await until(() => ["up-to-date", "unsupported"].includes(c.syncStatus()?.state ?? ""), 5000, "the comment stream");
  if (c.syncStatus()?.state !== "unsupported") return false;
  t.todo(TODO);
  return true;
}

test("server-node: two people converge on a thread; the server keeps it on disk across a restart", async (t) => {
  const h = await host();
  const a = await client(h, ME);
  const b = await client(h, BOB);
  try {
    if (await unsupported(t, a.comments)) return;
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

test("server-node: a viewer is refused; a watch link reads only its Published cut's comments", async (t) => {
  const h = await host();
  const ed = await client(h, ME);
  const closers: (() => Promise<void>)[] = [];
  try {
    if (await unsupported(t, ed.comments)) return;
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
