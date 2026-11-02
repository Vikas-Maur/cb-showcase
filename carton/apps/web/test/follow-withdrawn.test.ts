// The watch page's "newer edits" count leaves withdraw rows (H1) out: a withdraw row spends an id the server took back
// and is no version. A host that counts gives `source.versions` in a Published cut's welcome; the fallback follows the
// source's rows and tells the versions among them.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConfirmedChange, sync } from "@carton/core";
import type { Transport, TransportConnection } from "@carton/core/plugins";
import { cardboardAdapter } from "@carton/cardboard";
import { Follower } from "../src/follow.ts";

const row = (seq: number, withdrawn = false): ConfirmedChange & { withdrawn?: boolean } => ({
  id: `r.${seq}`,
  seq,
  hash: "",
  author: withdrawn ? { kind: "system", id: "withdraw" } : { kind: "human", id: "bob" },
  branchId: "main",
  base: { seq: seq - 1, pending: [] },
  ops: [],
  intent: null,
  kinds: null,
  policy: "merge",
  at: 0,
  paths: [],
  reads: [],
  spans: [],
  trackOrder: [],
  ...(withdrawn ? { withdrawn: true } : {}),
});

/** A host that answers every hello with `welcome`. */
function host(welcome: (h: sync.HelloMsg) => sync.ServerMessage): Transport {
  return {
    async connect() {
      let on: ((m: sync.ServerMessage) => void) | null = null;
      const c: TransportConnection = {
        open: true,
        send: (m) => void (m.type === "hello" && queueMicrotask(() => on?.(welcome(m as sync.HelloMsg)))),
        onMessage: (l) => void (on = l as (m: sync.ServerMessage) => void),
        onClose: () => {},
        close: () => {},
      };
      return c;
    },
  };
}
const common = { url: "ws://x", token: async () => "t", schema: cardboardAdapter.schema, schemaVersion: cardboardAdapter.schemaVersion };

test("the fallback follower tells the versions among the source's rows: a withdraw row is none", async () => {
  // published at 1; then an edit, a withdraw row, an edit
  const transport = host((h) => ({ type: "hello", branchId: h.branchId, head: 4, rows: [row(2), row(3, true), row(4)], confirmed: [] }) as sync.WelcomeMsg);
  const got = await new Promise<{ head: number; rows: number; versions: number }>((resolve) => {
    const f = new Follower({ ...common, transport, branchId: "main", have: 1, onUpdate: (s) => (f.stop(), resolve(s)) }).start();
  });
  assert.deepEqual([got.head, got.rows, got.versions], [4, 3, 2]);
  // the watch page's count (watch.ts followSource): rows after the published version less withdraw rows
  assert.equal(got.head - 1 - (got.rows - got.versions), 2);
});

test("a Published cut's welcome passes the host's count of the source's versions through", async () => {
  const source = { branchId: "main", at: 1, head: 3, versions: 1 };
  const transport = host((h) => ({ type: "hello", branchId: h.branchId, head: 0, rows: [], confirmed: [], source }) as sync.WelcomeMsg);
  const got = await new Promise<{ source?: { versions?: number } }>((resolve) => {
    const f = new Follower({ ...common, transport, branchId: "pub", have: 0, onUpdate: (s) => (f.stop(), resolve(s)) }).start();
  });
  assert.deepEqual(got.source, source);
});
