// ProjectRoom: one SQLite-backed Durable Object per project, hosting `createSequencer` (PLAN §3, §6.3, §17). It is
// storage plus socket glue: no ordering, validation or overlap logic lives here.
//
// - WebSocket Hibernation API: the room accepts sockets with `ctx.acceptWebSocket` and sets no timers, so it can be
//   evicted between messages. Each socket's attachment holds its verified AuthContext and its protocol state (the
//   branches it follows, its dead epoch); after a wake the constructor re-attaches every socket with that state, so
//   fan-out still reaches them.
// - Keepalive: a text frame `ping` is answered `pong` by the runtime without waking the room.
// - Presence leaves: when a socket closes, the sequencer sends its peers `state: null` for each actor it showed
//   (ConnectionState.shown, kept in the attachment, so a close after a wake still owes them). A socket that shows
//   presence and goes silent (no messages, no `ping`) for PRESENCE_TIMEOUT_MS is closed from the alarm, which runs
//   for that only while some socket shows presence; its last message's time rides in the attachment, so a wake is
//   not taken for its activity. The alarm's maintenance keeps its own due time (`carton_room.maintain_at`), so a
//   presence check never runs maintenance early; a room whose alarm predates that row takes the alarm as its due time.
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
import { cappedBlobStore, reserveIn, writeCapOf, WRITE_CAP_PATH } from "./write-cap.ts";
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
  /** When the socket last sent a message (to SEEN_GRAIN_MS), so a wake doesn't count as the socket's activity. */
  seen?: number;
}

// A socket's last-message time is written to its attachment at most this often: the presence timeout judges a socket
// at most this much early after a wake (the runtime keeps the `ping` auto-response time exactly).
const SEEN_GRAIN_MS = 1000;

// The room never verifies tokens itself (the Worker did, and the sequencer only reads `conn.auth`); this provider
// only fills createSequencer's option.
const trusted: AuthProvider = { kind: "worker-verified", verify: async () => null };

