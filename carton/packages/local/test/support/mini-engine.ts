// A stand-in HolderEngine for the process tests, until core's Carton and sync client land. It keeps the parts of the
// real pipeline the lease is about, with the same rules:
//   - the pending queue lives in carton.db (`pending` [id]); a commit with a known id never makes a second change;
//   - only the lease holder pushes; every push is dequeued after re-reading the lease nonce, and a holder whose nonce
//     changed stops for good (R5-06); every queue write is fenced on the nonce;
//   - hello carries our pending ids, and the server's confirmed list drops those it already has (R10-01);
//   - a commit on the shared cut waits up to 5 s for the server's ack (L14).
// Events go to `events.jsonl` next to carton.db, so tests can check who pushed what and when.
import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fence } from "../../src/lease.ts";
import type { HolderEngine } from "../../src/holder.ts";
import type { Store } from "@carton/core/plugins";

export interface MiniConfig {
  port: number;
  /** Fault injection: block the engine thread this long right after the push of a change carrying `marker`. */
  stallAfterPushMs?: number;
  /** Fault injection: block the engine thread this long right after a change carrying `marker` is queued. */
  stallAfterQueueMs?: number;
  /** Fault injection: SIGKILL ourselves right after writing the push of a change carrying `marker`. */
  dieAfterPush?: boolean;
  /** Fault injection: SIGKILL ourselves right after a change carrying `marker` is queued, before its push. */
  dieAfterQueue?: boolean;
  marker?: string;
  /** Turn fencing off (the R5-06 control). */
  fence?: boolean;
  waitMs?: number;
}

interface Pending { id: string; author: unknown; ops: unknown[]; created: number }
type Outcome = { status: "confirmed"; seq: number } | { status: "pending" };

