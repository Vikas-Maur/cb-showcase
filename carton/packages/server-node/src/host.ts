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
import { mkdirSync, createReadStream, statSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, sep, extname } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type { AuthContext, BlobStore, SequencerHost } from "@carton/core/plugins";
import { sync } from "@carton/core";
import { createSequencer, type ConnectionState, type HostConnection, type Sequencer, tokenFromRequest, WS_PROTOCOL } from "@carton/server";
import { handleHttp, checkSession, projectMediaStore, type HttpAuth, type HttpDeps } from "@carton/host-http";
import { scopedBlobStore } from "@carton/blob-memory/scoped";
import { encodeSegment, decodeSegment } from "@carton/blob-fs/keys";
import { CARDBOARD_SCHEMA_VERSION } from "@carton/cardboard";
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
  /** The team a project belongs to, for media dedup within a team (PLAN §11): its media bytes and manifests are kept
   * once under `teams/<team>/media/`, and a project reads only the hashes it was granted (host-http's team.ts). No
   * team (the default): each project's media stays in its own scope. */
  teamOf?: (projectId: string) => string | null | undefined;
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
  /** A socket silent this long is pinged; one still silent after as long again is dropped (default 30 s, 0 = never).
   * A client that lost its network goes, and so does its presence on its teammates' screens, within twice this. */
  idleTimeoutMs?: number;
  /** The origin clients reach this host at (`https://carton.example`), for the signed URLs it hands out. Without
   * it, each request's own Host header is used, so a URL works at the address the client used. */
  publicOrigin?: string;
  /** Behind a reverse proxy: take the origin from X-Forwarded-Proto and X-Forwarded-Host. Only set this when a
   * proxy you run sets them; a client could otherwise choose them. */
  trustProxy?: boolean;
  /** The newest document schemaVersion this host's sequencer accepts in `hello`. Default: the Cardboard adapter's
   * `CARDBOARD_SCHEMA_VERSION`, so the host built with an adapter always takes that adapter's clients (H-SV: a
   * hard-coded 1 refused every client after the adapter's bump to 2). A newer client is refused with a message
   * saying to update the server. */
  schemaVersion?: number;
  /** The largest message carried as an envelope, read by the sequencer and taken by the upload route (default 64
   * MiB, the sequencer's own). */
  maxEnvelopeBytes?: number;
  /** The most keys one POST /blobs/heads checks (default and most 1000); the client asks again for the rest. */
  maxBlobHeads?: number;
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
  /** Delete expired envelope blobs of every project this host knows, room open or not (runs hourly by itself). */
  sweepEnvelopes(): Promise<number>;
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

// A room's database file name: the project id as blob-fs encodes a key segment (so `Proj` and `proj` never share a
// file on a case-insensitive volume), or, when that would be long, `~` and the id's SHA-256. SQLite adds suffixes
// (`-journal`, `-wal`) to the name, which must stay under 255 bytes, so a readable name is kept to 120.
const ROOM_NAME_MAX = 120;
function roomFileName(projectId: string): string {
  const name = encodeSegment(projectId);
  return name.length <= ROOM_NAME_MAX && !name.includes("~") ? name : "~" + createHash("sha256").update(projectId).digest("hex");
}

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

