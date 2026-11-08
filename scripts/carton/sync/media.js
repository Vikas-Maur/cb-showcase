// Media for shared projects (H10, PLAN §11): nothing happens for a project that isn't shared.
// - Share (the sharer's library worker): each clip whose original is on this computer is hashed (1 MiB leaves, in
//   worker threads), and its collab proxy goes up through the host's media API (@carton/media shareMedia) as a
//   segmented stream (~2 s fMP4 segments, each uploaded as ffmpeg finishes it): Cardboard's own proxy remuxed when it
//   qualifies, else NVENC → QSV → AMF → libx264. Originals stay here (T3 is opt-in). The clip's shared record (T0:
//   kind, size, duration, its content id and the proxy's) is written to the host as `carton/media/<mediaId>.json`,
//   next to the share descriptor, as soon as the stream is claimed and again when it ends; teammates find it by the
//   clip's media id (why not in project.json: worker.js, "media").
// - Play (a teammate's app): `cardboard-media://media/<id>` for a clip with no file here is answered by main from the
//   range cache (MediaReader: play first, verify each 1 MiB leaf when it completes, on disk in app data), over the
//   host (patches/media.js asks the worker's liveMediaSource where the clip lives). A finished proxy is one fMP4 served
//   by range; one still uploading plays from its start as it grows (a progressive body of verified segments).
// - Tools (ffmpeg-based: grab_frame, filmstrip…): a loopback range server (liveMediaUrl), which hands out verified
//   bytes only: `http://127.0.0.1:<port>/m/<id>?t=<token>` (ffmpeg seeks with Range, so a frame grab fetches what it
//   reads), or for a proxy still uploading `/s/<stream>.m3u8`, a live HLS playlist ffmpeg follows until it ends.
import fs from "node:fs";
import path from "node:path";
import { COLLAB_PROXY_720P, MediaReader, ProxyStreamReader, serveMedia, streamRangeSource, toMediaRecord } from "@carton/media";
import { shareMedia, hostProxyEncoder, defaultEncoderChain, FsLeafCache, FsUploadStateStore, startRangeServer, nodeHasher } from "@carton/media/node";
import { mediaStore } from "./host.js";
import * as store from "./store.js";

export const recordKey = (mediaId) => `carton/media/${encodeURIComponent(mediaId)}.json`;
const exe = (name) => (process.platform === "win32" ? name + ".exe" : name);
// Cardboard's own ffmpeg (resources\bin, beside resources\carton), else the one on PATH.
function tool(name) {
  const env = process.env[`CARDBOARD_${name.toUpperCase()}`];
  if (env) return env;
  const arg = process.argv.find((a) => a.startsWith("--bin-dir="))?.slice("--bin-dir=".length);
  for (const dir of [arg, typeof __dirname === "string" ? path.join(__dirname, "..", "bin") : null]) {
    if (dir && fs.existsSync(path.join(dir, exe(name)))) return path.join(dir, exe(name));
  }
  return name;
}
const cacheRoot = () => path.join(store.syncRoot(), "cache");

/**
 * The host's media scope for a shared project, with the session's token (refreshed as needed). One client per bundle,
 * project and host in this process: media's reuse check remembers a stream it found whole per client object (10 min,
 * media fd87449), so a share after another doesn't check every part of a stream it reuses again. The token is asked for
 * at each request, so a kept client never holds a stale one. A folder Cardboard is done with lets its clients go
 * (forget, from the facade's release).
 */
