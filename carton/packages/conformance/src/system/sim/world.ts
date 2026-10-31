// A simulated world (port of system-v11 `world.mjs`): one real sequencer (`createSequencer` from `@carton/server`, on a
// SequencerStorage the caller provides), a network, replicas, and the documents they start from. `w.server` is a thin
// facade with what the prototype's tests read off its in-memory server: rows, stats, rid bindings, hooks.

import type { SequencerStorage, SqlValue } from "@carton/core/plugins";
import type { CutRecord, Doc, sequencer as rules } from "@carton/core";
import { createSequencer, type Row, type Sequencer, type SequencerControls, type SequencerEvent } from "@carton/server";
import * as A from "./adapter.ts";
import { Ipc, Sim } from "./kernel.ts";
import { Net, type ServerSide, type SimConn } from "./net.ts";
import { Replica } from "./replica.ts";

export interface ServerOptions extends SequencerControls {
  maxBehind?: number;
  keyframeEvery?: number;
}
export interface WorldOptions {
  seed?: number;
  keying?: rules.Keying;
  server?: ServerOptions;
  /** The sequencer's storage (node:sqlite in Node; a host's own storage in its conformance run). */
  storage: () => SequencerStorage;
}

/** The prototype's server, as its tests saw it, over the real sequencer. */
export class SimServer implements ServerSide {
  readonly seq: Sequencer;
  readonly hooks: ServerSide["hooks"] = { beforeSend: null };
  readonly conns = new Set<SimConn>();
  /** Rejects per change id (P9: max rejects of one change). */
  readonly rejectsById = new Map<string, number>();
  private readonly doc0s = new Map<string, Doc>();
  private readonly net = { lostAcks: 0 };
  private rowCache = new Map<string, { head: number; rows: Row[] }>();
  readonly opts: ServerOptions;

  constructor(storage: SequencerStorage, opts: ServerOptions & { keying?: rules.Keying }, clock: () => number) {
    this.opts = opts;
    const { maxBehind, keyframeEvery, keying, ...controls } = opts;
    this.seq = createSequencer({
      storage,
      auth: { kind: "sim", async verify() { return null; } },
      ...(maxBehind !== undefined ? { maxBehind } : {}),
      ...(keyframeEvery !== undefined ? { keyframeEvery } : {}),
      clock,
      controls: { ...controls, ...(keying ? { keying } : {}) },
      onEvent: (e: SequencerEvent) => {
        if (e.type === "reject" && e.id) this.rejectsById.set(e.id, (this.rejectsById.get(e.id) ?? 0) + 1);
      },
    });
  }
  /** The sequencer's counters plus the network's lost acks. */
  get stats() {
    const s = this.seq.stats, net = this.net;
    return {
      pushes: s.pushes,
      accepts: s.accepts,
      rejects: s.rejects,
      rejectReasons: s.rejectReasons as Record<string, number>,
      duplicates: s.duplicates,
      withdraws: s.withdraws,
      lww: s.lww,
      adopts: s.adopts,
      adoptRepeats: s.adoptRepeats,
      ridClaimConflicts: s.ridClaimConflicts,
      keyframes: s.keyframes,
      rowsRead: s.rowsRead,
      rowsWritten: s.rowsWritten,
      get lostAcks() {
        return net.lostAcks;
      },
      set lostAcks(v: number) {
        net.lostAcks = v;
      },
    };
  }
  attach(conn: SimConn): void {
    this.conns.add(conn);
    this.seq.attach(conn.server);
  }
  detach(conn: SimConn): void {
    this.conns.delete(conn);
    this.seq.disconnect(conn.server);
  }
  receive(conn: SimConn, msg: Parameters<ServerSide["receive"]>[1]): void {
    void this.seq.handle(conn.server, msg);
  }
  createBranch(id: string, rec: { id: string; name: string; kind: string }, rows: Row[] = [], doc0: Doc | null = null): void {
    if (rows.length) throw new Error("SimServer.createBranch: adopt rows through the protocol");
    this.doc0s.set(id, doc0 as Doc);
    void this.seq.createBranch(cut(rec), { doc0, stateHash: doc0 ? A.hashDoc(doc0) : "" });
  }
  /** A server-side fork (a shared variant): O(1), no rows copied; existence falls back to the parent (§6.3). */
  forkBranch(id: string, rec: { id: string; name: string; kind: string }, from: string, seq: number): void {
    void this.seq.createBranch(cut(rec), { doc0: null, forkOf: { branchId: from, seq } });
  }
  exists(b: string, key: string): boolean | undefined {
    const i = key.indexOf("/");
    return this.seq.tables.record(b, key.slice(0, i), key.slice(i + 1))?.alive;
  }
  /** Every confirmed row of a branch (cached by head). */
  rows(b: string): Row[] {
    const head = this.seq.tables.head(b);
    const c = this.rowCache.get(b);
    if (c && c.head === head) return c.rows;
    const rows = this.seq.tables.rows(b, 0, 1e9).map((r) => r.row);
    this.rowCache.set(b, { head, rows });
    return rows;
  }
  /** The prototype's `branches.get(b)`: rows, the state at 0, and the stored branch record. */
  readonly branches = {
    get: (b: string) => {
      const sb = this.seq.tables.branch(b);
      if (!sb) return undefined;
      const self = this;
      return {
        get rows() {
          return self.rows(b);
        },
        // an adopted branch's state at its root is the keyframe the sequencer stored from the upload (§5.3)
        doc0: this.doc0s.get(b) ?? rootState(this.seq, b, sb.root),
        rec: sb.rec,
        tracking: !!sb.tracking,
        nodes: sb.nodes ?? [],
        adoptKey: sb.adoptKey,
        since: sb.since,
      };
    },
  };
  /** Replica id → the credential it is bound to. */
  get rids(): Map<string, string> {
    const rows = this.seq.tables.sql.exec<{ rid: SqlValue; credential: SqlValue }>("SELECT rid, credential FROM rids");
    return new Map(rows.map((r) => [String(r.rid), String(r.credential)]));
  }
}
function rootState(seq: Sequencer, b: string, root: number): Doc | null {
  const k = seq.tables.keyframeAt(b, root);
  return k?.doc ? (JSON.parse(k.doc) as Doc) : null;
}
const cut = (rec: { id: string; name: string; kind: string }): CutRecord => ({ id: rec.id, name: rec.name, forkOf: null, owner: "sim", kind: rec.kind as "main", sequencer: { kind: "server", since: 0 } });

