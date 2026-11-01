// Sharing comments through the project's host (a plug-in, PLAN §3.1): the same Transport, URL and token as the
// project's sync (`Carton.open`'s `sync`), on a connection of its own, so comments need nothing from the document sync
// and never slow it down. The protocol (types.ts):
// - `comments {since}` subscribes this connection to the project's comment stream and answers the rows after
//   `since`, a page at a time (`more` until caught up, `head` the position to ask from next);
// - `comment {n, id, patch}` sends one comment's pending patch; the answer (`commentAnswer`, matched by `n`) carries
//   the row as stored, or why not. One patch per comment is in flight at a time; a comment edited while its patch was
//   on its way is sent again after the answer;
// - others' patches arrive as `comments` rows (fan-out), in the server's order.
// The read position advances only past rows this connection has certainly seen and stored: page by page while catching
// up, then with each fan-out and answer (the server sends them in its order). A message that can't be stored ends the
// connection, and the next one asks again from the last position stored, so a failed write never leaves a gap.
// Reconnects back off from 0.5 s to 30 s.

import type { Transport, TransportConnection } from "@carton/core/plugins";
import type { sync } from "@carton/core";
import type { Comment, CommentClientMessage, CommentRefusal, CommentServerMessage, PendingPatch } from "./types.ts";

export interface CommentSyncOptions {
  transport: Transport;
  /** The project's host URL (`ws(s)://…/api/projects/<id>/ws`, or `inproc://…`). */
  url: string;
  token: string | (() => Promise<string>);
}

export type CommentSyncState =
  /** Not connected (yet, or between retries). */
  | "offline"
  | "connecting"
  | "catching-up"
  | "up-to-date"
  /** The host doesn't carry comments (an older server): comments stay on this machine. */
  | "unsupported"
  | "stopped";

export interface CommentSyncStatus {
  state: CommentSyncState;
  /** The last problem, for a status line ("token expired", "can't reach the host"). */
  error?: string;
}

/** What the client asks of the comments it syncs (the `Comments` handle). */
export interface CommentSyncEngine {
  /** The cut to name in messages: a watch-link session must name its Published cut. */
  cut(): string;
  /** The stream position read so far. */
  head(): number;
  /** Pending rows, read fresh (another process may have added some). */
  pending(): Promise<PendingPatch[]>;
  /**
   * Rows from the server; `head`: the read position to keep, when it may advance; `reset`: see CommentsRowsMsg.
   * `current()`: is the connection that brought them still this sync's? (Checked when they are about to be written:
   * after a restart, a message that was waiting is another connection's and is dropped.)
   */
  take(rows: readonly Comment[], head: number | null, reset: boolean, current: () => boolean): Promise<void>;
  /** The server stored `sent` as `row`. */
  answered(sent: PendingPatch, row: Comment, head: number | null, current: () => boolean): Promise<void>;
  /** The server refused `sent` for good. */
  refused(sent: PendingPatch, refusal: CommentRefusal, reason: string, current: () => boolean): Promise<void>;
  status(s: CommentSyncStatus): void;
}

const MAX_IN_FLIGHT = 8;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 30_000;

export class CommentSync {
  readonly #opts: CommentSyncOptions;
  readonly #engine: CommentSyncEngine;
  #conn: TransportConnection | null = null;
  #abort: AbortController | null = null;
  #status: CommentSyncStatus = { state: "offline" };
  #stopped = true;
  #backoff = BACKOFF_MIN;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #rateTimer: ReturnType<typeof setTimeout> | null = null;
  #rateUntil = 0;
  #readTimer: ReturnType<typeof setTimeout> | null = null;
  /** n -> the row as sent. */
  readonly #inflight = new Map<number, PendingPatch>();
  readonly #inflightIds = new Set<string>();
  #n = 0;
  #caughtUp = false;
  /** Messages are handled one at a time, in arrival order. */
  #chain: Promise<void> = Promise.resolve();
  #pumping = false;
  #again = false;
  #idle: (() => void)[] = [];

  constructor(opts: CommentSyncOptions, engine: CommentSyncEngine) {
    this.#opts = opts;
    this.#engine = engine;
  }