const clients = new Map(); // `${bundle}|${projectId}|${host}` → {bundlePath, client}
export function storeFor(bundlePath, projectId) {
  const cfg = store.readConfig(bundlePath, projectId);
  if (!cfg) throw new Error("This project isn't shared from this computer");
  const key = `${path.resolve(bundlePath)}|${projectId}|${cfg.host}`;
  let c = clients.get(key);
  if (!c) {
    const session = store.sessionFor(bundlePath, projectId);
    c = { bundlePath, client: mediaStore({ host: cfg.host, projectId, token: () => session.token() }) };
    clients.set(key, c);
  }
  return c.client;
}
/** A client of the host's media scope whose requests `signal` aborts (one read's; storeFor's is kept for reuse). */
function abortableStore(bundlePath, projectId, signal) {
  const cfg = store.readConfig(bundlePath, projectId);
  if (!cfg) throw new Error("This project isn't shared from this computer");
  const session = store.sessionFor(bundlePath, projectId);
  return mediaStore({ host: cfg.host, projectId, token: () => session.token(), fetchFn: (u, i) => fetch(u, { ...(i ?? {}), signal }) });
}
/** The clients of the bundles `inside(bundlePath)` says are in a folder Cardboard is done with go. */
export function forget(inside) {
  for (const [key, c] of clients) if (inside(c.bundlePath)) clients.delete(key);
}

const readEnvelope = (bundlePath) => JSON.parse(fs.readFileSync(path.join(bundlePath, "project.json"), "utf8"));
// Cardboard's proxy for a clip: <bundle>/proxies/<id>.mp4 (1.4.0 names it after the id), when it has made one.
function cardboardProxy(bundlePath, mediaId) {
  const dir = path.join(bundlePath, "proxies");
  const p = path.join(dir, `${mediaId}.mp4`);
  if (fs.existsSync(p)) return p;
  try { const f = fs.readdirSync(dir).find((n) => n.startsWith(mediaId) && n.endsWith(".mp4")); return f ? path.join(dir, f) : null; } catch { return null; }
}
const KINDS = { video: "video", audio: "audio", image: "image" };
// Audio and still images have no collab proxy (the encoders make 720p video): they go up as they are, when no bigger
// than this, so a teammate can hear or see them at all. Video never does (its proxy plays; originals stay opt-in, §11).
const SMALL_ORIGINAL = { audio: 200e6, image: 50e6 };
const MIME = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/**
 * Share one clip. Returns its shared record (T0) or null when its original isn't on this computer (a joined project's
 * clip, a missing file): those are someone else's to share.
 */
export async function shareClip({ bundlePath, projectId, mediaId, envelope = readEnvelope(bundlePath), onEvent, signal }) {
  const rec = envelope.project?.media?.find((m) => m.id === mediaId);
  const original = envelope.media?.find((m) => m.mediaId === mediaId)?.nativePath;
  if (!rec || !original || !fs.existsSync(original)) return null;
  const blobs = storeFor(bundlePath, projectId);
  const d = rec.data ?? {};
  const kind = KINDS[d.type] ?? "other";
  // What the host already has for this clip: shareMedia keeps its proxy when the footage is unchanged.
  const prev = await blobs.get(recordKey(mediaId)).then((b) => (b ? JSON.parse(new TextDecoder().decode(b)).record : null), () => null);
  const size = fs.statSync(original).size, mime = MIME[path.extname(original).toLowerCase()];
  const record = { ...(prev ?? {}), ...toMediaRecord({ id: mediaId, kind, fileName: d.fileName ?? path.basename(original), size, ...(mime ? { mime } : {}), durationSec: d.duration, width: d.width, height: d.height, fps: d.frameRate, hasAudio: d.hasAudio }) };
  const work = path.join(cacheRoot(), "proxies");
  fs.mkdirSync(work, { recursive: true });
  const encoders = kind === "video"
    ? [hostProxyEncoder({ locate: () => cardboardProxy(bundlePath, mediaId), ffprobe: tool("ffprobe") }), ...defaultEncoderChain({ ffmpeg: tool("ffmpeg"), lowPriority: true, tempDir: work })]
    : [];
  // Teammates can play the proxy from its first segment: the record goes up as soon as the stream is claimed.
  const put = (rec) => blobs.put(recordKey(mediaId), new TextEncoder().encode(JSON.stringify({ v: 1, record: rec })), { contentType: "application/json" });
  let hash = null, early = null;
  const events = (e) => {
    if (e.type === "hashed" && e.what === "original") hash = e.hash;
    if (e.type === "proxy" && e.how === "streaming" && hash) early = put({ ...record, hash, proxy: { stream: e.stream, profile: COLLAB_PROXY_720P.id, encoder: "streaming" } }).catch(() => {});
    onEvent?.(e);
  };
  const r = await shareMedia({
    store: blobs,
    record,
    local: { original },
    policy: { originals: size <= (SMALL_ORIGINAL[kind] ?? 0), proxies: kind === "video" },
    encoders,
    workDir: work,
    uploadState: new FsUploadStateStore(path.join(store.projectDir(bundlePath, projectId), "uploads")),
    ffmpeg: tool("ffmpeg"),
    onEvent: events,
    ...(signal ? { signal } : {}),
  });
  await early;
  await put(r.record);
  records.delete(`${projectId}|${mediaId}`);
  return { record: r.record, skipped: r.skipped };
}

