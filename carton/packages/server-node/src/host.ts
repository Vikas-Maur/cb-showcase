// SequencerHost for Node (PLAN §3.1, §6.3): the sequencer core on node:sqlite, a WebSocket endpoint, and the same
// HTTP API as the Worker (@carton/host-http). In production it runs inside Cardboard's own API (behind its auth, with
// GCS or R2 through blob-s3); here it also serves on-prem and local sharing. A host stays thin: no ordering,
// validation or overlap logic lives here.
//
// - One room per project, opened on its first connection: a SQLite file `<dataDir>/rooms/<project>.db` (the name
//   encoded as blob-fs encodes keys, so `Proj` and `proj` never share a file on a case-insensitive volume) and one
//   `createSequencer`. A room with no connections closes after `idleCloseMs`, the Node counterpart of hibernation;
//   everything it knows is in its file, so reopening gives the same answers.
// - One Node event loop runs every room, so a project's messages are handled one at a time (the sequencer also
//   serializes its own blob-store awaits).
// - Keepalive: a `ping` text frame is answered `pong` here, as the Worker's runtime does, and the WebSocket layer
//   pings an idle peer and drops one that doesn't answer.
// - A socket whose token expires is closed with 4001; the client refreshes and reconnects with the same credential.
// - Archiving (§18) runs on a timer per open room, with the same defaults as the Durable Object.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { mkdirSync, createReadStream, statSync } from "node:fs";
import { join, resolve, sep, extname } from "node:path";
import { Readable } from "node:stream";
import type { Duplex } from "node:stream";
import type { AuthContext, BlobStore, SequencerHost } from "@carton/core/plugins";
import type { sync } from "@carton/core";
import { createSequencer, type ConnectionState, type HostConnection, type Sequencer, tokenFromRequest, WS_PROTOCOL } from "@carton/server";
import { handleHttp, checkSession, type HttpAuth, type HttpDeps } from "@carton/host-http";
import { scopedBlobStore } from "@carton/blob-memory/scoped";
import { encodeSegment } from "@carton/blob-fs/keys";
import { acceptWebSocket, rejectUpgrade, type ServerWebSocket } from "./ws.ts";
import { nodeSqliteStorage, type NodeSqliteStorage } from "./storage.ts";

export interface NodeHostOptions {
  /** Directory holding one SQLite file per project. */
  dataDir: string;
  /** Verifies session tokens. The demo's createHmacAuth also serves invite links (join, refresh, invites). */
  auth: HttpAuth;
  /** Signs blob URLs; required with `blobs`. At least 32 bytes, from the environment. */
  secret?: string | Uint8Array;
  /** Media, keyframes and archived segments (blob-fs or blob-s3); each project sees its own `projects/<id>/` scope. */
  blobs?: BlobStore;
  /** 0 picks a free port. */
  port?: number;
  host?: string;
  /** Serve this directory's files for anything that isn't an API route (the web client). */
  staticDir?: string;
  adminToken?: string;
  /** Close a room's database this long after its last connection (default 5 minutes). */
  idleCloseMs?: number;
  /** Archive rows older than the newest `archiveKeep` per branch, `archiveSegment` per segment. Default: the
   * sequencer's own (§18: 10,000 and 10,000). */
  archiveKeep?: number;
  archiveSegment?: number;
  archiveEveryMs?: number;
  /** Largest WebSocket message (default 32 MiB, Cloudflare's own cap, so both hosts accept the same messages). This
   * is the protocol's limit, separate from the sequencer's 1 MB threshold for keeping a change body inline. */
  maxMessageBytes?: number;
  /** The newest document schemaVersion this host's sequencer accepts in `hello` (default 1). */
  schemaVersion?: number;
  durability?: "full" | "normal";
  onError?: (e: unknown) => void;
}

export interface NodeHost extends SequencerHost {
  /** Where a project's clients connect: `ws://host:port/api/projects/<id>/ws`. */
  urlFor(projectId: string): string;
  readonly httpUrl: string;
  readonly port: number;
  /** The open rooms (tests and admin). */
  room(projectId: string): { sequencer: Sequencer; storage: NodeSqliteStorage; connections: number } | undefined;
}

interface Room {
  projectId: string;
  storage: NodeSqliteStorage;
  sequencer: Sequencer;
  conns: Map<ServerWebSocket, HostConnection & { state: ConnectionState }>;
  idle: ReturnType<typeof setTimeout> | null;
  archive: ReturnType<typeof setInterval> | null;
  // sequencer work still running (a handle or an archive waiting on the blob store): the room's database stays
  // open, and no second room for the project can start, until it is done
  pending: Set<Promise<unknown>>;
  closeWhenDrained: boolean;
}

