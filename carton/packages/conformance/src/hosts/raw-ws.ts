// A bare WebSocket client over node:net, for what a real client can't be made to do: vanish without a close frame
// (a crash, a lost network: `kill`) or go silent (it never pings, and never answers the host's pings). It speaks the
// host's protocol as the transport does: the session token in the subprotocol list, JSON text frames.
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import type { TransportConnection } from "@carton/core/plugins";

export interface RawConnection extends TransportConnection {
  /** Destroys the TCP socket: no close frame and no presence(null), as when a client crashes. */
  kill(): void;
}

/** Opens `ws://host:port/path` with the token as `carton.auth.<token>`; resolves once the host answered 101. */
export function rawWebSocket(url: string, token: string, protocol = "carton.v1"): Promise<RawConnection> {
  const u = new URL(url);
  if (u.protocol !== "ws:") throw new Error(`rawWebSocket speaks ws: only, not ${u.protocol}`);
  const socket = connect(Number(u.port || 80), u.hostname);
  const onMessage: ((m: never) => void)[] = [];
  const onClose: ((why: string) => void)[] = [];
  let open = false, closed = false, buf = Buffer.alloc(0), text: Buffer[] = [];
  const end = (why: string) => {
    if (closed) return;
    closed = true;
    open = false;
    for (const f of onClose) f(why);
  };
  const frame = (opcode: number, payload: Buffer) => {
    const mask = randomBytes(4);
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    const body = Buffer.from(payload);
    for (let i = 0; i < n; i++) body[i]! ^= mask[i & 3]!;
    return Buffer.concat([head, mask, body]);
  };
  const conn: RawConnection = {
    get open() {
      return open;
    },
    send(msg) {
      if (open) socket.write(frame(0x1, Buffer.from(JSON.stringify(msg))));
    },
    onMessage: (f) => void onMessage.push(f as never),
    onClose: (f) => void onClose.push(f),
    close() {
      if (open) socket.end(frame(0x8, Buffer.from([0x03, 0xe8])));
      open = false;
    },
    kill() {
      open = false;
      socket.destroy();
    },
  };
  // server frames are unmasked: text (maybe fragmented) is delivered; close ends it; pings go unanswered
  const frames = () => {
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0]! & 0x0f, fin = (buf[0]! & 0x80) !== 0;
      let n = buf[1]! & 0x7f, at = 2;
      if (n === 126) {
        if (buf.length < 4) return;
        n = buf.readUInt16BE(2);
        at = 4;
      } else if (n === 127) {
        if (buf.length < 10) return;
        n = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      if (buf.length < at + n) return;
      const payload = buf.subarray(at, at + n);
      buf = buf.subarray(at + n);
      if (op === 0x8) {
        socket.destroy();
        return end(`closed ${payload.length >= 2 ? payload.readUInt16BE(0) : 1005}`);
      }
      if (op !== 0x1 && op !== 0x0) continue; // ping, pong: a silent client ignores them
      text.push(Buffer.from(payload));
      if (!fin) continue;
      const whole = Buffer.concat(text).toString("utf8");
      text = [];
      if (whole === "pong") continue;
      const m = JSON.parse(whole) as never;
      for (const f of onMessage) f(m);
    }
  };
  return new Promise((resolve, reject) => {
    let head = "";
    socket.on("error", (e) => (open ? end(`error ${e.message}`) : reject(e)));
    socket.on("close", () => end("socket closed"));
    socket.once("connect", () => {
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n` +
          `Sec-WebSocket-Protocol: ${protocol}, carton.auth.${token}\r\n\r\n`,
      );
    });
    const onData = (d: Buffer) => {
      if (!open) {
        head += d.toString("latin1");
        const at = head.indexOf("\r\n\r\n");
        if (at < 0) return;
        if (!/^HTTP\/1\.1 101 /.test(head)) {
          socket.destroy();
          return reject(new Error(`handshake refused: ${head.split("\r\n")[0]}`));
        }
        open = true;
        buf = Buffer.from(head.slice(at + 4), "latin1");
        resolve(conn);
      } else buf = Buffer.concat([buf, d]);
      frames();
    };
    socket.on("data", onData);
  });
}
