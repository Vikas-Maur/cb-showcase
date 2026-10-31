// ProjectRoom: one SQLite-backed Durable Object per project, hosting `createSequencer` (PLAN §3, §6.3, §17). It is
// storage plus socket glue: no ordering, validation or overlap logic lives here.
//
// - WebSocket Hibernation API: the room accepts sockets with `ctx.acceptWebSocket` and sets no timers, so it can be
//   evicted between messages. Each socket's attachment holds its verified AuthContext and its protocol state (the
//   branches it follows, its dead epoch); after a wake the constructor re-attaches every socket with that state, so
//   fan-out still reaches them.
// - Keepalive: a text frame `ping` is answered `pong` by the runtime without waking the room.
// - Alarms: archiving old change rows to blob segments (§18) runs from an alarm, never on a push. Defaults follow
//   §18 (rows older than the newest 10,000, in segments of 10,000), because every archived row costs one more row
//   written (a DELETE is billed like an INSERT) against the Free plan's 100k rows a day (L6).
// - Auth: the Worker verifies the token before the room wakes and passes the AuthContext in a header only it can
//   set; the room still refuses a context for another project, and closes a socket whose token has expired (the
//   client refreshes and reconnects, keeping its credential and so its replica ids).

import type { AuthContext, AuthProvider, BlobStore } from "@carton/core/plugins";
import type { sync } from "@carton/core";
import { createSequencer, type ConnectionState, type HostConnection, type Sequencer, WS_PROTOCOL } from "@carton/server";
import { scopedBlobStore } from "@carton/blob-memory/scoped";
import { projectMediaStore } from "@carton/host-http";
import type { CfWebSocket, DurableObjectState, WebSocketPairCtor, WebSocketRequestResponsePairCtor } from "./cf.ts";
import type { Env } from "./env.ts";
import { doSqlStorage } from "./storage.ts";
import { r2BlobStore } from "./blob-r2.ts";
import { doBlobStore } from "./blob-do.ts";
import { CARDBOARD_SCHEMA_VERSION } from "@carton/cardboard";

export const AUTH_HEADER = "x-carton-auth";
export const PROJECT_HEADER = "x-carton-project";
// The largest message the room takes in, inline or as an envelope (the sequencer's maxEnvelopeBytes; the Worker's
// upload route uses the same). A message of N bytes holds about 3N while it is handled (its bytes, their text, then
// the parsed message; again when it is stored and fanned out), and a Durable Object has 128 MB, so the default is
// 24 MiB [E] (MAX_ENVELOPE_BYTES; measurement listed in the hosts-plugins notes). Bigger messages travel on Node.
export const DEFAULT_MAX_ENVELOPE = 24 << 20;
export const maxEnvelopeOf = (env: Env) => Number(env.MAX_ENVELOPE_BYTES ?? DEFAULT_MAX_ENVELOPE);

// Is this string's UTF-8 encoding over `cap` bytes? Counted without encoding it (a copy the cap exists to avoid),
// and only when the UTF-16 length doesn't settle it: each unit is 1 to 3 bytes, a surrogate pair 4 for 2 units.
export function utf8Over(s: string, cap: number): boolean {
  if (s.length > cap) return true;
  if (s.length * 3 <= cap) return false;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3;
    if (n > cap) return true;
  }
  return false;
}
const ALARM_RETRY_MS = 60_000;

interface Attachment {
  id: string;
  auth: AuthContext;
  state: ConnectionState;
}

// The room never verifies tokens itself (the Worker did, and the sequencer only reads `conn.auth`); this provider
// only fills createSequencer's option.
const trusted: AuthProvider = { kind: "worker-verified", verify: async () => null };

// One project's blobs, in two scopes no route can cross: the sequencer's keyframes, segments and large change bodies
// under `projects/<p>/seq/`, and the media the HTTP API signs and uploads under `projects/<p>/media/`. An editor
// can write media, never the sequencer's records (which may belong to a cut they may not write).
function projectBlobs(env: Env, projectId: string, scope: "seq" | "media"): BlobStore | undefined {
  if (env.BLOBS) return scopedBlobStore(r2BlobStore(env.BLOBS), `projects/${projectId}/${scope}/`);
  if (env.BLOB_VAULT) return scopedBlobStore(doBlobStore(env.BLOB_VAULT, projectId), `${scope}/`);
  return undefined;
}
export const sequencerBlobs = (env: Env, projectId: string) => projectBlobs(env, projectId, "seq");
// With R2 and TEAMS, a project's media dedups within its team; the DO-blob fallback is per project, so it never does.
let teams: { src: string; map: Record<string, unknown> } | null = null;
function teamOf(env: Env, projectId: string): string | undefined {
  if (!env.TEAMS) return undefined;
  if (teams?.src !== env.TEAMS) {
    const map: unknown = JSON.parse(env.TEAMS);
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("TEAMS must be a JSON object from project id to team id");
    teams = { src: env.TEAMS, map: map as Record<string, unknown> };
  }
  const team = Object.hasOwn(teams.map, projectId) ? teams.map[projectId] : undefined;
  return typeof team === "string" ? team : undefined;
}
export const mediaBlobs = (env: Env, projectId: string): BlobStore | undefined =>
  env.BLOBS ? projectMediaStore(r2BlobStore(env.BLOBS), projectId, teamOf(env, projectId)) : projectBlobs(env, projectId, "media");

