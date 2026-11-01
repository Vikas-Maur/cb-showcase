// Test helpers: Cardboard documents and Cartons, a comment host over a test Transport, and tokens.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Carton, type Doc, type Rec } from "@carton/core";
import type { AuthContext, Role, Transport, TransportConnection } from "@carton/core/plugins";
import { cardboardAdapter, cardboardSchema, fromHost, toHost } from "@carton/cardboard";
import { createMemoryStore } from "@carton/store-memory";
import { nodeSqliteStorage } from "@carton/server-node";
import { createCommentRoom, type CommentPeer, type CommentRoom } from "../src/server.ts";
import type { CommentClientMessage, CommentServerMessage } from "../src/types.ts";

export const S = cardboardSchema;
export const ME = { id: "alice", name: "Alice Chen" };
export const BOB = { id: "bob", name: "Bob Okafor" };

export const clip = (id: string, s: number, e: number, track = "V1", extra: Rec = {}): Rec => ({ id, trackId: track, type: "video", name: id, mediaItemId: `m-${id}`, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, ...extra });
export const tracks = [
  { id: "V1", name: "V1", order: 0 },
  { id: "V2", name: "V2", order: 1 },
];
export const doc = (items: Rec[]): Doc => fromHost({ name: "P", tracks, timelineItems: items }, null);
/** The document with some items' fields changed, others removed (`null`) or added. */
export const edit = (d: Doc, patch: Record<string, Rec | null>, add: Rec[] = []): Doc => {
  const h = toHost(d);
  const items = h.timelineItems!.filter((i) => patch[i.id as string] !== null).map((i) => (patch[i.id as string] ? { ...i, ...patch[i.id as string] } : i));
  return fromHost({ ...h, timelineItems: [...items, ...add] }, d);
};

export async function openCarton(items: Rec[], store = createMemoryStore()) {
  return Carton.open({ adapter: cardboardAdapter, store, init: { doc: doc(items) }, actor: { kind: "human", id: "person", name: "Alice" } });
}

/** Commit `next(head)` on the current cut, with an optional intent (a split's lineage). */
export async function commitDoc(c: Carton, next: (d: Doc) => Doc, intent?: { kind?: string; lineage?: Record<string, string[]> }) {
  const { doc: d } = await c.head();
  const r = await c.commit({ doc: next(d), ...(intent ? { intent } : {}) });
  if (r.status !== "confirmed") throw new Error(`commit ${r.status}`);
  return r;
}

export function auth(role: Role, account: string, branches?: string[]): AuthContext {
  return { account, credential: `${account}/dev`, role, projectId: "p", expires: Date.now() + 3600_000, ...(branches ? { branches } : {}) };
}

/**
 * A comment host for tests: the comment room over node:sqlite (`:memory:`), behind a Transport that delivers JSON
 * copies in order on the microtask queue, as the in-process host does. A token is a JSON AuthContext (tests only).
 * `drop()` breaks every connection; messages other than comments get the sequencer's answer to an unknown type when
 * `legacy` is set (a host from before comments).
 */
export function commentHost(opts: { legacy?: boolean; limits?: Parameters<typeof createCommentRoom>[0]["limits"]; clock?: () => number } = {}) {
  const storage = nodeSqliteStorage(":memory:");
  const room: CommentRoom = createCommentRoom({ storage, ...(opts.limits ? { limits: opts.limits } : {}), ...(opts.clock ? { clock: opts.clock } : {}) });
  type Peer = CommentPeer & { subscribed: boolean; close(why: string): void };
  const peers = new Set<Peer>();
  const copy = <T>(m: T): T => JSON.parse(JSON.stringify(m)) as T;
  let refusals = 0;
  const transport: Transport = {
    async connect(_url, { token }) {
      const a = JSON.parse(token) as AuthContext;
      const listeners: ((m: unknown) => void)[] = [];
      const closers: ((why: string) => void)[] = [];
      let open = true;
      const peer: Peer = {
        auth: a,
        subscribed: false,
        send(m: CommentServerMessage) {
          if (!open) return;
          const c = copy(m);
          queueMicrotask(() => open && listeners.forEach((l) => l(c)));
        },
        close(why) {
          if (!open) return;
          open = false;
          peers.delete(peer);
          room.forget(peer);
          queueMicrotask(() => closers.forEach((f) => f(why)));
        },
      };
      peers.add(peer);
      const conn: TransportConnection = {
        get open() {
          return open;
        },
        send(msg) {
          if (!open) return;
          const m = copy(msg) as unknown as CommentClientMessage;
          queueMicrotask(() => {
            if (!open) return;
            if (opts.legacy) return peer.send({ type: "error", reason: `unknown message type ${m.type}` } as never);
            if (m.type === "comments") {
              peer.subscribed = true;
              room.onComments(peer, m);
            } else if (m.type === "comment") {
              room.onComment(peer, m, [...peers].filter((p) => p.subscribed));
            }
          });
        },
        onMessage(l) {
          listeners.push(l as (m: unknown) => void);
        },
        onClose(f) {
          closers.push(f);
        },
        close() {
          peer.close("closed by client");
        },
      };
      return conn;
    },
  };
  return {
    transport,
    url: "inproc://comments",
    room,
    storage,
    token: (role: Role, account: string, branches?: string[]) => JSON.stringify(auth(role, account, branches)),
    drop() {
      for (const p of [...peers]) p.close("dropped");
    },
    get connections() {
      return peers.size;
    },
    get refusals() {
      return refusals;
    },
  };
}

/** Wait until `f()` is true (polling every 5 ms), or fail after `ms`. */
export async function until(f: () => boolean | Promise<boolean>, ms = 3000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A fresh folder for one test (CARTON_SCRATCH moves test files off a small /tmp). */
export function scratch(name: string): string {
  const base = process.env.CARTON_SCRATCH || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `carton-comments-${name}-`));
}
