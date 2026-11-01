// A machine's network link to the host, as a real TCP proxy on 127.0.0.1:
//   down() / up()    drop every open connection and refuse new ones (the laptop goes offline), then let them through;
//   hold()           the connections open now stop forwarding the machine's bytes (a push in flight that hasn't
//                    arrived); new connections are not held, unless `{all: true}`. If the machine's process dies
//                    meanwhile, the held bytes are still delivered on release(), as data already on the wire would be
//                    (a dead helper's late push);
//   release()        deliver what was held, then close connections whose machine side is gone.
import { createServer, connect, type Server, type Socket } from "node:net";

interface Pair { client: Socket; upstream: Socket; held: Buffer[] | null; clientGone: boolean }

export class Link {
  private server: Server;
  private pairs = new Set<Pair>();
  private isDown = false;
  private holdNew = false;
  port = 0;
  readonly target: number;

  private constructor(target: number) {
    this.target = target;
    this.server = createServer((client) => this.accept(client));
  }

  static async open(targetPort: number): Promise<Link> {
    const l = new Link(targetPort);
    await new Promise<void>((r) => l.server.listen(0, "127.0.0.1", () => r()));
    l.port = (l.server.address() as { port: number }).port;
    return l;
  }

  /** The WebSocket URL a client uses to reach `projectId` through this link. */
  url(projectId: string): string {
    return `ws://127.0.0.1:${this.port}/api/projects/${projectId}/ws`;
  }

  private accept(client: Socket): void {
    if (this.isDown) return void client.destroy();
    const upstream = connect(this.target, "127.0.0.1");
    const p: Pair = { client, upstream, held: this.holdNew ? [] : null, clientGone: false };
    this.pairs.add(p);
    const drop = () => { this.pairs.delete(p); client.destroy(); upstream.destroy(); };
    client.on("data", (d) => (p.held ? p.held.push(d) : upstream.write(d)));
    upstream.on("data", (d) => { if (!client.destroyed) client.write(d); });
    // the machine side died: a held pair keeps its upstream open until release (its bytes are still "on the wire")
    const clientEnd = () => { p.clientGone = true; if (!p.held) drop(); };
    client.on("error", clientEnd).on("close", clientEnd);
    upstream.on("error", drop).on("close", drop);
  }

  down(): void {
    this.isDown = true;
    for (const p of this.pairs) { p.client.destroy(); p.upstream.destroy(); }
    this.pairs.clear();
  }

  up(): void {
    this.isDown = false;
  }

  /** `all`: connections opened while holding are held too (a reconnect, or a helper taking over, can't slip past). */
  hold(o: { all?: boolean } = {}): void {
    for (const p of this.pairs) p.held ??= [];
    if (o.all) this.holdNew = true;
  }

  release(): void {
    this.holdNew = false;
    for (const p of [...this.pairs]) {
      if (!p.held) continue;
      const h = p.held;
      p.held = null;
      for (const d of h) if (!p.upstream.destroyed) p.upstream.write(d);
      if (p.clientGone) setTimeout(() => { this.pairs.delete(p); p.upstream.destroy(); }, 2000).unref();
    }
  }

  /** Bytes held so far (a push waiting in the link). */
  get heldBytes(): number {
    let n = 0;
    for (const p of this.pairs) for (const d of p.held ?? []) n += d.length;
    return n;
  }

  async close(): Promise<void> {
    this.down();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