async function send(res: ServerResponse, r: Response, req?: IncomingMessage): Promise<void> {
  // the connection may be gone already (the client left, or the host closed it): its "close" event has fired, so
  // nothing below would ever settle
  if (res.destroyed) {
    await r.body?.cancel().catch(() => {});
    return;
  }
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  // answered before its body was read whole (a 413 at the budget, which cancelled the read): the rest of the body is
  // still on the connection, so it can't carry another request. Without this the client keeps it in its pool, and a
  // later request on it fails (ECONNRESET).
  if (req && !req.complete) headers.connection = "close";
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
  // the media the HTTP API signs and uploads (an editor can write media, never the sequencer's records). With a team,
  // media bytes and manifests sit in the team's scope instead, behind the project's grants (projectMediaStore).
  const scoped = (projectId: string, scope: "seq") => (opts.blobs ? scopedBlobStore(opts.blobs, `projects/${projectId}/${scope}/`) : undefined);
  const blobsFor = (projectId: string) => (opts.blobs ? projectMediaStore(opts.blobs, projectId, opts.teamOf?.(projectId)) : undefined);

  function openRoom(projectId: string): Room {
    let room = rooms.get(projectId);
    if (room) return room;
    if (closing) throw new Error("the host is closing");
    const name = roomFileName(projectId);
    // a project id whose file name had to be hashed is kept beside it, so the sweep can name it
    if (decodeSegment(name) === null) {
      const idFile = join(roomsDir, name + ".id");
      if (!existsSync(idFile)) writeFileSync(idFile, projectId);
    }
    const storage = nodeSqliteStorage(join(roomsDir, name + ".db"), opts.durability ? { durability: opts.durability } : {});
    const blobs = scoped(projectId, "seq");
    const sequencer = createSequencer({
      storage,
      auth: opts.auth,
      projectId,
      schemaVersion: opts.schemaVersion ?? CARDBOARD_SCHEMA_VERSION,
      ...(opts.maxEnvelopeBytes !== undefined ? { maxEnvelopeBytes: opts.maxEnvelopeBytes } : {}),
      ...(blobs ? { blobs } : {}),
    });
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
      idleLater(room);
    });
  }

  function idleLater(room: Room): void {
    if (room.conns.size > 0 || closing || room.idle) return;
    room.idle = setTimeout(() => {
      room.idle = null;
      if (room.conns.size === 0) closeRoom(room);
    }, idleCloseMs);
    room.idle.unref();
  }

  // A project known to the sweep without a room: an upload that landed while the host was closing.
  function registerProject(projectId: string): void {
    const name = roomFileName(projectId);
    const idFile = join(roomsDir, name + ".id");
    if (!existsSync(join(roomsDir, name + ".db")) && !existsSync(idFile)) writeFileSync(idFile, projectId);
  }

  // Envelope blobs expire hours after they were made (core's envelopeExpired), longer than a room usually stays
  // open, and an upload may come with no socket at all. So the sweep runs at the host, over every project with a
  // room file or a `.id` file, open or not; room maintenance (archiving) stays with the room.
  async function sweepEnvelopes(): Promise<number> {
    if (!opts.blobs) return 0;
    const now = Date.now();
    let swept = 0;
    let files: string[] = [];
    try {
      files = readdirSync(roomsDir);
    } catch {}
    const projects = new Set<string>();
    for (const f of files) {
      if (f.endsWith(".db")) {
        const id = decodeSegment(f.slice(0, -3));
        if (id !== null) projects.add(id); // a hashed name has its .id file beside it
      } else if (f.endsWith(".id")) {
        try {
          projects.add(readFileSync(join(roomsDir, f), "utf8"));
        } catch {}
      }
    }
    for (const projectId of projects) {
      const store = scoped(projectId, "seq")!;
      let cursor: string | undefined;
      do {
        const page = await store.list("messages/", cursor ? { cursor } : {});
        for (const b of page.blobs)
          if (sync.envelopeExpired(b.key, now)) {
            await store.delete(b.key).catch(() => {});
            swept++;
          }
        cursor = page.cursor;
      } while (cursor);
    }
    return swept;
  }
  const sweeper = setInterval(() => void sweepEnvelopes().catch(onError), archiveEvery);
  sweeper.unref();

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

  // The origin a request was made to, for the URLs built from it (signed media URLs): the configured public one, else
  // what a trusted proxy forwarded, else the Host header the client sent, else the listen address.
  const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;
  const publicOrigin = opts.publicOrigin ? new URL(opts.publicOrigin).origin : null;
  function originOf(req: IncomingMessage): string {
    if (publicOrigin) return publicOrigin;
    const first = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h)?.split(",")[0]?.trim();
    if (opts.trustProxy) {
      const host = first(req.headers["x-forwarded-host"]), proto = first(req.headers["x-forwarded-proto"]);
      if (host && HOST_RE.test(host)) return `${proto === "https" ? "https" : "http"}://${host}`;
    }
    const host = req.headers.host;
    return host && HOST_RE.test(host) ? `http://${host}` : origin;
  }

  const deps: HttpDeps = {
    auth: opts.auth,
    secret: opts.secret ?? new Uint8Array(32),
    blobsFor,
    sequencerBlobsFor: (projectId) => scoped(projectId, "seq"),
    ...(opts.maxEnvelopeBytes !== undefined ? { maxEnvelopeBytes: opts.maxEnvelopeBytes } : {}),
    ...(opts.maxBlobHeads !== undefined ? { maxBlobHeads: opts.maxBlobHeads } : {}),
    // an upload gives the project a room file (opened briefly), so the host's sweep knows it even if no socket comes;
    // while closing no room opens, so the project is registered with a `.id` file for the next start's sweep
    onEnvelope: (projectId) => {
      if (closing) registerProject(projectId);
      else idleLater(openRoom(projectId));
    },
    // a plain GET on the socket route (no Upgrade header): the upgrade itself goes through server.on("upgrade")
    upgrade: async () => new Response("expected a WebSocket upgrade", { status: 426 }),
  };
  if (opts.adminToken) deps.adminToken = opts.adminToken;

  // requests still being answered: close waits for them, so none touches a room or the blob store after it resolves
  const httpPending = new Set<Promise<void>>();
  server.on("request", (req, res) => {
    const work = (async () => {
      try {
        const r = await handleHttp(toRequest(req, originOf(req)), deps);
        if (r) return await send(res, r, req);
        if (staticRoot && (req.method === "GET" || req.method === "HEAD")) return serveStatic(staticRoot, req, res);
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      } catch (e) {
        onError(e);
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
      }
    })();
    httpPending.add(work);
    void work.finally(() => httpPending.delete(work));
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => {});
    const m = WS_PATH.exec(new URL(req.url ?? "/", origin).pathname);
    if (!m || closing) return rejectUpgrade(socket, 404);
    const projectId = m[1]!;
    const headers = { get: (n: string) => (req.headers[n.toLowerCase()] as string | undefined) ?? null };
    const token = tokenFromRequest(headers);
    if (!token) return rejectUpgrade(socket, 401, "session token required");
    void checkSession(opts.auth, token, projectId)
      .then(
        (auth) => {
          if (socket.destroyed) return;
          // the host began closing while this upgrade was being checked: refuse it before accepting it
          if (closing) return rejectUpgrade(socket, 503, "host shutting down");
          const ws = acceptWebSocket(req, socket, head, {
            protocols: (offered) => (offered.includes(WS_PROTOCOL) ? WS_PROTOCOL : null),
            maxPayload: opts.maxMessageBytes ?? MAX_MESSAGE,
            maxBufferedBytes: 16 << 20,
            ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
          });
          if (!ws) return;
          try {
            connect(ws, auth, projectId);
          } catch (e) {
            onError(e);
            ws.close(1011, "internal error");
          }
        },
        (e: { status?: number; message?: string }) => rejectUpgrade(socket, e?.status === 403 ? 403 : 401, e?.message ?? "unauthorized"),
      )
      .catch((e) => {
        onError(e);
        socket.destroy();
      });
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
    sweepEnvelopes,
    async close() {
      closing = true;
      clearInterval(sweeper);
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
      // HTTP requests in flight (an envelope upload whose blob write is slow, say) finish first: they may open a room
      await Promise.allSettled([...httpPending]);
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
