// The media Service Worker's logic (media-worker.ts) in Node: a fake worker scope stands in for the browser's (pages,
// messages, fetch events), and everything behind it is real: httpBlobStore, MediaReader and serveMedia against a Node
// host holding uploaded media. A real Chromium run is in browser-media.test.ts.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { LEAF_SIZE, mediaHash, mediaKey, uploadMedia, bytesSource } from "@carton/media";
import { nodeHasher } from "@carton/media/node";
import { httpBlobStore } from "../src/http-blobs.ts";
import type { SessionMessage, WorkerMessage } from "../src/media-protocol.ts";
import { installMediaWorker, type ExtendableEventLike, type FetchEventLike, type MediaWorkerOptions, type MessageEventLike, type WorkerClient, type WorkerScope } from "../src/media-worker.ts";
import { startTestHost, type TestHost } from "./host.ts";
import { corruptingFetch, recordingFetch, sameBytes, seededBytes } from "./util.ts";

let th: TestHost;
const tokens: Record<string, string> = {};
const media: Record<string, { hash: string; data: Uint8Array }> = {};

async function put(projectId: string, name: string, data: Uint8Array): Promise<void> {
  const manifest = await mediaHash(data, nodeHasher);
  const store = httpBlobStore({ baseUrl: th.url, projectId, token: () => tokens[projectId]! });
  await uploadMedia({ store, hasher: nodeHasher, source: bytesSource(data), manifest });
  media[name] = { hash: manifest.hash, data };
}

before(async () => {
  th = await startTestHost();
  tokens.p1 = await th.session("p1");
  tokens.p2 = await th.session("p2");
  await put("p1", "a", seededBytes(3 * LEAF_SIZE + 77, 1));
  await put("p1", "b", seededBytes(200_000, 2));
  await put("p2", "c", seededBytes(150_000, 3));
});
after(() => th.close());

/** A ServiceWorkerGlobalScope stand-in: pages are clients that record what the worker posts to them. */
class FakeScope implements WorkerScope {
  readonly location: { origin: string };
  readonly pages = new Map<string, WorkerClient & { got: WorkerMessage[]; onMessage?: (m: WorkerMessage) => void }>();
  readonly #listeners = new Map<string, ((e: never) => void)[]>();
  claims = 0;
  readonly clients = {
    claim: async () => {
      this.claims++;
    },
    get: async (id: string) => this.pages.get(id),
    matchAll: async () => [...this.pages.values()],
  };
  constructor(origin: string) {
    this.location = { origin };
  }
  skipWaiting = async () => {};
  addEventListener(type: string, fn: (e: never) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
  }
  #dispatch(type: string, e: unknown): void {
    for (const fn of this.#listeners.get(type) ?? []) fn(e as never);
  }
  page(id: string, onMessage?: (m: WorkerMessage) => void) {
    const p = { id, got: [] as WorkerMessage[], onMessage, postMessage: (m: WorkerMessage) => (p.got.push(m), p.onMessage?.(m)) };
    this.pages.set(id, p);
    return p;
  }
  /** The page `from` posts a message to the worker. */
  message(data: unknown, from: string): void {
    const e: MessageEventLike = { data, source: { id: from }, waitUntil: () => {} };
    this.#dispatch("message", e);
  }
  /** A request from page `clientId`: the worker's response, or undefined when it lets the request go to the network. */
  fetch(url: string, init: RequestInit = {}, clientId = ""): Promise<Response> | undefined {
    let answer: Promise<Response> | undefined;
    const e: FetchEventLike = { request: new Request(url, init), clientId, respondWith: (r) => (answer = r), waitUntil: () => {} };
    this.#dispatch("fetch", e);
    return answer;
  }
  lifecycle(type: "install" | "activate"): Promise<unknown> {
    let p: Promise<unknown> = Promise.resolve();
    const e: ExtendableEventLike = { waitUntil: (x) => (p = x) };
    this.#dispatch(type, e);
    return p;
  }
}

const session = (projectId: string, token = tokens[projectId]!): SessionMessage => ({ type: "carton-session", baseUrl: th.url, projectId, token });

function worker(opts: MediaWorkerOptions = {}): FakeScope {
  const sw = new FakeScope(th.url);
  installMediaWorker(sw, opts);
  return sw;
}

test("install and activate take over open pages at once", async () => {
  const sw = worker();
  await sw.lifecycle("install");
  await sw.lifecycle("activate");
  assert.equal(sw.claims, 1);
});

