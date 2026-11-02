// A link you can break and slow down, in userspace, for a machine with no netem (Windows): a TCP proxy on 127.0.0.1
// that the client under test talks plain HTTP/WebSocket to, while the proxy talks TLS to the real host (SNI and the
// `Host:` line set to the host's name). Every byte either way goes through a lane that can
// - blackhole: stop moving bytes both ways without closing anything (Wi-Fi dropping: the sockets stay open, what was
//   sent waits, and arrives when the link is back, as TCP's retransmissions would deliver it);
// - shape: a rate (kbit/s) and a one-way delay per direction (a 3G-like link). A connection made while shaped waits
//   two added round trips before its upstream opens (the TCP and TLS handshakes the client would have made on that
//   link), so a fresh connect costs what it would.
// One request per proxied connection: each new connection's first request head is rewritten; a request that isn't a
// WebSocket upgrade gets `Connection: close`, so a keep-alive client can't send a second, unrewritten head on it.
import net from "node:net";
import tls from "node:tls";

const HIGH = 1 << 20, LOW = 256 << 10, SLICE = 4096, MAX_HEAD = 64 << 10;

export interface LinkStats { conns: number; upBytes: number; downBytes: number; heldMaxBytes: number; errors: string[] }

type Item = { buf: Buffer; eof?: false } | { eof: true; error: boolean };

class Lane {
  private q: Item[] = [];
  private flight: { item: Item; due: number }[] = [];
  private linkFree = 0;
  private queued = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private done = false;
  private ended = false;
  private readonly p: LinkProxy;
  private readonly src: net.Socket;
  private readonly dst: net.Socket;
  private readonly dir: "up" | "down";
  constructor(p: LinkProxy, src: net.Socket, dst: net.Socket, dir: "up" | "down") {
    this.p = p;
    this.src = src;
    this.dst = dst;
    this.dir = dir;
  }
  push(buf: Buffer): void {
    if (this.done) return;
    this.idleUntilNow();
    const slice = this.p.kbps > 0 ? SLICE : buf.length;
    for (let o = 0; o < buf.length; o += slice) this.q.push({ buf: buf.subarray(o, o + slice) });
    this.queued += buf.length;
    if (this.queued > HIGH) this.src.pause();
    this.pump();
  }
  eof(error: boolean): void {
    if (this.done || this.ended) return;
    this.ended = true;
    this.idleUntilNow();
    this.q.push({ eof: true, error });
    this.pump();
  }
  /**
   * The link's clock only catches up with now when it had nothing to send (or comes back from a hole): while it is
   * busy, each slice starts when the last ended, so timer lateness doesn't slow the rate.
   */
  idleUntilNow(): void {
    const t = performance.now();
    if (!this.q.length && this.linkFree < t) this.linkFree = t;
  }
  back(): void {
    this.linkFree = Math.max(this.linkFree, performance.now());
    this.pump();
  }
  /** Bytes waiting in this lane (sent by one side, not yet given to the other). */
  held(): number {
    return this.queued;
  }
  pump(): void {
    if (this.timer) clearTimeout(this.timer), (this.timer = null);
    if (this.done || this.p.hole) return;
    const t = performance.now();
    // transmit what the link has room for now
    while (this.q.length && this.linkFree <= t) {
      const item = this.q.shift()!;
      const bytes = item.eof ? 0 : item.buf.length;
      this.linkFree += this.p.kbps > 0 ? (bytes * 8) / this.p.kbps : 0;
      this.flight.push({ item, due: this.linkFree + this.p.delayMs });
    }
    // deliver what has crossed
    while (this.flight.length && this.flight[0]!.due <= t) {
      const { item } = this.flight.shift()!;
      if (item.eof) {
        this.done = true;
        if (item.error) this.dst.destroy();
        else this.dst.end(), setTimeout(() => this.dst.destroy(), 2000).unref();
        return;
      }
      this.queued -= item.buf.length;
      if (this.dir === "up") this.p.stats.upBytes += item.buf.length;
      else this.p.stats.downBytes += item.buf.length;
      if (!this.dst.destroyed) this.dst.write(item.buf);
    }
    if (this.queued < LOW && this.src.isPaused()) this.src.resume();
    const next = Math.min(this.q.length ? this.linkFree : Infinity, this.flight.length ? this.flight[0]!.due : Infinity);
    if (next < Infinity) this.timer = setTimeout(() => this.pump(), Math.max(0, next - t));
  }
}