// The newest document schemaVersion the room accepts in hello: SCHEMA_VERSION when set (to pin a deployment), else the
// Cardboard adapter's CARDBOARD_SCHEMA_VERSION, so a Worker built with an adapter takes that adapter's clients (H-SV).
export function schemaVersionOf(env: Pick<Env, "SCHEMA_VERSION">): number {
  const v = env.SCHEMA_VERSION?.trim();
  if (!v) return CARDBOARD_SCHEMA_VERSION;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`SCHEMA_VERSION must be a positive integer, not ${JSON.stringify(env.SCHEMA_VERSION)}`);
  return n;
}

export class ProjectRoom {
  readonly #ctx: DurableObjectState;
  readonly #env: Env;
  readonly #conns = new Map<CfWebSocket, HostConnection & { state: ConnectionState }>();
  #seq: Sequencer | null = null;
  #projectId: string | null = null;
  #alarmArmed = false;
  #nextId = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#env = env;
    const Pair = (globalThis as unknown as { WebSocketRequestResponsePair?: WebSocketRequestResponsePairCtor }).WebSocketRequestResponsePair;
    if (Pair) ctx.setWebSocketAutoResponse(new Pair("ping", "pong"));
    // after a wake: every socket comes back with its attachment
    for (const ws of ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.auth?.projectId) this.#adopt(ws, att);
    }
  }

  #sequencer(projectId: string): Sequencer {
    if (this.#seq) {
      if (projectId !== this.#projectId) throw new Error(`room for ${this.#projectId} asked to serve ${projectId}`);
      return this.#seq;
    }
    this.#projectId = projectId;
    // remembered for an alarm that wakes the room with no socket attached (1 row, written once per project)
    this.#ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS carton_room (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID");
    this.#ctx.storage.sql.exec("INSERT OR IGNORE INTO carton_room (k, v) VALUES ('project', ?)", projectId);
    const blobs = sequencerBlobs(this.#env, projectId);
    this.#seq = createSequencer({
      storage: doSqlStorage(this.#ctx.storage),
      auth: trusted,
      projectId,
      schemaVersion: schemaVersionOf(this.#env),
      maxEnvelopeBytes: maxEnvelopeOf(this.#env),
      ...(blobs ? { blobs } : {}),
      onEvent: (e) => {
        if (e.type === "accept" && !this.#alarmArmed) void this.#armAlarm();
      },
    });
    return this.#seq;
  }

  #adopt(ws: CfWebSocket, att: Attachment): HostConnection & { state: ConnectionState } {
    const seq = this.#sequencer(att.auth.projectId);
    const conn = {
      id: att.id,
      auth: att.auth,
      state: att.state,
      send(msg: sync.ServerMessage) {
        try {
          // a subscriber whose token expired gets nothing more, even if it never sends (fan-out, presence)
          if (att.auth.expires < Date.now()) return ws.close(4001, "token expired");
          ws.send(JSON.stringify(msg));
        } catch {} // closing: the close handler drops it
      },
    };
    this.#conns.set(ws, conn);
    seq.attach(conn);
    return conn;
  }

  async fetch(req: Request): Promise<Response> {
    const projectId = req.headers.get(PROJECT_HEADER);
    const authJson = req.headers.get(AUTH_HEADER);
    if (!projectId || !authJson) return new Response("the room is reached through the Worker", { status: 400 });
    const auth = JSON.parse(authJson) as AuthContext;
    if (auth.projectId !== projectId) return new Response("token is for another project", { status: 403 });
    const url = new URL(req.url);
    if (url.pathname.endsWith("/ws")) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
      const Pair = (globalThis as unknown as { WebSocketPair: WebSocketPairCtor }).WebSocketPair;
      const pair = new Pair();
      const [client, server] = [pair[0], pair[1]];
      this.#ctx.acceptWebSocket(server);
      const att: Attachment = { id: `${Date.now().toString(36)}-${(++this.#nextId).toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`, auth, state: { subs: [], deadEpoch: -1 } };
      server.serializeAttachment(att);
      this.#adopt(server, att);
      return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": WS_PROTOCOL } } as ResponseInit);
    }
    // the Worker took an envelope upload for this project: make sure the sweep (the alarm) will run, even if no
    // socket ever sends the message it was for
    if (url.pathname.endsWith("/sweep") && req.method === "POST") {
      this.#sequencer(projectId);
      if (!this.#alarmArmed) await this.#armAlarm();
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/alarm") && req.method === "GET") return Response.json({ alarm: await this.#ctx.storage.getAlarm() });
    if (url.pathname.endsWith("/stats") && req.method === "GET") {
      const seq = this.#sequencer(projectId);
      const st = seq.stats;
      return Response.json({
        sockets: this.#conns.size,
        databaseSize: this.#ctx.storage.sql.databaseSize,
        stats: { ...st, rowsRead: st.rowsRead, rowsWritten: st.rowsWritten },
        branches: seq.tables.branchIds(),
      });
    }
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: CfWebSocket, data: string | ArrayBuffer): Promise<void> {
    const conn = this.#conns.get(ws);
    if (!conn) return ws.close(1011, "unknown socket");
    if (conn.auth.expires < Date.now()) return ws.close(4001, "token expired");
    // the cap is in UTF-8 bytes, checked before anything is decoded or parsed
    const cap = maxEnvelopeOf(this.#env);
    if (typeof data === "string" ? utf8Over(data, cap) : data.byteLength > cap) return ws.close(1009, "message too large");
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    let msg: sync.ClientMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      return conn.send({ type: "error", reason: "bad json" });
    }
    const before = conn.state.subs.length + ":" + conn.state.deadEpoch + ":" + conn.state.subs.join(",");
    // a hello may be answered with envelopes (a big catch-up): their sweep runs from the alarm, so arm it as a push does
    if (msg?.type === "hello" && !this.#alarmArmed) void this.#armAlarm();
    await this.#seq!.handle(conn, msg);
    const after = conn.state.subs.length + ":" + conn.state.deadEpoch + ":" + conn.state.subs.join(",");
    // persist the protocol state only when it changed (a hello, a reject): hibernation must not lose it
    if (after !== before) ws.serializeAttachment({ id: conn.id, auth: conn.auth, state: conn.state } satisfies Attachment);
  }

  async webSocketClose(ws: CfWebSocket, code: number): Promise<void> {
    this.#drop(ws);
    try {
      // complete the closing handshake: the runtime doesn't answer a close frame for us
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {}
  }

  async webSocketError(ws: CfWebSocket): Promise<void> {
    this.#drop(ws);
  }

  #drop(ws: CfWebSocket): void {
    const conn = this.#conns.get(ws);
    if (!conn) return;
    this.#conns.delete(ws);
    this.#seq?.disconnect(conn);
  }

  async #armAlarm(): Promise<void> {
    this.#alarmArmed = true;
    if ((await this.#ctx.storage.getAlarm()) === null) await this.#ctx.storage.setAlarm(Date.now() + this.#archiveEveryMs());
  }

  #archiveEveryMs(): number {
    return Number(this.#env.ARCHIVE_EVERY_MS ?? 3600_000);
  }

  async alarm(): Promise<void> {
    if (!this.#seq) {
      // woken by the alarm alone, with no socket to name the project
      let row: Record<string, unknown> | undefined;
      try {
        row = this.#ctx.storage.sql.exec<Record<string, unknown>>("SELECT v FROM carton_room WHERE k = 'project'").toArray()[0];
      } catch {}
      if (!row) return;
      this.#sequencer(row.v as string);
    }
    const seq = this.#seq!;
    if (!sequencerBlobs(this.#env, this.#projectId!)) return;
    const o: { keep?: number; segmentRows?: number } = {};
    if (this.#env.ARCHIVE_KEEP) o.keep = Number(this.#env.ARCHIVE_KEEP);
    if (this.#env.ARCHIVE_SEGMENT) o.segmentRows = Number(this.#env.ARCHIVE_SEGMENT);
    try {
      // archives old rows to gzip segments and sweeps expired envelope blobs
      await seq.maintain(o);
      this.#alarmArmed = false; // re-armed by the next push, hello or envelope upload...
      // ...or now, while envelope blobs remain: they expire hours after they were made, and nothing else may wake
      // the room to sweep them
      const left = await sequencerBlobs(this.#env, this.#projectId!)!.list("messages/", { limit: 1 });
      if (left.blobs.length) await this.#armAlarm();
    } catch {
      await this.#ctx.storage.setAlarm(Date.now() + ALARM_RETRY_MS);
    }
  }
}
