// Adding video from the browser (PLAN §11, the web demo standing on its own): a file the browser can play (MP4/H.264,
// WebM) goes up as it is; nothing is encoded here. In order:
//   1. checked: under the host's largest upload, and playable here (its metadata loads in a <video>); else a plain no;
//   2. hashed in the browser (@carton/media's manifest: the same content id as everywhere, so a teammate's copy of the
//      same file is found and not sent again);
//   3. on the timeline at once: its media record (content hash, name, length) and a clip at the end of the video
//      track, in one commit; it plays here from the file itself, and a poster and filmstrip go up for the timeline;
//   4. up: the manifest, then the file in pieces teammates play while it uploads (pieces.ts), then the whole file
//      through @carton/media's resumable multipart upload (skipped when the host already has it), then the pieces go.

import type { Carton, Actor, Doc, Op, Rec } from "@carton/core";
import { manifestKey, mediaHash, uploadMedia, webCryptoHasher, blobSource } from "@carton/media";
import { ITEMS, MEDIA, TRACKS } from "./demo-doc.ts";
import { httpBlobStore } from "./http-blobs.ts";
import { moovSpan, pieceKey, pieceSizeFor, piecesInfoKey, playbackOrder, type PiecesInfo } from "./pieces.ts";
import type { Session } from "./session.ts";

export interface UploadJob {
  id: string;
  name: string;
  phase: "checking" | "uploading" | "done" | "failed";
  /** Bytes up, of `total` (pieces and the whole file: twice the file's size). */
  done: number;
  total: number;
  error?: string;
}