// ---------------------------------------------------------------- reading (main, the worker's tools)
const readers = new Map(); // `${host}|${projectId}` → MediaReader
let leafCache = null;
function readerFor(bundlePath, projectId) {
  const cfg = store.readConfig(bundlePath, projectId);
  const key = `${cfg?.host}|${projectId}`;
  let r = readers.get(key);
  if (!r) {
    leafCache ??= new FsLeafCache(path.join(cacheRoot(), "leaves"));
    r = new MediaReader({ store: storeFor(bundlePath, projectId), hasher: nodeHasher, cache: leafCache });
    readers.set(key, r);
  }
  return r;
}

/**
 * Where a clip with no file here lives: its shared record, read from the host. Kept a minute once it is final (a
 * complete proxy, or an original shared as it is); a record without a finished proxy is asked again after 2 s, and
 * none at all after `missMs` (2 s; a wait for a teammate's clip on its way asks sooner: worker.js waitPlayable).
 */
const records = new Map(); // `${projectId}|${mediaId}` → {at, value}
const done = (rec) => (!!rec?.proxy && (rec.proxy.hash || rec.proxy.size !== undefined)) || (!!rec && !rec.proxy && rec.original === "shared" && !!rec.hash);
export async function sharedRecord(bundlePath, projectId, mediaId, { missMs = 2_000, signal } = {}) {
  const k = `${projectId}|${mediaId}`, hit = records.get(k);
  if (hit && Date.now() - hit.at < (done(hit.value) ? 60_000 : hit.value ? 2_000 : missMs)) return hit.value;
  // `signal`: a read its caller may abort (a wait past its deadline: worker.js waitPlayable), through a client of its own
  const b = await (signal ? abortableStore(bundlePath, projectId, signal) : storeFor(bundlePath, projectId)).get(recordKey(mediaId));
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  const value = b ? JSON.parse(new TextDecoder().decode(b)).record : null;
  records.set(k, { at: Date.now(), value });
  return value;
}

/** A clip's shared record if this process has read it already (no request). */
export const cachedRecord = (projectId, mediaId) => records.get(`${projectId}|${mediaId}`)?.value ?? null;

/**
 * What to stream for a clip: its proxy when shared (a segmented stream, `size` once it has ended; or an older
 * whole-object proxy), else its original when that was shared (T3).
 */
export const playable = (record) => {
  const p = record?.proxy;
  if (p?.stream) return { stream: p.stream, size: p.size ?? null, mime: "video/mp4" };
  if (p?.hash) return { hash: p.hash, size: p.size, mime: "video/mp4" };
  return record?.original === "shared" && record.hash ? { hash: record.hash, size: record.size, mime: record.mime ?? "application/octet-stream" } : null;
};