test("only same-origin /media/<hash> requests are answered; everything else goes to the network", async () => {
  const sw = worker({ sessionWaitMs: 20 });
  const h = "a".repeat(64);
  for (const url of [
    `${th.url}/api/projects/p1/blobs/head?key=x`,
    `${th.url}/blob/p1/m/${h}?exp=1&sig=x`,
    `${th.url}/api/projects/p1/ws`,
    `${th.url}/index.html`,
    `${th.url}/media/not-a-hash`,
    `${th.url}/media/${h}/extra`,
    `https://elsewhere.example/media/${h}`,
  ])
    assert.equal(sw.fetch(url), undefined, url);
  // answered (503 here: no page has sent a session)
  assert.equal((await sw.fetch(`${th.url}/media/${h}`))?.status, 503, "a media URL is answered");
  assert.equal((await sw.fetch(`${th.url}/media/${h}?reload=3`))?.status, 503, "with a reload query too");
});

test("a request from a page the worker doesn't know asks that page for its session, then plays", async () => {
  const sw = worker();
  // the page answers the way media-client does
  sw.page("tab1", (m) => m.type === "carton-session-request" && setImmediate(() => sw.message(session("p1"), "tab1")));
  const { hash, data } = media.a!;
  const res = await sw.fetch(`${th.url}/media/${hash}`, { headers: { range: `bytes=${LEAF_SIZE - 10}-${LEAF_SIZE + 9}` } }, "tab1")!;
  assert.equal(res.status, 206);
  assert.ok(sameBytes(new Uint8Array(await res.arrayBuffer()), data.subarray(LEAF_SIZE - 10, LEAF_SIZE + 10)));
  assert.deepEqual(sw.pages.get("tab1")!.got, [{ type: "carton-session-request" }]);
  assert.ok(sw.claims >= 1, "a session message claims the page (a hard-reloaded page has no controller)");
  const whole = await sw.fetch(`${th.url}/media/${hash}`, {}, "tab1")!;
  assert.ok(sameBytes(new Uint8Array(await whole.arrayBuffer()), data));
  const head = await sw.fetch(`${th.url}/media/${hash}`, { method: "HEAD" }, "tab1")!;
  assert.equal(head.headers.get("content-length"), String(data.length));
  assert.equal(head.headers.get("content-type"), "video/mp4");
});

test("no session in time: 503, so the element can retry", async () => {
  const sw = worker({ sessionWaitMs: 100 });
  sw.page("silent");
  const res = await sw.fetch(`${th.url}/media/${media.b!.hash}`, {}, "silent")!;
  assert.equal(res.status, 503);
});

test("a refreshed token is used for the requests after it", async () => {
  const rec = recordingFetch();
  const sw = worker({ fetch: rec.fetch });
  sw.page("tab");
  sw.message(session("p1"), "tab");
  assert.equal((await sw.fetch(`${th.url}/media/${media.a!.hash}`, { method: "HEAD" }, "tab"))!.status, 200);
  const refreshed = await th.session("p1");
  sw.message(session("p1", refreshed), "tab");
  assert.equal((await sw.fetch(`${th.url}/media/${media.b!.hash}`, { method: "HEAD" }, "tab"))!.status, 200);
  const auth = rec.calls.filter((c) => c.url.pathname.startsWith("/api/")).map((c) => c.headers.get("authorization"));
  assert.equal(auth[0], `Bearer ${tokens.p1}`);
  assert.equal(auth.at(-1), `Bearer ${refreshed}`);
});

test("two pages on two projects each read their own project's media", async () => {
  const sw = worker();
  sw.page("alice");
  sw.page("bob");
  sw.message(session("p1"), "alice");
  sw.message(session("p2"), "bob");
  const c = media.c!;
  const fromBob = await sw.fetch(`${th.url}/media/${c.hash}`, {}, "bob")!;
  assert.ok(sameBytes(new Uint8Array(await fromBob.arrayBuffer()), c.data));
  assert.equal((await sw.fetch(`${th.url}/media/${c.hash}`, {}, "alice"))!.status, 404, "p1 has no such media");
});

test("bytes that went out bad are reported to every page, and the retry is good", async () => {
  const { hash, data } = media.a!;
  const sw = worker({ fetch: corruptingFetch("p1", mediaKey(hash), LEAF_SIZE + 500) });
  const alice = sw.page("alice");
  const other = sw.page("other-tab");
  sw.message(session("p1"), "alice");
  const res = await sw.fetch(`${th.url}/media/${hash}`, {}, "alice")!;
  assert.equal(res.status, 200);
  await assert.rejects(res.arrayBuffer(), "the body errors, so the player stops");
  await new Promise((r) => setImmediate(r));
  for (const page of [alice, other]) assert.deepEqual(page.got, [{ type: "carton-media-bad", hash }], page.id);
  const again = await sw.fetch(`${th.url}/media/${hash}`, {}, "alice")!;
  assert.ok(sameBytes(new Uint8Array(await again.arrayBuffer()), data));
});
