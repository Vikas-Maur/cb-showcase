// Media for shared projects (H10, PLAN §11): nothing happens for a project that isn't shared.
// - Share (the sharer's library worker): each clip whose original is on this computer is hashed (1 MiB leaves, in
//   worker threads), and its collab proxy goes up through the host's media API with resumable multipart
//   (@carton/media shareMedia): Cardboard's own proxy when it qualifies, else NVENC → QSV → AMF → libx264. Originals
//   stay here (T3 is opt-in). The clip's shared record (T0: kind, size, duration, its content id and the proxy's) is
//   written to the host as `carton/media/<mediaId>.json`, next to the share descriptor; teammates find it by the
//   clip's media id (why not in project.json: worker.js, "media").
// - Play (a teammate's app): `cardboard-media://media/<id>` for a clip with no file here is answered by main from the
//   range cache (MediaReader: play first, verify each 1 MiB leaf when it completes, on disk in app data), over the
//   host (patches/media.js asks the worker's liveMediaSource where the clip lives).
// - Tools (ffmpeg-based: grab_frame, filmstrip…): a loopback range server, `http://127.0.0.1:<port>/m/<hash>?t=<token>`,
//   which hands out verified bytes only (liveMediaUrl). ffmpeg seeks with Range, so a frame grab fetches what it reads.
import fs from "node:fs";
import path from "node:path";
import { MediaReader, serveMedia, toMediaRecord } from "@carton/media";
import { shareMedia, hostProxyEncoder, defaultEncoderChain, FsLeafCache, FsUploadStateStore, startRangeServer, nodeHasher } from "@carton/media/node";
import { hostBlobStore } from "./host-blobs.js";
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

/** The host's media scope for a shared project, with the session's token (refreshed as needed). */
export function storeFor(bundlePath, projectId) {
  const cfg = store.readConfig(bundlePath, projectId);
  if (!cfg) throw new Error("This project isn't shared from this computer");
  const session = store.sessionFor(bundlePath, projectId);
  return hostBlobStore({ origin: cfg.host, projectId, token: () => session.token() });
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
  const record = { ...(prev ?? {}), ...toMediaRecord({ id: mediaId, kind, fileName: d.fileName ?? path.basename(original), size: fs.statSync(original).size, durationSec: d.duration, width: d.width, height: d.height, fps: d.frameRate, hasAudio: d.hasAudio }) };
  const work = path.join(cacheRoot(), "proxies");
  fs.mkdirSync(work, { recursive: true });
  const encoders = kind === "video"
    ? [hostProxyEncoder({ locate: () => cardboardProxy(bundlePath, mediaId), ffprobe: tool("ffprobe") }), ...defaultEncoderChain({ ffmpeg: tool("ffmpeg"), lowPriority: true, tempDir: work })]
    : [];
  const r = await shareMedia({
    store: blobs,
    record,
    local: { original },
    policy: { originals: false, proxies: kind === "video" },
    encoders,
    workDir: work,
    uploadState: new FsUploadStateStore(path.join(store.projectDir(bundlePath, projectId), "uploads")),
    ...(onEvent ? { onEvent } : {}),
    ...(signal ? { signal } : {}),
  });
  await blobs.put(recordKey(mediaId), new TextEncoder().encode(JSON.stringify({ v: 1, record: r.record })), { contentType: "application/json" });
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
    r = new MediaReader({ store: storeFor(bundlePath, projectId), hasher: nodeHasher, cache: leafCache, contentType: () => "video/mp4" });
    readers.set(key, r);
  }
  return r;
}

/** Where a clip with no file here lives: its shared record, read from the host (cached for a minute). */
const records = new Map(); // `${projectId}|${mediaId}` → {at, value}
export async function sharedRecord(bundlePath, projectId, mediaId) {
  const k = `${projectId}|${mediaId}`, hit = records.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const b = await storeFor(bundlePath, projectId).get(recordKey(mediaId));
  const value = b ? JSON.parse(new TextDecoder().decode(b)).record : null;
  records.set(k, { at: Date.now(), value });
  return value;
}

/** What to stream for a clip: its proxy when shared, else its original when that was shared (T3). */
export const playable = (record) => (record?.proxy ? { hash: record.proxy.hash, size: record.proxy.size, mime: "video/mp4" } : record?.original === "shared" && record.hash ? { hash: record.hash, size: record.size, mime: record.mime ?? "application/octet-stream" } : null);

/** Main's `cardboard-media://` answer for a clip that lives on the host: a range response from the cache. */
export async function serve(request, src) {
  return serveMedia(readerFor(src.bundlePath, src.projectId), src.hash, request);
}

// One loopback range server per shared project, for ffmpeg-based tools; verified bytes only.
const servers = new Map();
export async function toolUrl(bundlePath, projectId, hash) {
  let s = servers.get(bundlePath);
  if (!s) {
    s = startRangeServer({ source: readerFor(bundlePath, projectId).toolSource(), unref: true });
    servers.set(bundlePath, s);
    s.catch(() => servers.delete(bundlePath));
  }
  return (await s).url(hash);
}
export async function closeServers() {
  for (const s of servers.values()) await (await s).close().catch(() => {});
  servers.clear();
}