// A stream's reader per project and stream id: its entries are immutable, so it keeps what it has read.
const streams = new Map(); // `${host}|${projectId}|${stream}` → ProxyStreamReader
const streamKey = (bundlePath, projectId, id) => `${store.readConfig(bundlePath, projectId)?.host}|${projectId}|${id}`;
function streamOf(bundlePath, projectId, id) {
  const key = streamKey(bundlePath, projectId, id);
  let r = streams.get(key);
  if (!r) {
    r = new ProxyStreamReader({ store: storeFor(bundlePath, projectId), media: readerFor(bundlePath, projectId), id });
    streams.set(key, r);
  }
  return r;
}
const sourceOf = (bundlePath, projectId, stream, media) => streamRangeSource({ streams: (id) => (id === stream ? streamOf(bundlePath, projectId, id) : null), media });

/**
 * Main's `cardboard-media://` answer for a clip that lives on the host. A whole object, or a stream that has ended: a
 * range response from the cache. A stream still uploading: its segments from the start as they arrive, verified (a
 * fragmented MP4 a media element plays progressively; Range is answered with the whole body until it has ended).
 */
export async function serve(request, src) {
  if (!src.stream) return serveMedia(readerFor(src.bundlePath, src.projectId), src.hash, request, { contentType: src.mime ?? "video/mp4" });
  const reader = streamOf(src.bundlePath, src.projectId, src.stream);
  if (await reader.end()) return serveMedia(sourceOf(src.bundlePath, src.projectId, src.stream, readerFor(src.bundlePath, src.projectId)), src.stream, request);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const headers = { "content-type": "video/mp4", "cache-control": "no-store" };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const ac = new AbortController();
  request.signal?.addEventListener("abort", () => ac.abort(request.signal.reason), { once: true });
  const parts = reader.play({ signal: ac.signal });
  const body = new ReadableStream({
    async pull(ctl) {
      try {
        const r = await parts.next();
        if (r.done) ctl.close();
        else ctl.enqueue(r.value.bytes);
      } catch (e) {
        ctl.error(e);
      }
    },
    async cancel(reason) {
      ac.abort(reason);
      await parts.return?.();
    },
  });
  return new Response(body, { status: 200, headers });
}

// One loopback range server per shared project, for ffmpeg-based tools; verified bytes only. A finished stream reads
// as one fMP4 at /m/<stream>; one still uploading as a live HLS playlist at /s/<stream>.m3u8.
const servers = new Map(); // bundlePath → Promise<RangeServer>
export async function toolUrl(bundlePath, projectId, src) {
  let s = servers.get(bundlePath);
  if (!s) {
    const tools = readerFor(bundlePath, projectId).toolSource();
    s = startRangeServer({
      // Only ids a clip's record named as a stream are streams; anything else is a whole object.
      source: streamRangeSource({ streams: (id) => streams.get(streamKey(bundlePath, projectId, id)) ?? null, media: tools }),
      playlist: (id, urlFor) => streamOf(bundlePath, projectId, id).playlist(urlFor),
      // A segment a tool read through a playlist (its URL names the stream) that doesn't verify: the stream is reported
      // damaged on the host (bad/<stream>), so the sharer's next share makes a new one. The reader ignores a hash that
      // isn't one of its parts.
      reportDamage: (stream, hash) => streamOf(bundlePath, projectId, stream).reportPartDamage(hash),
      // A part simply gone from the host (media d9f9a5f): the reader reports the stream only if a HEAD finds it still gone.
      reportMissing: (stream, hash) => streamOf(bundlePath, projectId, stream).reportPartDamage(hash, "missing"),
      unref: true,
    });
    servers.set(bundlePath, s);
    s.catch(() => servers.delete(bundlePath));
  }
  const server = await s;
  if (!src.stream) return server.url(src.hash);
  const reader = streamOf(bundlePath, projectId, src.stream);
  return (await reader.end()) ? server.url(src.stream) : server.playlistUrl(src.stream);
}
export async function closeServers() {
  for (const s of servers.values()) await (await s).close().catch(() => {});
  servers.clear();
}