const block = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class MiniEngine implements HolderEngine {
  private store: Store;
  private cfg: MiniConfig;
  private nonce: string | null = null;
  private sock: Socket | null = null;
  private caughtUp = false;
  private sent = new Set<string>();
  private waiters = new Map<string, ((o: Outcome) => void)[]>();
  private quiescing = false;
  stopped: string | null = null;
  private onFenced: (() => void) | null = null;
  private eventsFile: string;

  constructor(store: Store, dbPath: string, cfg: MiniConfig) {
    this.store = store;
    this.cfg = cfg;
    this.eventsFile = join(dirname(dbPath), "events.jsonl");
  }

  event(e: Record<string, unknown>): void {
    appendFileSync(this.eventsFile, JSON.stringify({ t: Date.now(), pid: process.pid, nonce: this.nonce, ...e }) + "\n");
  }

  startSync(nonce: string, onFenced: () => void): void {
    // a worker that was fenced takes the lease back later and starts again under its new nonce
    this.stopped = null;
    this.quiescing = false;
    this.nonce = nonce;
    this.onFenced = onFenced;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const s = createConnection(this.cfg.port, "127.0.0.1");
    s.setEncoding("utf8");
    s.setNoDelay(true);
    this.sock = s;
    let buf = "";
    s.on("connect", async () => {
      const have = (await this.store.range("log")).length;
      const pending = (await this.pendingList()).map((p) => p.id);
      s.write(JSON.stringify({ type: "hello", pid: process.pid, have, pending }) + "\n");
    });
    s.on("data", (d: string) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) void this.onMessage(JSON.parse(line));
      }
    });
    s.on("error", () => {});
    s.on("close", () => {
      if (this.sock === s) { this.sock = null; this.caughtUp = false; this.sent.clear(); }
      if (!this.stopped) setTimeout(() => this.connect(), 200).unref();
    });
  }

  private async pendingList(): Promise<Pending[]> {
    return (await this.store.range<Pending>("pending")).map((x) => x.value).sort((a, b) => a.created - b.created);
  }

  /** Re-read the lease nonce before touching the queue; stop for good if it moved (R5-06). */
  private async fenced(): Promise<boolean> {
    if (this.stopped) return false;
    if (this.cfg.fence === false) return true;
    const cur = await this.store.get<string>("lease", ["sync", "nonce"]);
    if (cur !== this.nonce) { this.stop("fenced: lease nonce changed"); this.onFenced?.(); return false; }
    return true;
  }

  private cond() { return this.cfg.fence === false || !this.nonce ? [] : [fence(this.nonce)]; }

  private async onMessage(m: any): Promise<void> {
    if (this.stopped) return;
    if (m.type === "hello") {
      for (const c of m.confirmed ?? []) await this.confirm(c.id, c.seq, "listed");
      for (const r of m.rows ?? []) await this.integrate(r);
      this.caughtUp = true;
      await this.pump();
    } else if (m.type === "ack") {
      await this.confirm(m.id, m.seq, m.duplicate ? "duplicate" : "ack");
    } else if (m.type === "changes") {
      for (const r of m.rows) await this.integrate(r);
    }
  }

  private async integrate(r: { seq: number; id: string }): Promise<void> {
    if (await this.store.get("ids", [r.id])) return;
    await this.store.write([{ table: "log", key: [r.seq], value: r }, { table: "ids", key: [r.id], value: r.seq }, { table: "pending", key: [r.id], value: undefined }], this.cond());
    this.settle(r.id, { status: "confirmed", seq: r.seq });
  }

  private async confirm(id: string, seq: number, how: string): Promise<void> {
    if (!(await this.fenced())) return;
    if (!(await this.store.get("ids", [id]))) {
      const ok = await this.store.write([{ table: "log", key: [seq], value: { seq, id } }, { table: "ids", key: [id], value: seq }, { table: "pending", key: [id], value: undefined }], this.cond());
      if (!ok) { this.stop("fenced: lease nonce changed"); this.onFenced?.(); return; }
    }
    this.event({ type: "confirmed", id, seq, how });
    this.settle(id, { status: "confirmed", seq });
  }

  private settle(id: string, o: Outcome): void {
    for (const w of this.waiters.get(id) ?? []) w(o);
    this.waiters.delete(id);
  }

  /** Fenced dequeue: push every pending change not yet sent on this connection, in queue order. */
  async pump(): Promise<void> {
    if (!this.sock || !this.caughtUp || this.quiescing || this.stopped) return;
    if (!(await this.fenced())) return;
    const out = (await this.pendingList()).filter((p) => !this.sent.has(p.id));
    if (!out.length || !this.sock) return;
    for (const p of out) this.sent.add(p.id);
    this.sock.write(JSON.stringify({ type: "push", epoch: 1, changes: out }) + "\n");
    this.event({ type: "push", ids: out.map((p) => p.id) });
    const marked = this.cfg.marker && out.some((p) => JSON.stringify(p.ops).includes(this.cfg.marker!));
    if (marked && this.cfg.dieAfterPush) { this.event({ type: "dying" }); process.kill(process.pid, "SIGKILL"); }
    if (marked && this.cfg.stallAfterPushMs) { this.event({ type: "stall", ms: this.cfg.stallAfterPushMs }); block(this.cfg.stallAfterPushMs); this.event({ type: "woke" }); }
  }

  private waitFor(id: string, ms: number): Promise<Outcome> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ status: "pending" }), ms);
      const list = this.waiters.get(id) ?? [];
      list.push((o) => { clearTimeout(t); resolve(o); });
      this.waiters.set(id, list);
    });
  }

  async serve(req: any): Promise<unknown> {
    if (req.op?.kind === "status") return { status: "ok", pending: (await this.pendingList()).length, nonce: this.nonce, pid: process.pid };
    const id: string = req.id;
    const known = await this.store.get<number>("ids", [id]);
    if (known) return { status: "confirmed", id, seq: known, again: true };
    const waitMs = req.waitMs ?? this.cfg.waitMs ?? 5000;
    if (!(await this.store.get("pending", [id]))) {
      const p: Pending = { id, author: req.actor, ops: req.op.ops, created: Date.now() };
      // a replaced holder can't add to the queue: the write is fenced on our nonce
      if (!(await this.store.write([{ table: "pending", key: [id], value: p }], this.cond()))) {
        this.stop("fenced: lease nonce changed");
        this.onFenced?.();
        throw Object.assign(new Error("holder replaced"), { code: -32003 });
      }
      this.event({ type: "queued", id });
      if (this.cfg.marker && this.cfg.dieAfterQueue && JSON.stringify(p.ops).includes(this.cfg.marker)) { this.event({ type: "dying" }); process.kill(process.pid, "SIGKILL"); }
      if (this.cfg.marker && this.cfg.stallAfterQueueMs && JSON.stringify(p.ops).includes(this.cfg.marker)) {
        this.event({ type: "stall", ms: this.cfg.stallAfterQueueMs });
        block(this.cfg.stallAfterQueueMs);
        this.event({ type: "woke" });
      }
    } else this.event({ type: "known-pending", id });
    const outcome = this.waitFor(id, waitMs);
    void this.pump();
    const o = await outcome;
    return o.status === "confirmed" ? { status: "confirmed", id, seq: o.seq } : { status: "pending", id, online: this.caughtUp };
  }

  async quiesce(): Promise<void> {
    this.quiescing = true;
    const end = Date.now() + 5000;
    while (Date.now() < end && this.sock && !this.stopped) {
      const pend = await this.pendingList();
      if (!pend.some((p) => this.sent.has(p.id))) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    this.event({ type: "quiesced" });
  }

  stop(why: string): void {
    if (this.stopped) return;
    this.stopped = why;
    this.event({ type: "stop", why });
    this.sock?.destroy();
    this.sock = null;
  }
}