  get status(): CommentSyncStatus {
    return this.#status;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#backoff = BACKOFF_MIN;
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#rateTimer) clearTimeout(this.#rateTimer);
    if (this.#readTimer) clearTimeout(this.#readTimer);
    this.#timer = this.#rateTimer = this.#readTimer = null;
    this.#abort?.abort();
    const c = this.#conn;
    this.#conn = null;
    c?.close();
    await this.#chain.catch(() => {});
    this.#set({ state: "stopped" });
  }

  /**
   * Drop the connection and connect again, asking from the engine's position (another process reset the stream
   * this engine reads: what the old connection would still send belongs before it).
   */
  restart(why = "the comment stream was reset here"): void {
    const c = this.#conn;
    if (this.#stopped || this.#status.state === "unsupported") return;
    this.#conn = null;
    this.#inflight.clear();
    this.#inflightIds.clear();
    this.#caughtUp = false;
    this.#abort?.abort();
    c?.close();
    this.#backoff = BACKOFF_MIN;
    this.#retry(why);
  }

  /** Something was added to the pending rows: send it. */
  kick(): void {
    void this.#pump();
  }

  /** Resolves once caught up with nothing in flight and nothing pending (tests, and a host that wants to wait). */
  async settled(timeoutMs = 10_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (this.#caughtUp && this.#inflight.size === 0 && (await this.#engine.pending()).length === 0) return true;
      if (Date.now() >= end || this.#stopped) return false;
      await new Promise<void>((r) => {
        this.#idle.push(r);
        setTimeout(r, Math.min(100, Math.max(1, end - Date.now())));
      });
    }
  }

  #set(s: CommentSyncStatus): void {
    if (s.state === this.#status.state && s.error === this.#status.error) return;
    this.#status = s;
    this.#engine.status(s);
  }

  #wake(): void {
    const w = this.#idle;
    this.#idle = [];
    for (const r of w) r();
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    this.#set({ state: "connecting", ...(this.#status.error ? { error: this.#status.error } : {}) });
    const abort = (this.#abort = new AbortController());
    let conn: TransportConnection;
    try {
      const token = typeof this.#opts.token === "function" ? await this.#opts.token() : this.#opts.token;
      conn = await this.#opts.transport.connect(this.#opts.url, { token, signal: abort.signal });
    } catch (e) {
      if (this.#stopped) return;
      this.#retry(e instanceof Error ? e.message : String(e));
      return;
    }
    if (this.#stopped || abort.signal.aborted) {
      conn.close();
      return;
    }
    this.#conn = conn;
    this.#caughtUp = false;
    this.#inflight.clear();
    this.#inflightIds.clear();
    conn.onMessage((m) => {
      if (this.#conn !== conn) return;
      this.#chain = this.#chain.then(async () => {
        // a message queued behind one that failed belongs to a connection already given up
        if (this.#conn !== conn) return;
        try {
          await this.#onMessage(conn, m as unknown as CommentServerMessage | { type: "error"; reason?: string; code?: string });
        } catch (e) {
          this.#fail(conn, `couldn't keep comments here: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    });
    conn.onClose((why) => {
      if (this.#conn !== conn) return;
      this.#conn = null;
      this.#inflight.clear();
      this.#inflightIds.clear();
      this.#caughtUp = false;
      if (!this.#stopped && this.#status.state !== "unsupported") this.#retry(why || "connection closed");
    });
    this.#set({ state: "catching-up" });
    this.#request(conn);
    void this.#pump();
  }

  /** This connection's rows can't be kept (a store write failed): drop it; the next asks from the last stored position. */
  #fail(conn: TransportConnection, error: string): void {
    if (this.#conn !== conn) return;
    this.#conn = null;
    this.#inflight.clear();
    this.#inflightIds.clear();
    this.#caughtUp = false;
    conn.close();
    if (!this.#stopped) this.#retry(error);
  }

  #retry(error: string): void {
    this.#set({ state: "offline", error });
    if (this.#timer) clearTimeout(this.#timer);
    const ms = this.#backoff;
    this.#backoff = Math.min(BACKOFF_MAX, this.#backoff * 2);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#connect();
    }, ms);
  }

  #send(conn: TransportConnection, m: CommentClientMessage): void {
    conn.send(m as unknown as sync.ClientMessage);
  }

  #request(conn: TransportConnection): void {
    this.#send(conn, { type: "comments", branchId: this.#engine.cut(), since: this.#engine.head() });
  }

  async #onMessage(conn: TransportConnection, m: CommentServerMessage | { type: "error"; reason?: string; code?: string }): Promise<void> {
    if (!m || typeof m !== "object") return;
    const live = () => this.#conn === conn;
    if (m.type === "comments") {
      if (m.reply) {
        if (typeof m.retryMs === "number") {
          // over the host's read limit: the same page, later
          if (this.#readTimer) clearTimeout(this.#readTimer);
          this.#readTimer = setTimeout(() => {
            this.#readTimer = null;
            if (this.#conn === conn && !this.#stopped) this.#request(conn);
          }, Math.min(BACKOFF_MAX, Math.max(1, m.retryMs)));
          return;
        }
        await this.#engine.take(m.rows, m.head, m.reset === true, live);
        if (m.more) return this.#request(conn);
        this.#caughtUp = true;
        this.#backoff = BACKOFF_MIN;
        this.#set({ state: "up-to-date" });
        this.#wake();
        return;
      }
      // fan-out: in the server's order, after everything it sent before; the position moves once caught up
      await this.#engine.take(m.rows, this.#caughtUp ? m.head : null, false, live);
      this.#wake();
      return;
    }
    if (m.type === "commentAnswer") {
      const sent = this.#inflight.get(m.n);
      if (!sent) return;
      this.#inflight.delete(m.n);
      this.#inflightIds.delete(sent.id);
      if (m.row) await this.#engine.answered(sent, m.row, this.#caughtUp && m.row.seq !== undefined ? m.row.seq : null, live);
      else if (m.refused === "rate-limited") this.#rateLimited(m.retryMs ?? 1000);
      else await this.#engine.refused(sent, m.refused ?? "bad-request", m.reason ?? "refused", live);
      this.#wake();
      void this.#pump();
      return;
    }
    if (m.type === "error") {
      // a host from before comments: it doesn't know the message. Comments stay here; no retry loop.
      if (/unknown message type comment/.test(m.reason ?? "")) {
        this.#set({ state: "unsupported", error: "this server doesn't carry comments yet" });
        this.#conn = null;
        conn.close();
        this.#wake();
        return;
      }
      this.#set({ ...this.#status, error: m.reason ?? "server error" });
      if (m.code === "unauthorized" || m.code === "forbidden") {
        // the token expired or doesn't reach this cut: start again (a fresh token), backing off
        this.#conn = null;
        conn.close();
        this.#retry(m.reason ?? m.code);
      }
    }
  }

  #rateLimited(ms: number): void {
    this.#rateUntil = Math.max(this.#rateUntil, Date.now() + ms);
    this.#wakeAfterLimit();
  }

  /** A pump once the rate limit has passed (one timer, at the latest limit any answer gave). */
  #wakeAfterLimit(): void {
    if (this.#rateTimer) clearTimeout(this.#rateTimer);
    this.#rateTimer = setTimeout(() => {
      this.#rateTimer = null;
      void this.#pump();
    }, Math.max(1, this.#rateUntil - Date.now()));
  }

  async #pump(): Promise<void> {
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    try {
      do {
        this.#again = false;
        const conn = this.#conn;
        if (!conn || this.#stopped) return;
        if (Date.now() < this.#rateUntil) {
          if (!this.#rateTimer) this.#wakeAfterLimit();
          return;
        }
        const rows = await this.#engine.pending();
        // a reply waits for its thread's first comment to be answered: sent together, a rate-limited thread would
        // leave the reply refused as "not found" for good
        const unanswered = new Set(rows.filter((r) => r.patch.add).map((r) => r.id));
        for (const row of rows) {
          if (this.#inflight.size >= MAX_IN_FLIGHT || this.#conn !== conn) break;
          if (this.#inflightIds.has(row.id)) continue;
          const parent = row.patch.add?.replyTo;
          if (parent !== undefined && unanswered.has(parent)) continue;
          const n = ++this.#n;
          this.#inflight.set(n, row);
          this.#inflightIds.add(row.id);
          this.#send(conn, { type: "comment", branchId: this.#engine.cut(), n, id: row.id, patch: row.patch, ...(row.op ? { op: row.op } : {}) });
        }
      } while (this.#again);
    } catch (e) {
      // the pending rows couldn't be read: try again in a while (nothing is lost, they stay stored)
      this.#set({ ...this.#status, error: `couldn't read pending comments: ${e instanceof Error ? e.message : String(e)}` });
      this.#rateUntil = Math.max(this.#rateUntil, Date.now() + 1000);
      this.#wakeAfterLimit();
    } finally {
      this.#pumping = false;
    }
  }
}
