// A TCP proxy between replicas and the sequencer host that can hold what the server sends (its acks and rows) while
// the replicas' own messages still go through: the R3-03 failure windows (the server adopted the cut, its answer not
// yet back) made certain instead of left to timing. Runs in the test process; `release` delivers what it held.
// `holdFrom(marker)` lets the server's messages through until one carries `marker` (server frames are unmasked JSON
// text: server-node doesn't compress), and holds from there: the exchange before an upload goes on, its answer waits.
import { createServer, connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";

export interface HoldProxy {
  readonly port: number;
  /** ws URL of the host, through the proxy. */
  via(url: string): string;
  holdFrom(marker: string): void;
  release(): void;
  close(): Promise<void>;
}

export async function holdProxy(targetPort: number): Promise<HoldProxy> {
  let holding = false;
  let marker: string | null = null;
  const tails = new Map<Socket, string>();
  const held: { to: Socket; data: Buffer }[] = [];
  const socks = new Set<Socket>();
  const srv = createServer((client) => {
    const up = connect(targetPort, "127.0.0.1");
    socks.add(client).add(up);
    client.on("data", (d) => up.write(d));
    up.on("data", (d: Buffer) => {
      if (!holding && marker) {
        // the marker may straddle two reads: the part already sent is an incomplete frame the replica can't act on
        const text = (tails.get(client) ?? "") + d.toString("latin1");
        tails.set(client, text.slice(-marker.length));
        if (text.includes(marker)) holding = true;
      }
      if (holding) held.push({ to: client, data: d });
      else client.write(d);
    });
    const end = () => {
      client.destroy();
      up.destroy();
      socks.delete(client);
      socks.delete(up);
      tails.delete(client);
    };
    for (const s of [client, up]) s.on("close", end).on("error", end);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return {
    port,
    via: (url) => url.replace(/:\d+\//, `:${port}/`),
    holdFrom: (m) => void (marker = m),
    release() {
      holding = false;
      marker = null;
      for (const h of held.splice(0)) if (!h.to.destroyed) h.to.write(h.data);
    },
    close() {
      for (const s of socks) s.destroy();
      return new Promise<void>((r) => srv.close(() => r()));
    },
  };
}