export class World {
  readonly sim: Sim;
  readonly ipc: Ipc;
  readonly server: SimServer;
  readonly net: Net;
  readonly replicas: Replica[] = [];
  readonly maxBehind: number;
  constructor({ seed = 1, keying = "v3-spans", server = {}, storage }: WorldOptions) {
    this.sim = new Sim(seed);
    this.ipc = new Ipc(this.sim);
    this.maxBehind = server.maxBehind ?? 100;
    this.server = new SimServer(storage(), { keying, ...server }, () => this.sim.now);
    this.net = new Net(this.sim, this.server);
  }
  uuid(): string {
    const h = this.sim.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  replica(opts: ConstructorParameters<typeof Replica>[1]): Replica {
    const r = new Replica(this, opts);
    this.replicas.push(r);
    return r;
  }
  /** A branch already shared (sequenced by the server since seq 0), held by every listed replica. */
  shared(doc0: Record<string, unknown>, replicas: Replica[], { name = "main" }: { name?: string } = {}): string {
    const d = A.normalize(doc0);
    const id = this.uuid();
    this.server.createBranch(id, { id, name, kind: "main" }, [], d);
    for (const r of replicas) {
      r.branchId = id;
      r.store.addBranch({ id, name, kind: "main", sequencer: { kind: "server", since: 0 } }, d);
    }
    return id;
  }
  /** A branch only this replica sequences (not shared yet). */
  local(doc0: Record<string, unknown>, r: Replica, { name = "main" }: { name?: string } = {}): string {
    const d = A.normalize(doc0);
    const id = this.uuid();
    r.branchId = id;
    r.store.addBranch({ id, name, kind: "main", sequencer: { kind: "local" } }, d);
    return id;
  }
}

export function doc({ tracks = ["V1"], items = [] }: { tracks?: string[]; items?: A.Item[] } = {}): Record<string, unknown> {
  return { name: "Demo", aspectRatio: "16:9", tracks: tracks.map((id, i) => ({ id, name: id, order: i, visible: true })), timelineItems: items };
}
export const clip = (id: string, s: number, e: number, { track = "V1", type = "video", ...rest }: Record<string, unknown> = {}): A.Item => ({ id, trackId: track, type, name: id, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, opacity: 1, ...rest });
export const clips = (n: number, { len = 5, track = "V1", prefix = "c" }: { len?: number; track?: string; prefix?: string } = {}): A.Item[] =>
  Array.from({ length: n }, (_, i) => clip(`${prefix}${i}`, i * len, (i + 1) * len, { track }));
export const item = A.item;
export const set = (id: string, field: string, value: unknown) => ({ op: "set" as const, path: [A.ITEMS, id, field], value });