export class LinkProxy {
  hole = false;
  delayMs = 0;
  kbps = 0;
  readonly stats: LinkStats = { conns: 0, upBytes: 0, downBytes: 0, heldMaxBytes: 0, errors: [] };
  private server: net.Server | null = null;
  private lanes = new Set<Lane>();
  private sockets = new Set<net.Socket>();
  private waiting: (() => void)[] = [];
  private readonly hostname: string;
  private readonly port: number;
  constructor(origin: string) {
    const u = new URL(origin);
    this.hostname = u.hostname;
    this.port = Number(u.port || 443);
  }
  /** Listens on 127.0.0.1; resolves with the port. */
  start(): Promise<number> {
    return new Promise((ok, no) => {
      const s = net.createServer((c) => this.accept(c));
      s.on("error", no);
      s.listen(0, "127.0.0.1", () => ok((s.address() as net.AddressInfo).port));
      this.server = s;
    });
  }
  blackhole(on: boolean): void {
    if (on) {
      this.hole = true;
      return;
    }
    this.hole = false;
    for (const f of this.waiting.splice(0)) f();
    for (const l of this.lanes) l.back();
  }
  shape(o: { delayMs?: number; kbps?: number }): void {
    this.delayMs = o.delayMs ?? 0;
    this.kbps = o.kbps ?? 0;
    for (const l of this.lanes) l.pump();
  }
  heldBytes(): number {
    let n = 0;
    for (const l of this.lanes) n += l.held();
    return n;
  }
  close(): void {
    this.server?.close();
    for (const s of this.sockets) s.destroy();
  }
  private track(s: net.Socket): void {
    this.sockets.add(s);
    s.on("close", () => this.sockets.delete(s));
  }
  private untilOpen(): Promise<void> {
    return this.hole ? new Promise((r) => this.waiting.push(r)) : Promise.resolve();
  }
  private accept(c: net.Socket): void {
    this.stats.conns++;
    this.track(c);
    c.on("error", () => {});
    let head = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEAD) c.destroy();
        return;
      }
      c.off("data", onData);
      c.pause();
      void this.open(c, this.rewrite(head.subarray(0, end + 4)), head.subarray(end + 4));
    };
    c.on("data", onData);
  }
  private rewrite(head: Buffer): Buffer {
    const lines = head.toString("latin1").split("\r\n");
    const upgrade = lines.some((l) => /^upgrade:\s*websocket/i.test(l));
    const out: string[] = [];
    let sawConnection = false;
    for (const l of lines) {
      if (/^host:/i.test(l)) out.push(`Host: ${this.hostname}`);
      else if (/^connection:/i.test(l) && !upgrade) (sawConnection = true), out.push("Connection: close");
      else out.push(l);
    }
    if (!upgrade && !sawConnection) out.splice(1, 0, "Connection: close");
    return Buffer.from(out.join("\r\n"), "latin1");
  }
  private async open(c: net.Socket, head: Buffer, rest: Buffer): Promise<void> {
    await this.untilOpen();
    // the handshakes the client would have made on this link: TCP and TLS, a round trip each
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, 4 * this.delayMs));
    await this.untilOpen();
    if (c.destroyed) return;
    const u = tls.connect({ host: this.hostname, port: this.port, servername: this.hostname, ALPNProtocols: ["http/1.1"] });
    this.track(u);
    u.on("error", (e) => {
      if (this.stats.errors.length < 20) this.stats.errors.push(`upstream: ${e.message}`.slice(0, 200));
    });
    let connected = false;
    u.once("secureConnect", () => {
      connected = true;
      const up = new Lane(this, c, u, "up"), down = new Lane(this, u, c, "down");
      this.lanes.add(up).add(down);
      const forget = () => {
        this.lanes.delete(up);
        this.lanes.delete(down);
      };
      c.on("data", (d: Buffer) => (up.push(d), this.noteHeld()));
      u.on("data", (d: Buffer) => (down.push(d), this.noteHeld()));
      c.on("end", () => up.eof(false));
      u.on("end", () => down.eof(false));
      c.on("close", (err) => (up.eof(err), u.destroyed && c.destroyed && forget()));
      u.on("close", (err) => (down.eof(err), u.destroyed && c.destroyed && forget()));
      up.push(head);
      if (rest.length) up.push(rest);
      c.resume();
    });
    u.once("close", () => {
      if (!connected) c.destroy();
    });
  }
  private noteHeld(): void {
    const h = this.heldBytes();
    if (h > this.stats.heldMaxBytes) this.stats.heldMaxBytes = h;
  }
}