/** The uploads this page runs, for the progress chip. */
export class Uploads {
  #jobs: UploadJob[] = [];
  #ls = new Set<() => void>();
  get = (): readonly UploadJob[] => this.#jobs;
  subscribe = (l: () => void) => (this.#ls.add(l), () => void this.#ls.delete(l));
  set(job: UploadJob): void {
    this.#jobs = [...this.#jobs.filter((j) => j.id !== job.id), job];
    for (const l of this.#ls) l();
  }
  drop(id: string): void {
    this.#jobs = this.#jobs.filter((j) => j.id !== id);
    for (const l of this.#ls) l();
  }
}

const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const MB = 1024 * 1024;
const megabytes = (n: number) => `${Math.round(n / MB)} MB`;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;

/** What a file plays as here: its length and picture size, or why not. */
export async function probe(file: File, timeoutMs = 15_000): Promise<{ duration: number; width: number; height: number; url: string }> {
  const no = () => new Error(`“${file.name}” can't play in a browser. Add an MP4 (H.264) or WebM video.`);
  const v = document.createElement("video");
  if (file.type ? !file.type.startsWith("video/") : !VIDEO_EXT.test(file.name)) throw no();
  const url = URL.createObjectURL(file);
  // a first frame decoded, not only the header read: a codec this browser lacks (HEVC, ProRes) fails here
  v.preload = "auto";
  v.muted = true;
  try {
    await new Promise<void>((ok, fail) => {
      const t = setTimeout(() => fail(no()), timeoutMs);
      v.onloadeddata = () => (clearTimeout(t), ok());
      v.onerror = () => (clearTimeout(t), fail(no()));
      v.src = url;
    });
    if (!(v.duration > 0) || !Number.isFinite(v.duration) || !v.videoWidth) throw no();
    return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, url };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

/** A poster (one frame) and a filmstrip (eight frames side by side, 96 px high: the seed's shape) drawn in a canvas. */
async function stills(url: string, duration: number): Promise<{ poster: Blob | null; filmstrip: Blob | null }> {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = url;
  await new Promise<void>((ok, fail) => ((v.onloadeddata = () => ok()), (v.onerror = () => fail(new Error("no frame")))));
  const at = (t: number) => new Promise<void>((ok) => ((v.onseeked = () => ok()), (v.currentTime = Math.min(Math.max(0, t), Math.max(0, duration - 0.05)))));
  const jpeg = (c: HTMLCanvasElement) => new Promise<Blob | null>((ok) => c.toBlob((b) => ok(b), "image/jpeg", 0.8));
  const ratio = v.videoWidth / v.videoHeight || 16 / 9;
  const poster = document.createElement("canvas");
  poster.width = 320;
  poster.height = Math.round(320 / ratio);
  await at(Math.min(1, duration / 2));
  poster.getContext("2d")!.drawImage(v, 0, 0, poster.width, poster.height);
  const FRAMES = 8, H = 96, W = Math.round(H * ratio);
  const strip = document.createElement("canvas");
  strip.width = W * FRAMES;
  strip.height = H;
  const g = strip.getContext("2d")!;
  for (let i = 0; i < FRAMES; i++) {
    await at(((i + 0.5) * duration) / FRAMES);
    g.drawImage(v, i * W, 0, W, H);
  }
  const out = { poster: await jpeg(poster), filmstrip: await jpeg(strip) };
  v.removeAttribute("src");
  v.load();
  return out;
}

/** Ops that put a new clip of `mediaId` at the end of the first video track, with its media record. */
export function addClipOps(doc: Doc, media: { id: string; hash: string; fileName: string; duration: number; size: number; width: number; height: number }, clipId: string): Op[] {
  const tracks = (doc[TRACKS] ?? []) as Rec[];
  const track = tracks.find((t) => t.type === "video");
  if (!track) throw new Error("This project has no video track to put the clip on.");
  const items = ((doc[ITEMS] ?? []) as Rec[]).filter((r) => r.trackId === track.id);
  const start = Math.round(Math.max(0, ...items.map((r) => Number(r.endTime) || 0)) * 10) / 10;
  const len = Math.round(media.duration * 1000) / 1000;
  const name = media.fileName.replace(/\.[^.]+$/, "") || media.fileName;
  const rec: Rec = { id: media.id, contentHash: media.hash, data: { fileName: media.fileName, type: "video", duration: len, size: media.size, width: media.width, height: media.height } };
  const clip: Rec = { id: clipId, type: "video", trackId: track.id, name, mediaItemId: media.id, startTime: start, endTime: Math.round((start + len) * 1000) / 1000, trimStart: 0, trimEnd: len, playbackSpeed: 1, volume: 100, opacity: 1 };
  return [
    { op: "insert", path: [MEDIA, media.id], value: rec },
    { op: "insert", path: [ITEMS, clipId], value: clip },
  ];
}

export interface AddVideoOptions {
  file: File;
  session: Session;
  carton: Carton;
  me: Actor;
  /** The head now (where the clip goes). */
  doc: () => Doc;
  /** The host's largest upload, if it has one. */
  maxUploadBytes: number | null;
  /** Media this page plays from local files, by hash (the uploader's own copy plays at once). */
  local: Map<string, string>;
  jobs: Uploads;
  baseUrl: string;
  /** After the commit: the page refreshes its view. */
  committed?: () => void;
  /** The clip's poster and filmstrip are up: views showing it ask for them again. */
  stillsUp?: () => void;
}

/** Add one video file: checked, hashed, on the timeline, then up. Throws a plain message when it can't be added. */
export async function addVideo(o: AddVideoOptions): Promise<void> {
  const { file } = o;
  const id = hex(6);
  if (o.maxUploadBytes !== null && file.size > o.maxUploadBytes) throw new Error(`“${file.name}” is ${megabytes(file.size)}: this host takes files up to ${megabytes(o.maxUploadBytes)}.`);
  o.jobs.set({ id, name: file.name, phase: "checking", done: 0, total: file.size * 2 });
  let p: Awaited<ReturnType<typeof probe>>;
  try {
    p = await probe(file);
  } catch (e) {
    o.jobs.drop(id);
    throw e;
  }
  const hasher = webCryptoHasher();
  const manifest = await mediaHash(file, hasher);
  const hash = manifest.hash;
  o.local.set(hash, p.url);
  const mediaId = `media-${hex(6)}`;
  const r = await o.carton.commit({ ops: addClipOps(o.doc(), { id: mediaId, hash, fileName: file.name, duration: p.duration, size: file.size, width: p.width, height: p.height }, `clip-${hex(6)}`), author: o.me });
  if (r.status === "rejected") throw new Error(`The server refused the new clip: ${r.reason}`);
  o.committed?.();

  const store = httpBlobStore({ baseUrl: o.baseUrl, projectId: o.session.projectId, token: () => o.session.token() });
  const contentType = file.type || (/\.webm$/i.test(file.name) ? "video/webm" : "video/mp4");
  const job = (j: Partial<UploadJob>) => o.jobs.set({ id, name: file.name, phase: "uploading", done: 0, total: file.size * 2, ...j });
  try {
    // the timeline's pictures (best effort: a clip shows without them)
    void stills(p.url, p.duration)
      .then(async (s) => {
        if (s.poster) await store.put(`t1/${hash}/poster.jpg`, new Uint8Array(await s.poster.arrayBuffer()), { contentType: "image/jpeg", ifAbsent: true });
        if (s.filmstrip) await store.put(`t1/${hash}/filmstrip.jpg`, new Uint8Array(await s.filmstrip.arrayBuffer()), { contentType: "image/jpeg", ifAbsent: true });
        o.stillsUp?.();
      })
      .catch(() => {});
    // a teammate's copy of the same file is already there: nothing to send (team dedup)
    if (await store.head(`m/${hash}`)) return job({ phase: "done", done: file.size * 2 });
    job({ done: 0 });
    await store.put(manifestKey(hash), manifest.bytes, { contentType: "application/octet-stream", ifAbsent: true });
    const pieceSize = pieceSizeFor(file.size);
    const info: PiecesInfo = { v: 1, size: file.size, pieceSize, pieces: Math.ceil(file.size / pieceSize) };
    await store.put(piecesInfoKey(hash), new TextEncoder().encode(JSON.stringify(info)), { contentType: "application/json", ifAbsent: true });
    let sent = 0;
    for (const n of playbackOrder(info.pieces, pieceSize, await moovSpan(file))) {
      const bytes = new Uint8Array(await file.slice(n * pieceSize, (n + 1) * pieceSize).arrayBuffer());
      await store.put(pieceKey(hash, n), bytes, { contentType: "application/octet-stream", ifAbsent: true });
      job({ done: (sent += bytes.length) });
    }
    await uploadMedia({ store, hasher, source: blobSource(file), manifest, contentType, onProgress: (u) => job({ done: file.size + u.done }) });
    await o.session.api("/blobs/pieces-done", { hash }).catch(() => {}); // the pieces are redundant now
    job({ phase: "done", done: file.size * 2 });
  } catch (e) {
    job({ phase: "failed", error: (e as Error).message });
    throw new Error(`“${file.name}” didn't finish uploading: ${(e as Error).message}. It stays on the timeline, and plays for you until you reload.`);
  }
}
