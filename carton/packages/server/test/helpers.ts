// Test helpers for @carton/server: node:sqlite as the SequencerStorage, an in-memory BlobStore, stand-in connections
// that record what the sequencer sends, and a push helper that declares changes the way the engine does.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AuthContext, BlobInfo, BlobStore, SequencerStorage, SqlValue } from "@carton/core/plugins";
import type { Change, Op, sync } from "@carton/core";
import { createSequencer, type HostConnection, type Sequencer, type SequencerOptions } from "../src/index.ts";
import { declare, clip, doc, set, ins, rm, type Doc } from "../../core/test/sequencer/fixtures.ts";

export { declare, clip, doc, set, ins, rm, type Doc };

/** node:sqlite behind the SequencerStorage contract, with statements cached and rows counted. */
export function sqliteStorage(path = ":memory:"): SequencerStorage & { db: DatabaseSync } {
  const db = new DatabaseSync(path);
  const stmts = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  let read = 0, written = 0, depth = 0;
  return {
    db,
    exec<R>(sql: string, ...params: SqlValue[]): R[] {
      let st = stmts.get(sql);
      if (!st) stmts.set(sql, (st = db.prepare(sql)));
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) {
        const r = st.run(...(params as SQLInputValue[]));
        written += Number(r.changes);
        return [];
      }
      if (/^\s*CREATE/i.test(sql)) {
        st.run();
        return [];
      }
      const rows = st.all(...(params as SQLInputValue[])) as R[];
      read += rows.length;
      return rows;
    },
    transaction<T>(fn: () => T): T {
      if (depth++ > 0) {
        try {
          return fn();
        } finally {
          depth--;
        }
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const v = fn();
        db.exec("COMMIT");
        return v;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
    stats: () => ({ rowsRead: read, rowsWritten: written }),
  };
}

/** A Map-backed BlobStore with the calls the sequencer uses; counts gets. */
export function memoryBlobs(): BlobStore & { map: Map<string, Uint8Array>; gets: number } {
  const map = new Map<string, Uint8Array>();
  const info = (key: string, d: Uint8Array): BlobInfo => ({ key, size: d.length });
  const store = {
    kind: "test-memory",
    map,
    gets: 0,
    async put(key: string, data: Uint8Array, o?: { ifAbsent?: boolean }) {
      if (o?.ifAbsent && map.has(key)) return info(key, map.get(key)!);
      map.set(key, data.slice());
      return info(key, data);
    },
    async get(key: string) {
      store.gets++;
      return map.get(key)?.slice() ?? null;
    },
    async head(key: string) {
      const d = map.get(key);
      return d ? info(key, d) : null;
    },
    async delete(key: string) {
      map.delete(key);
    },
    async list(prefix: string) {
      return { blobs: [...map].filter(([k]) => k.startsWith(prefix)).map(([k, d]) => info(k, d)) };
    },
    async createMultipart(): Promise<never> {
      throw new Error("not used");
    },
    async resumeMultipart(): Promise<never> {
      throw new Error("not used");
    },
  };
  return store;
}

export const staticAuth = { kind: "static", async verify() { return null; } };

let CONN = 0;
export interface FakeConn extends HostConnection {
  inbox: sync.ServerMessage[];
  last<T extends sync.ServerMessage["type"]>(type: T): Extract<sync.ServerMessage, { type: T }> | undefined;
}
/** A stand-in connection: the sequencer talks to it as to a client socket. */
export function fakeConn(credential: string, role: AuthContext["role"] = "editor", extra: Partial<AuthContext> = {}): FakeConn {
  const c: FakeConn = {
    id: `c${++CONN}`,
    auth: { account: credential.split("/")[0]!, credential, role, projectId: "p", expires: Number.MAX_SAFE_INTEGER, ...extra },
    inbox: [],
    send(m) {
      c.inbox.push(structuredClone(m));
    },
    last(type) {
      for (let i = c.inbox.length - 1; i >= 0; i--) if (c.inbox[i]!.type === type) return c.inbox[i] as never;
      return undefined;
    },
  };
  return c;
}

export const BRANCH = "main-0000-0000";

/** A sequencer on fresh sqlite storage with a shared branch whose state at 0 is `d0`. */
export async function world(d0: Doc, o: Partial<SequencerOptions> = {}) {
  const storage = o.storage ?? sqliteStorage();
  const seq = createSequencer({ storage, auth: staticAuth, ...o });
  await seq.createBranch({ id: BRANCH, name: "main", forkOf: null, owner: "alice", kind: "main", sequencer: { kind: "server", since: 0 } }, { doc0: d0 as never, stateHash: "h0" });
  return { seq, storage, d0 };
}

let N = 0;
/** Build a change as a replica would (declared against `before`) and push it alone; returns the answer. */
export async function push(
  seq: Sequencer,
  conn: FakeConn,
  before: Doc,
  ops: Op[],
  o: { branch?: string; base?: { seq: number; pending: string[] }; spans?: Change["spans"]; id?: string; policy?: Change["policy"]; intent?: Change["intent"]; epoch?: number } = {},
): Promise<sync.AckMsg | sync.RejectMsg> {
  const branch = o.branch ?? BRANCH;
  if (!conn.auth || !(conn.state?.subs ?? []).includes(branch)) await seq.handle(conn, { type: "hello", branchId: branch, have: seq.tables.head(branch), pending: [], rids: [], schemaVersion: 1 });
  const d = declare(before, ops, (o.intent as never) ?? null);
  const ch: Change = {
    id: o.id ?? `${conn.auth.credential.replaceAll("/", "")}.${++N}`,
    hash: "h",
    author: { kind: "human", id: conn.auth.account },
    branchId: branch,
    base: o.base ?? { seq: seq.tables.head(branch), pending: [] },
    ops,
    intent: o.intent ?? null,
    kinds: null,
    policy: o.policy ?? "merge",
    at: 0,
    ...d,
    ...(o.spans ? { spans: o.spans } : {}),
  };
  conn.inbox.length = 0;
  await seq.handle(conn, { type: "push", branchId: branch, epoch: o.epoch ?? ++N, changes: [ch] });
  const r = conn.inbox.find((m) => m.type === "ack" || m.type === "reject");
  if (!r) throw new Error(`no answer: ${JSON.stringify(conn.inbox)}`);
  return r as sync.AckMsg | sync.RejectMsg;
}
export const verdict = (r: sync.AckMsg | sync.RejectMsg) => (r.type === "ack" ? (r.withdrawn ? "withdrawn" : r.duplicate ? "duplicate" : "ack") : r.reason);