const MAX_MESSAGE = 32 << 20;
const WS_PATH = /^\/api\/projects\/([A-Za-z0-9._~-]{1,128})\/ws$/;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm" };

// node:http request → web Request (the body streams; GET and HEAD have none).
function toRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(new URL(req.url ?? "/", origin), init);
}

async function send(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(r.status, headers);
  if (!r.body) return void res.end();
  const body = Readable.fromWeb(r.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>);
  await new Promise<void>((ok) => {
    body.on("error", () => {
      res.destroy();
      ok();
    });
    res.on("close", () => {
      body.destroy();
      ok();
    });
    body.pipe(res);
  });
}

export async function startNodeHost(opts: NodeHostOptions): Promise<NodeHost> {
  const roomsDir = join(opts.dataDir, "rooms");
  mkdirSync(roomsDir, { recursive: true });
  const rooms = new Map<string, Room>();
  const idleCloseMs = opts.idleCloseMs ?? 5 * 60_000;
  const archiveEvery = opts.archiveEveryMs ?? 3600_000;
  const onError = opts.onError ?? ((e) => console.error("carton host:", e));
  const staticRoot = opts.staticDir ? resolve(opts.staticDir) : null;
  if (opts.blobs && !opts.secret) throw new Error("startNodeHost: `secret` is required with `blobs` (it signs blob URLs)");
  let nextId = 0, closing = false;

  // Two scopes per project that no route can cross: the sequencer's keyframes, segments and large change bodies, and
  // the media the HTTP API signs and uploads (an editor can write media, never the sequencer's records).
  const scoped = (projectId: string, scope: "seq" | "media") => (opts.blobs ? scopedBlobStore(opts.blobs, `projects/${projectId}/${scope}/`) : undefined);
  const blobsFor = (projectId: string) => scoped(projectId, "media");

  function openRoom(projectId: string): Room {
    let room = rooms.get(projectId);
    if (room) return room;
    const storage = nodeSqliteStorage(join(roomsDir, encodeSegment(projectId) + ".db"), opts.durability ? { durability: opts.durability } : {});
    const blobs = scoped(projectId, "seq");
    const sequencer = createSequencer({ storage, auth: opts.auth, projectId, schemaVersion: opts.schemaVersion ?? 1, ...(blobs ? { blobs } : {}) });
    room = { projectId, storage, sequencer, conns: new Map(), idle: null, archive: null, pending: new Set(), closeWhenDrained: false };
    if (blobs) {
      const r = room;
      r.archive = setInterval(() => void track(r, maintain(r)), archiveEvery);
      r.archive.unref();
    }
    rooms.set(projectId, room);
    return room;
  }

  // The sequencer's periodic work: archive old rows to gzip segments and sweep expired envelope blobs.
  async function maintain(room: Room): Promise<void> {
    const o: { keep?: number; segmentRows?: number } = {};
    if (opts.archiveKeep !== undefined) o.keep = opts.archiveKeep;
    if (opts.archiveSegment !== undefined) o.segmentRows = opts.archiveSegment;
    try {
      await room.sequencer.maintain(o);
    } catch (e) {
      onError(e);
    }
  }

  function track<T>(room: Room, p: Promise<T>): Promise<T> {
    room.pending.add(p);
    const done = () => {
      room.pending.delete(p);
      if (room.pending.size === 0 && room.closeWhenDrained && room.conns.size === 0) closeRoom(room);
    };
    p.then(done, done);
    return p;
  }

  // Only a drained room closes: a handle still waiting on the blob store must finish on this database, before
  // another room for the project may open it.
  function closeRoom(room: Room): void {
    if (room.pending.size > 0) {
      room.closeWhenDrained = true;
      return;
    }
    if (room.idle) clearTimeout(room.idle);
    if (room.archive) clearInterval(room.archive);
    if (rooms.get(room.projectId) === room) rooms.delete(room.projectId);
    room.storage.close();
  }

  function connect(ws: ServerWebSocket, auth: AuthContext, projectId: string): void {
    const room = openRoom(projectId);
    room.closeWhenDrained = false;
    if (room.idle) {
      clearTimeout(room.idle);
      room.idle = null;
    }
    const conn = {
      id: `n${(++nextId).toString(36)}`,
      auth,
      state: { subs: [], deadEpoch: -1 } as ConnectionState,
      send(msg: sync.ServerMessage) {
        // a subscriber whose token expired gets nothing more, even if it never sends (fan-out, presence)
        if (auth.expires < Date.now()) return ws.close(4001, "token expired");
        ws.send(JSON.stringify(msg));
      },
    };
    room.conns.set(ws, conn);
    room.sequencer.attach(conn);
    ws.on("message", (data) => {
      if (typeof data !== "string") return ws.close(1003, "text frames only");
      if (data === "ping") return ws.send("pong");
      if (auth.expires < Date.now()) return ws.close(4001, "token expired");
      let msg: sync.ClientMessage;
      try {
        msg = JSON.parse(data);
      } catch {
        return conn.send({ type: "error", reason: "bad json" });
      }
      track(room, room.sequencer.handle(conn, msg)).catch(onError);
    });
    ws.on("close", () => {
      room.conns.delete(ws);
      room.sequencer.disconnect(conn);
      if (room.conns.size === 0 && !closing) {
        room.idle = setTimeout(() => {
          if (room.conns.size === 0) closeRoom(room);
        }, idleCloseMs);
        room.idle.unref();
      }
    });
  }

  const server: Server = createServer();
  const listenHost = opts.host ?? "127.0.0.1";
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 0, listenHost, () => {
      server.off("error", fail);
      ok();
    });
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
  const hostPart = listenHost.includes(":") ? `[${listenHost}]` : listenHost;
  const origin = `http://${hostPart}:${port}`;

  const deps: HttpDeps = {
    auth: opts.auth,
    secret: opts.secret ?? new Uint8Array(32),
    blobsFor,
    sequencerBlobsFor: (projectId) => scoped(projectId, "seq"),
    // a plain GET on the socket route (no Upgrade header): the upgrade itself goes through server.on("upgrade")
    upgrade: async () => new Response("expected a WebSocket upgrade", { status: 426 }),
  };
  if (opts.adminToken) deps.adminToken = opts.adminToken;

  server.on("request", (req, res) => {
    void (async () => {
      try {
        const r = await handleHttp(toRequest(req, origin), deps);
        if (r) return await send(res, r);
        if (staticRoot && (req.method === "GET" || req.method === "HEAD")) return serveStatic(staticRoot, req, res);
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      } catch (e) {
        onError(e);
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
      }
    })();
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => {});
    const m = WS_PATH.exec(new URL(req.url ?? "/", origin).pathname);
    if (!m || closing) return rejectUpgrade(socket, 404);
    const projectId = m[1]!;
    const headers = { get: (n: string) => (req.headers[n.toLowerCase()] as string | undefined) ?? null };
    const token = tokenFromRequest(headers);
    if (!token) return rejectUpgrade(socket, 401, "session token required");
    void checkSession(opts.auth, token, projectId).then(
      (auth) => {
        if (socket.destroyed) return;
        const ws = acceptWebSocket(req, socket, head, {
          protocols: (offered) => (offered.includes(WS_PROTOCOL) ? WS_PROTOCOL : null),
          maxPayload: opts.maxMessageBytes ?? MAX_MESSAGE,
          maxBufferedBytes: 16 << 20,
        });
        if (ws) connect(ws, auth, projectId);
      },
      (e: { status?: number; message?: string }) => rejectUpgrade(socket, e?.status === 403 ? 403 : 401, e?.message ?? "unauthorized"),
    );
  });

  return {
    kind: "node",
    url: `ws://${hostPart}:${port}`,
    httpUrl: origin,
    port,
    urlFor: (projectId) => `ws://${hostPart}:${port}/api/projects/${projectId}/ws`,
    room(projectId) {
      const r = rooms.get(projectId);
      return r && { sequencer: r.sequencer, storage: r.storage, connections: r.conns.size };
    },
    async close() {
      closing = true;
      for (const room of rooms.values()) for (const ws of room.conns.keys()) ws.close(1001, "host shutting down");
      await new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      });
      // sockets that ignore the close frame are dropped by the WebSocket layer's close timeout; don't wait on them
      for (const room of [...rooms.values()]) {
        if (room.archive) clearInterval(room.archive);
        room.archive = null;
        for (const ws of room.conns.keys()) ws.terminate();
        room.conns.clear();
      }
      // Sequencer work in flight finishes on its own database first, however long its blob store takes: closing the
      // database under it, or resolving while it still writes, would let a host restarted on the same data be
      // overwritten by the old write. No new work can start: sockets and timers are gone.
      for (;;) {
        const all = [...rooms.values()].flatMap((r) => [...r.pending]);
        if (all.length === 0) break;
        await Promise.allSettled(all);
      }
      for (const room of [...rooms.values()]) closeRoom(room);
    },
  };
}

// Static files under `root`, never outside it (the path is resolved, then checked against the root).
function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    return void res.writeHead(400).end();
  }
  let file = resolve(root, "." + path);
  if (file !== root && !file.startsWith(root + sep)) return void res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    const st = statSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "content-length": String(st.size) });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}
