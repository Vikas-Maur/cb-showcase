// A machine's network link to its store, as a TCP proxy on 127.0.0.1: real sockets, so a cut is a real connection
// reset in the middle of an HTTP request, whatever client library is on the other side. It counts the bytes each way
// (every connection, every attempt, HTTP headers included), can slow the upload direction to a rate, can reset every
// connection once N more bytes went one way (and then stay down, refusing new connections until restored, or come
// straight back as a flaky link does), and can be pointed at a new port (a host that restarted).
import { connect, createServer, type Server, type Socket } from "node:net";

export interface CutOptions {
  /** Count client → server bytes (an upload; the default) or server → client bytes (a download). */
  direction?: "up" | "down";
  /** Refuse new connections after the cut until restore() (default true); false resets the open ones only. */
  stayDown?: boolean;
}

export class Link {
  /** Bytes sent up through the link so far (client → server). */
  upBytes = 0;
  /** Bytes sent down (server → client). */
  downBytes = 0;
  /** Bytes per second up, or 0 for no limit. */
  rate = 0;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  #target: number;
  #down = false;
  #cut: { at: number; direction: "up" | "down"; stayDown: boolean; done: () => void } | null = null;

  private constructor(server: Server, target: number) {
    this.#server = server;
    this.#target = target;
  }

  /** A link to the server listening on 127.0.0.1:`target`. */
  static async open(target: number, o: { rate?: number } = {}): Promise<Link> {
    const server = createServer();
    const link = new Link(server, target);
    link.rate = o.rate ?? 0;
    server.on("connection", (c) => link.#accept(c));
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => ok());
    });
    return link;
  }

  get port(): number {
    const a = this.#server.address();
    return typeof a === "object" && a ? a.port : 0;
  }
  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  get isDown(): boolean {
    return this.#down;
  }

  /** Resets every connection once `n` more bytes have gone the given way. Resolves when the cut happened. */
  cutAfter(n: number, o: CutOptions = {}): Promise<void> {
    const direction = o.direction ?? "up";
    const at = (direction === "up" ? this.upBytes : this.downBytes) + n;
    return new Promise((done) => (this.#cut = { at, direction, stayDown: o.stayDown ?? true, done }));
  }

  /** The link goes down now: open connections are reset, new ones refused until restore(). */
  drop(): void {
    this.#reset(true);
  }

  restore(): void {
    this.#down = false;
  }

  retarget(port: number): void {
    this.#target = port;
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise<void>((ok) => this.#server.close(() => ok()));
  }

  #reset(stayDown: boolean): void {
    if (stayDown) this.#down = true;
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
    const cut = this.#cut;
    this.#cut = null;
    cut?.done();
  }

  #accept(client: Socket): void {
    if (this.#down) return void client.destroy();
    const server = connect(this.#target, "127.0.0.1");
    this.#sockets.add(client);
    this.#sockets.add(server);
    const end = () => {
      client.destroy();
      server.destroy();
      this.#sockets.delete(client);
      this.#sockets.delete(server);
    };
    client.on("error", end).on("close", end);
    server.on("error", end).on("close", end);
    client.on("end", () => server.end());
    server.on("end", () => client.end());
    client.on("data", (chunk: Buffer) => this.#forward("up", chunk, client, server));
    server.on("data", (chunk: Buffer) => this.#forward("down", chunk, server, client));
  }

  #forward(direction: "up" | "down", chunk: Buffer, from: Socket, to: Socket): void {
    if (this.#down || to.destroyed) return;
    const count = direction === "up" ? this.upBytes : this.downBytes;
    const cut = this.#cut && this.#cut.direction === direction && count + chunk.length >= this.#cut.at ? this.#cut : null;
    const c = cut ? chunk.subarray(0, cut.at - count) : chunk;
    if (direction === "up") this.upBytes += c.length;
    else this.downBytes += c.length;
    if (cut) {
      // the bytes before the cut point still go out, then the link dies mid-request
      to.write(c, () => this.#reset(cut.stayDown));
      return;
    }
    const flushed = to.write(c);
    const waitMs = direction === "up" && this.rate > 0 ? (c.length / this.rate) * 1000 : 0;
    if (flushed && waitMs === 0) return;
    from.pause();
    const drained = flushed ? Promise.resolve() : new Promise<void>((r) => to.once("drain", () => r()));
    const paced = new Promise<void>((r) => setTimeout(r, waitMs));
    void Promise.all([drained, paced]).then(() => from.resume());
  }
}
