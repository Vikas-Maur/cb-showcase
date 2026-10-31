// A machine's network link to the host, as a real TCP proxy on 127.0.0.1: `down()` drops every open connection and
// refuses new ones (the laptop goes offline), `up()` lets them through again, `hold()` keeps connections open but
// stops forwarding the machine's bytes (a push in flight that never arrives), `release()` sends what was held.
import { createServer, connect, type Server, type Socket } from "node:net";

export class Link {
  private server: Server;
  private pairs = new Set<[Socket, Socket]>();
  private isDown = false;
  private held: { from: Socket; to: Socket; data: Buffer }[] | null = null;
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
    const pair: [Socket, Socket] = [client, upstream];
    this.pairs.add(pair);
    const end = () => { this.pairs.delete(pair); client.destroy(); upstream.destroy(); };
    client.on("data", (d) => (this.held ? this.held.push({ from: client, to: upstream, data: d }) : upstream.write(d)));
    upstream.on("data", (d) => client.write(d));
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
  }

  down(): void {
    this.isDown = true;
    for (const [a, b] of this.pairs) { a.destroy(); b.destroy(); }
    this.pairs.clear();
  }

  up(): void {
    this.isDown = false;
  }

  hold(): void {
    this.held ??= [];
  }

  release(): void {
    const h = this.held ?? [];
    this.held = null;
    for (const x of h) if (!x.to.destroyed) x.to.write(x.data);
  }

  /** Bytes held so far (a push waiting in the link). */
  get heldBytes(): number {
    return (this.held ?? []).reduce((n, x) => n + x.data.length, 0);
  }

  async close(): Promise<void> {
    this.down();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
