// A read-only follower of one shared cut over the sync protocol (§12): what the watch page needs and nothing more.
// It holds no queue and pushes nothing. `hello` with `have: -1` is the protocol's own fresh-joiner path: the host
// answers with the newest keyframe (checked against its state hash here before it is shown) and the rows after it;
// `have: n` with `noKeyframe` asks for the rows after version n only (counting newer edits needs no document).
// After the last page the host fans new rows out to us as they are confirmed.

import { apply, fork, hashDoc, sync, type ConfirmedChange, type Doc, type Schema } from "@carton/core";
import type { Transport, TransportConnection } from "@carton/core/plugins";

export interface FollowOptions {
  transport: Transport;
  url: string;
  token: () => Promise<string>;
  schema: Schema;
  schemaVersion: number;
  branchId: string;
  /** -1: from nothing (with the document). n ≥ 0: the rows after version n, no document. */
  have: number;
  onUpdate: (s: { head: number; doc: Doc | null; rows: number; source?: { branchId: string; at: number; head: number } }) => void;
  onError?: (why: string) => void;
  /**
   * Ask again every this many ms once caught up (a Published cut never moves, so the host fans nothing out to its
   * watchers: this is how the "newer edits" count of its source stays current). 0: never.
   */
  refreshMs?: number;
}

export class Follower {
  #o: FollowOptions;
  #conn: TransportConnection | null = null;
  #doc: Doc | null = null;
  #seq: number;
  #head = 0;
  #rows = 0;
  #stopped = false;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #again: ReturnType<typeof setInterval> | null = null;
  #source: { branchId: string; at: number; head: number } | undefined;

  constructor(o: FollowOptions) {
    this.#o = o;
    this.#seq = o.have;
  }
  start(): this {
    void this.#connect();
    return this;
  }
  stop(): void {
    this.#stopped = true;
    if (this.#retry) clearTimeout(this.#retry);
    if (this.#again) clearInterval(this.#again);
    this.#conn?.close();
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    try {
      const conn = await this.#o.transport.connect(this.#o.url, { token: await this.#o.token() });
      this.#conn = conn;
      conn.onMessage((m) => this.#onMessage(m));
      conn.onClose(() => {
        this.#conn = null;
        if (!this.#stopped) this.#retry = setTimeout(() => void this.#connect(), 1500);
      });
      this.#hello();
      if (this.#o.refreshMs && !this.#again) this.#again = setInterval(() => this.#hello(), this.#o.refreshMs);
    } catch (e) {
      this.#o.onError?.((e as Error).message);
      this.#retry = setTimeout(() => void this.#connect(), 3000);
    }
  }
  #hello(): void {
    const withDoc = this.#o.have < 0;
    this.#conn?.send({ type: "hello", branchId: this.#o.branchId, have: this.#seq, pending: [], rids: [], schemaVersion: this.#o.schemaVersion, protocol: sync.PROTOCOL, ...(withDoc ? {} : { noKeyframe: true }) });
  }
  #onMessage(m: sync.ServerMessage): void {
    if (m.type === "error") return this.#o.onError?.(m.reason);
    if (m.type !== "hello" && m.type !== "changes") return;
    if (m.branchId !== this.#o.branchId) return;
    if (m.type === "hello") {
      if (m.keyframe) {
        if (hashDoc(m.keyframe.doc, this.#o.schema) !== m.keyframe.stateHash) return this.#o.onError?.("the published version didn't match its hash");
        if (this.#o.have < 0) this.#doc = m.keyframe.doc;
        this.#seq = m.keyframe.seq;
      }
      this.#head = Math.max(this.#head, m.head);
      if (m.source) this.#source = m.source;
      this.#take(m.rows);
      if (m.more) return this.#hello();
    } else {
      this.#take(m.rows);
      this.#head = Math.max(this.#head, this.#seq);
    }
    this.#o.onUpdate({ head: Math.max(this.#head, this.#seq), doc: this.#doc, rows: this.#rows, ...(this.#source ? { source: this.#source } : {}) });
  }
  #take(rows: readonly ConfirmedChange[]): void {
    for (const r of rows) {
      if (r.seq !== this.#seq + 1) continue; // a row we already have, or a gap the next hello fills
      if (this.#doc) this.#doc = apply(fork(this.#doc, this.#o.schema), r.ops, this.#o.schema);
      this.#seq = r.seq;
      this.#rows++;
    }
  }
}