// One project's blobs, in two scopes no route can cross: the sequencer's keyframes, segments and large change bodies
// under `projects/<p>/seq/`, and the media the HTTP API signs and uploads under `projects/<p>/media/`. An editor
// can write media, never the sequencer's records (which may belong to a cut they may not write).
// Both sit on the physical store wrapped by the deployment's daily write cap (write-cap.ts; off unless configured).
function projectBlobs(env: Env, projectId: string, scope: "seq" | "media"): BlobStore | undefined {
  if (env.BLOBS) return scopedBlobStore(cappedBlobStore(r2BlobStore(env.BLOBS), writeCapOf(env)), `projects/${projectId}/${scope}/`);
  if (env.BLOB_VAULT) return scopedBlobStore(cappedBlobStore(doBlobStore(env.BLOB_VAULT, projectId), writeCapOf(env)), `${scope}/`);
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
// A team's grants (host-http team.ts: which team media a project may read) are outside the write cap: an editor's HEAD
// claims, so a grant is written by a read, and a cap reached must not stop editors reading media their project can
// read. They can't fill a bucket: each is an empty object, at most one per project and hash the team already holds,
// and a claim of a granted hash writes nothing.
export function mediaBlobs(env: Env, projectId: string): BlobStore | undefined {
  if (!env.BLOBS) return projectBlobs(env, projectId, "media");
  const r2 = r2BlobStore(env.BLOBS);
  return projectMediaStore(cappedBlobStore(r2, writeCapOf(env)), projectId, teamOf(env, projectId), { grants: r2 });
}

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
  /** When each socket last sent anything (or was accepted), and the time its attachment holds. */
  #seen = new WeakMap<CfWebSocket, number>();
  #seenSaved = new WeakMap<CfWebSocket, number>();
  /** The alarm this instance set for the presence check, while it is pending. */
  #presenceCheckAt: number | null = null;
  /** Maintenance's due time is recorded (see #recordLegacyDue). */
  #dueKnown = false;

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
    // after a wake, the time the attachment kept: a wake is not the socket's activity. An attachment from before
    // `seen` gets the wake's time, written back: the next wake must not give it a fresh one again
    const seen = att.seen ?? Date.now();
    if (att.seen === undefined) {
      try {
        ws.serializeAttachment({ ...att, seen } satisfies Attachment);
      } catch {} // a socket already closing: dropped by its close
    }
    this.#seen.set(ws, seen);
    this.#seenSaved.set(ws, seen);
    seq.attach(conn);
    return conn;
  }

  async fetch(req: Request): Promise<Response> {
    const url0 = new URL(req.url);
    // open creation's daily count (one room per UTC day, named `open-create/<day>`: never a project's, whose ids have
    // no slash). Only the Worker reaches a room, so only it counts.
    if (url0.pathname === "/open-create/count" && req.method === "POST") {
      const { client, max } = (await req.json()) as { client: string; max: number };
      const sql = this.#ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS carton_open_create (client TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID");
      const n = Number(sql.exec<{ n: number }>("SELECT n FROM carton_open_create WHERE client = ?", client).toArray()[0]?.n ?? 0);
      if (n >= max) return Response.json({ ok: false });
      sql.exec("INSERT OR REPLACE INTO carton_open_create (client, n) VALUES (?, ?)", client, n + 1);
      return Response.json({ ok: true });
    }
    // the deployment's daily write cap (write-cap.ts): one room per UTC day, named `write-cap/<day>`, reached only by
    // the Worker and its rooms
    if (url0.pathname === WRITE_CAP_PATH && req.method === "POST")
      return Response.json(reserveIn(this.#ctx.storage.sql, (await req.json()) as { bytes: number; ops: number; maxBytes: number; maxOps: number }));
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
      const att: Attachment = { id: `${Date.now().toString(36)}-${(++this.#nextId).toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`, auth, state: { subs: [], deadEpoch: -1 }, seen: Date.now() };
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
    // open creation's claim: this project id is new (never claimed, no cut on the host) and is claimed now. `mark`
    // records it without asking (an admin invite made the project).
    if (url.pathname.endsWith("/claim") && req.method === "POST") {
      const seq = this.#sequencer(projectId);
      const sql = this.#ctx.storage.sql;
      const used = sql.exec("SELECT v FROM carton_room WHERE k = 'claimed'").toArray().length > 0 || seq.tables.branchIds().length > 0;
      if (!used) sql.exec("INSERT OR IGNORE INTO carton_room (k, v) VALUES ('claimed', ?)", String(Date.now()));
      return Response.json({ taken: used });
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
    const now = Date.now();
    this.#seen.set(ws, now);
    const before = stateKey(conn.state);
    // a hello may be answered with envelopes (a big catch-up): their sweep runs from the alarm, so arm it as a push does
    if (msg?.type === "hello" && !this.#alarmArmed) void this.#armAlarm();
    await this.#seq!.handle(conn, msg);
    // persist the protocol state when it changed (a hello, a reject, presence shown or withdrawn), and the time of
    // this message once a grain has passed: hibernation must lose neither
    if (stateKey(conn.state) !== before || now - (this.#seenSaved.get(ws) ?? 0) >= SEEN_GRAIN_MS) {
      ws.serializeAttachment({ id: conn.id, auth: conn.auth, state: conn.state, seen: now } satisfies Attachment);
      this.#seenSaved.set(ws, now);
    }
    if (conn.state.shown?.length) await this.#armPresenceCheck();
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

  // Maintenance (archiving, the envelope sweep) is wanted by a push, a hello or an envelope upload, and due
  // ARCHIVE_EVERY_MS after the first of them. Its due time is a row, since the presence check shares the one alarm.
  async #armAlarm(): Promise<void> {
    this.#alarmArmed = true;
    await this.#recordLegacyDue();
    const due = this.#maintainAt();
    if (due !== null && due > 0) return this.#alarmBy(due);
    const at = Date.now() + this.#archiveEveryMs();
    this.#setMaintainAt(at);
    await this.#alarmBy(at);
  }

  /** Maintenance's due time: a time, 0 for none wanted, null if never recorded (an alarm armed before this row). */
  #maintainAt(): number | null {
    try {
      const row = this.#ctx.storage.sql.exec<Record<string, unknown>>("SELECT v FROM carton_room WHERE k = 'maintain_at'").toArray()[0];
      return row ? Number(row.v) : null;
    } catch {
      return null;
    }
  }

  // A room whose alarm was set before maintenance kept its due time (code from before `maintain_at`) has that alarm
  // for maintenance: it becomes the due time before anything moves the alarm, or a presence check brought forward
  // would run maintenance early, and an envelope upload would record a later time and hold maintenance past it.
  async #recordLegacyDue(): Promise<void> {
    if (this.#dueKnown) return;
    try {
      if (this.#maintainAt() === null) this.#setMaintainAt((await this.#ctx.storage.getAlarm()) ?? 0);
      this.#dueKnown = true;
    } catch {} // no room row yet: nothing was ever due
  }

  #setMaintainAt(at: number): void {
    this.#ctx.storage.sql.exec("INSERT OR REPLACE INTO carton_room (k, v) VALUES ('maintain_at', ?)", String(at));
  }

  /** Makes sure the alarm fires by `at`: sets it unless one is already due sooner. */
  async #alarmBy(at: number): Promise<void> {
    const cur = await this.#ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.#ctx.storage.setAlarm(at);
  }

  #presenceTimeoutMs(): number {
    const v = Number(this.#env.PRESENCE_TIMEOUT_MS ?? 120_000);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  // While a socket shows presence, the alarm checks every half timeout for sockets gone silent.
  async #armPresenceCheck(): Promise<void> {
    const timeout = this.#presenceTimeoutMs();
    if (!timeout) return;
    const now = Date.now();
    if (this.#presenceCheckAt !== null && this.#presenceCheckAt > now) return;
    await this.#recordLegacyDue();
    const at = now + Math.ceil(timeout / 2);
    await this.#alarmBy(at);
    this.#presenceCheckAt = at;
  }

  /** Closes every socket that shows presence and has been silent past the timeout; true if any showing one is left. */
  #checkPresence(now: number): boolean {
    const timeout = this.#presenceTimeoutMs();
    if (!timeout) return false;
    let showing = false;
    for (const [ws, conn] of [...this.#conns]) {
      if (!conn.state.shown?.length) continue;
      const pinged = this.#ctx.getWebSocketAutoResponseTimestamp?.(ws)?.getTime() ?? 0;
      if (now - Math.max(this.#seen.get(ws) ?? 0, pinged) <= timeout) {
        showing = true;
        continue;
      }
      try {
        ws.close(1001, "keepalive timed out");
      } catch {}
      this.#drop(ws); // its leaves go out now; the runtime's close event finds it gone
    }
    return showing;
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
    const now = Date.now();
    this.#presenceCheckAt = null;
    const showing = this.#checkPresence(now);
    const due = this.#maintainAt();
    // null: an alarm armed before maintenance kept its due time, so it runs as it always did
    if (due === null || (due > 0 && due <= now)) await this.#maintain();
    // the next alarm, set outright (the one now running may still read as pending): the sooner of the two wants
    const next: number[] = [];
    if (showing) next.push((this.#presenceCheckAt = now + Math.ceil(this.#presenceTimeoutMs() / 2)));
    const still = this.#maintainAt();
    if (still !== null && still > 0) next.push(Math.max(still, now + 1000));
    if (next.length) await this.#ctx.storage.setAlarm(Math.min(...next));
  }

  async #maintain(): Promise<void> {
    const seq = this.#seq!;
    if (!sequencerBlobs(this.#env, this.#projectId!)) return this.#setMaintainAt(0);
    const o: { keep?: number; segmentRows?: number } = {};
    if (this.#env.ARCHIVE_KEEP) o.keep = Number(this.#env.ARCHIVE_KEEP);
    if (this.#env.ARCHIVE_SEGMENT) o.segmentRows = Number(this.#env.ARCHIVE_SEGMENT);
    try {
      // archives old rows to gzip segments and sweeps expired envelope blobs
      await seq.maintain(o);
      this.#setMaintainAt(0);
      this.#alarmArmed = false; // re-armed by the next push, hello or envelope upload...
      // ...or now, while envelope blobs remain: they expire hours after they were made, and nothing else may wake
      // the room to sweep them
      const left = await sequencerBlobs(this.#env, this.#projectId!)!.list("messages/", { limit: 1 });
      if (left.blobs.length) await this.#armAlarm();
    } catch {
      // still due: retried
      this.#setMaintainAt(Date.now() + ALARM_RETRY_MS);
    }
  }
}

/** What of a connection's state the attachment must keep up with (all of it: a wake restores only the attachment). */
const stateKey = (s: ConnectionState) => `${s.deadEpoch}|${s.envelopes ? 1 : 0}|${s.comments ? 1 : 0}|${s.subs.join(",")}|${JSON.stringify(s.shown ?? null)}|${JSON.stringify(s.identity ?? null)}`;
