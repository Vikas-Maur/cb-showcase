// The network between replicas and the sequencer (port of system-v11 `net.mjs`), now carrying the real protocol to the
// real sequencer core. A Link is one machine's uplink: RTT, jitter, loss, up/down. A SimConn is a WebSocket over it:
// FIFO in each direction, one-way delay RTT/2 (+ jitter, never reordering). On the client side it is a Transport
// connection (what the sync client talks to); on the server side a SequencerConnection (what `createSequencer` answers).
//
// A lost message breaks the connection (TCP would stall then reset; either way the client must reconnect and resend),
// so loss exercises the at-least-once paths: lost acks, resubmission. Messages the client sent before a break still
// reach the server (they were on the wire), so the server can confirm a change whose push was in flight; nothing more
// reaches the client on a broken connection, so that change's ack is lost. close() (a process exiting, or killed) stops
// new sends, but bytes already written still reach the server. Server CPU time is not modelled.

import type { AuthContext, TransportConnection } from "@carton/core/plugins";
import type { sync } from "@carton/core";
import type { ConnectionState, HostConnection } from "@carton/server";
import type { Proc, Sim } from "./kernel.ts";

export interface ServerSide {
  stats: { lostAcks: number };
  attach(conn: SimConn): void;
  detach(conn: SimConn): void;
  receive(conn: SimConn, msg: sync.ClientMessage): void;
  /** Test hook: return false to drop a message the server sends (and maybe break the connection). */
  hooks: { beforeSend: ((conn: SimConn, msg: sync.ServerMessage) => boolean | void) | null };
}

export class Link {
  readonly net: Net;
  rtt: number;
  jitter: number;
  loss: number;
  connectRtts: number;
  /** Test hook: extra one-way delay for one upstream message (a stalled retransmit). */
  delayHook: ((msg: sync.ClientMessage, conn: SimConn) => number) | null = null;
  up = true;
  readonly conns = new Set<SimConn>();
  constructor(net: Net, { rtt = 100, jitter = 0, loss = 0, connectRtts = 1 }: { rtt?: number; jitter?: number; loss?: number; connectRtts?: number } = {}) {
    this.net = net;
    this.rtt = rtt;
    this.jitter = jitter;
    this.loss = loss;
    this.connectRtts = connectRtts;
  }
  down(): void {
    this.up = false;
    for (const c of [...this.conns]) c.break("link down");
  }
  restore(): void {
    this.up = true;
  }
  delay(): number {
    return this.rtt / 2 + (this.jitter ? this.net.sim.rand() * this.jitter : 0);
  }
}

let CONN = 0;

export class SimConn implements TransportConnection {
  readonly net: Net;
  readonly sim: Sim;
  readonly link: Link;
  readonly proc: Proc;
  readonly id = `sim${++CONN}`;
  isOpen = false;
  broken = false;
  closed = false;
  private lastUp = 0;
  private lastDown = 0;
  /** Who this connection is to the sequencer (the replica's name, for logs). */
  readonly writer: string;
  /** The device credential it authenticates with: account plus per-install key (§6.3). */
  readonly credential: string;
  private messageListeners: ((m: sync.ServerMessage) => void)[] = [];
  private closeListeners: ((why: string) => void)[] = [];
  /** The sequencer's side of this connection. */
  readonly server: HostConnection;

  constructor(net: Net, link: Link, proc: Proc, { writer, credential, account }: { writer: string; credential: string; account: string }) {
    this.net = net;
    this.sim = net.sim;
    this.link = link;
    this.proc = proc;
    this.writer = writer;
    this.credential = credential;
    const auth: AuthContext = { account, credential, role: "editor", projectId: "sim", expires: Number.MAX_SAFE_INTEGER };
    const state: ConnectionState = { subs: [], deadEpoch: -1 };
    this.server = { id: this.id, auth, state, send: (m) => this.toClient(m) };
    proc.onExit.push(() => this.close());
  }
  get open(): boolean {
    return this.isOpen;
  }
  onMessage(l: (m: sync.ServerMessage) => void): void {
    this.messageListeners.push(l);
  }
  onClose(l: (why: string) => void): void {
    this.closeListeners.push(l);
  }
  /** Resolves true once connected, false if the link is down or the process died. */
  connect(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.link.up || !this.proc.alive) return this.sim.after(this.link.rtt, () => resolve(false));
      this.link.conns.add(this);
      this.sim.after(this.link.rtt * this.link.connectRtts, () => {
        if (this.closed || this.broken || !this.link.up || !this.proc.alive) {
          this.link.conns.delete(this);
          return resolve(false);
        }
        this.isOpen = true;
        this.net.server.attach(this);
        resolve(true);
      });
    });
  }
  /** client → server */
  send(msg: sync.ClientMessage): void {
    if (!this.isOpen) return;
    if (this.link.loss && this.sim.rand() < this.link.loss) return void this.break("loss");
    const t = Math.max(this.sim.now + this.link.delay() + (this.link.delayHook?.(msg, this) ?? 0), this.lastUp);
    this.lastUp = t;
    const copy = structuredClone(msg);
    this.sim.at(t, () => this.net.server.receive(this, copy));
  }
  /** server → client, delivered on the client's engine thread */
  toClient(msg: sync.ServerMessage): void {
    if (this.net.server.hooks.beforeSend && this.net.server.hooks.beforeSend(this, msg) === false) return;
    if (!this.isOpen || this.broken) {
      if (msg.type === "ack") this.net.server.stats.lostAcks++;
      return;
    }
    if (this.link.loss && this.sim.rand() < this.link.loss) return void this.break("loss");
    const t = Math.max(this.sim.now + this.link.delay(), this.lastDown);
    this.lastDown = t;
    const copy = structuredClone(msg);
    this.sim.at(t, () => {
      if (this.isOpen && !this.broken && this.proc.alive)
        this.proc.engine.post(() => {
          if (this.isOpen) for (const l of this.messageListeners) l(copy);
        });
      else if (copy.type === "ack") this.net.server.stats.lostAcks++; // the server confirmed it; the client never heard
    });
  }
  break(why: string): void {
    if (this.broken || this.closed) return;
    this.broken = true;
    this.isOpen = false;
    this.link.conns.delete(this);
    this.net.server.detach(this);
    this.sim.after(this.link.rtt / 2, () => {
      if (this.proc.alive) this.proc.engine.post(() => {
        for (const l of this.closeListeners) l(why);
      });
    });
  }
  close(): void {
    if (this.closed || this.broken) return;
    this.closed = true;
    this.isOpen = false;
    this.link.conns.delete(this);
    this.sim.at(Math.max(this.sim.now, this.lastUp) + 1e-6, () => this.net.server.detach(this));
  }
}

export class Net {
  readonly sim: Sim;
  readonly server: ServerSide;
  constructor(sim: Sim, server: ServerSide) {
    this.sim = sim;
    this.server = server;
  }
  link(opts?: ConstructorParameters<typeof Link>[1]): Link {
    return new Link(this, opts);
  }
}
