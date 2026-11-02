// Sharing one clip (PLAN §11): carries out planShare for the tiers that must move, and returns the updated T0 record.
//   - The original is hashed first (lazily, through the scheduler when there is one): its id names the clip and keys
//     its proxy.
//   - T1 files are hashed and uploaded (deduped, so a poster two clips share goes up once).
//   - T2: a proxy a teammate already made for this source and profile is reused through its pointer (no encode, no
//     upload). Else this share claims the pointer and makes the proxy as a segmented stream (stream.ts, e2e S5-1): the
//     host's own proxy remuxed into segments when it qualifies, else the encoder chain encoding segments. Each segment
//     goes up as soon as ffmpeg finishes it, so a teammate plays the first ones while the rest encode and upload; the
//     stream id is reported (ShareEvent "streaming") before the first segment, for the app to publish.
//     `proxyStreams: false` keeps the older whole-object proxy (encoded to `workDir`, hashed, uploaded, pointed at).
//   - T3 only with the owner's opt-in or a teammate's request.

import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BlobStore, Hasher, ProxyEncoder } from "../contracts.ts";
import { isDamaged, reportDamage } from "../damage.ts";
import { proxyPointerKey, type ProxyPointer } from "../keys.ts";
import { claimProxyStream, newStreamId, ProxyStreamReader, ProxyStreamWriter, usableProxy } from "../stream.ts";
import { MediaReader } from "../read.ts";
import type { Manifest } from "../manifest.ts";
import { COLLAB_PROXY_720P, encodeProxy, ProxyChainError, type CollabProfile, type ProxyAttempt } from "../proxy.ts";
import { CHAIN_ORDER, type FfmpegCodec } from "./ffmpeg-encoder.ts";
import { encodeSegments } from "./segment-encoder.ts";
import type { HashScheduler } from "../scheduler.ts";
import { CONTEXT_CAP_BYTES, planShare, type MediaRecord, type SharePolicy, type T1Kind } from "../tiers.ts";
import { SourceChangedError, uploadMedia, type UploadResult, type UploadStateStore } from "../upload.ts";
import { fileSource } from "./file-source.ts";
import { hashFile } from "./hash-file.ts";
import { nodeHasher } from "./node-hasher.ts";

export type ShareEvent =
  | { type: "hashed"; what: string; hash: string }
  | { type: "uploaded"; what: string; result: UploadResult }
  /** "streaming": the proxy's stream is claimed and its first segment is on the way; the rest say how it was made. */
  | { type: "proxy"; how: "teammate's" | "host's" | "encoded" | "streaming"; hash?: string; stream?: string; attempts?: ProxyAttempt[] }
  | { type: "skipped"; what: string; why: string }
  /** The host refused writes for a while (its daily write limit): the proxy's upload waits until `until` (ms epoch), kept. */
  | { type: "waiting"; what: string; until: number };

/** What makes a stream's segments (segment-encoder.ts's encodeSegments; tests pass a fake). */
export type Segmenter = (o: {
  input: string;
  dir: string;
  profile: CollabProfile;
  codec: FfmpegCodec | "copy";
  ffmpeg?: string | readonly string[];
  signal?: AbortSignal;
  onInit: (path: string) => Promise<void>;
  onSegment: (s: { index: number; path: string; durationSec: number }) => Promise<void>;
}) => Promise<{ segments: number; durationSec: number }>;

export interface ShareMediaOptions {
  store: BlobStore;
  hasher?: Hasher;
  record: MediaRecord;
  /** Local files for this clip. Absent entries are not on this machine. */
  local: { original?: string; t1?: Partial<Record<T1Kind, string>> };
  policy: SharePolicy;
  /** Proxy encoders in order: the host's proxy first (it must offer `reusable`), then NVENC → QSV → AMF → libx264. */
  encoders: readonly ProxyEncoder[];
  profile?: CollabProfile;
  /** Where encoded proxies are written (the media cache). */
  workDir: string;
  /** Hashes through the app's scheduler (shared work, manifest cache); `hashFile` when absent. */
  scheduler?: HashScheduler;
  uploadState?: UploadStateStore;
  bytesPerSecond?: number;
  signal?: AbortSignal;
  onEvent?: (e: ShareEvent) => void;
  /** Collab proxies as segmented streams a teammate plays while they upload (default), or one object (`false`). */
  proxyStreams?: boolean;
  /** The ffmpeg that segments (Cardboard's own on desktop). */
  ffmpeg?: string | readonly string[];
  segmenter?: Segmenter;
  /** A claimed stream with no new segment for this long, and no end, is taken over by the next share. Default 10 min. */
  staleMs?: number;
}

export interface ShareMediaResult {
  record: MediaRecord;
  skipped: { what: string; why: string }[];
}

/** A local file couldn't be opened for upload (as opposed to the store failing). */
class LocalFileError extends Error {
  override name = "LocalFileError";
}

interface Reuser {
  reusable(input: { path: string }, opts?: { signal?: AbortSignal }): Promise<string | null>;
}
const canReuse = (e: ProxyEncoder): e is ProxyEncoder & Reuser => typeof (e as Partial<Reuser>).reusable === "function";

export async function shareMedia(o: ShareMediaOptions): Promise<ShareMediaResult> {
  const hasher = o.hasher ?? nodeHasher;
  const profile = o.profile ?? COLLAB_PROXY_720P;
  const record: MediaRecord = { ...o.record, t1: { ...o.record.t1 } };
  const hash = async (path: string): Promise<Manifest> => {
    o.signal?.throwIfAborted();
    if (!o.scheduler) return hashFile(path, { signal: o.signal });
    const st = await stat(path);
    return o.scheduler.request({ key: path, size: st.size, mtimeMs: st.mtimeMs }, "share");
  };

  // Shared objects a reader reported damaged (bad/<hash>, e2e S5-5) count as not shared: they are planned again, and
  // their upload replaces the stored copy instead of deduping on it. A damaged proxy stream is made anew.
  const reported = async (id: string | undefined) => id !== undefined && (await isDamaged(o.store, id).catch(() => false));
  // (The proxy is checked further down, through its pointer, once the record's hash is known.)
  if (record.proxy && record.hash === undefined && (await reported(record.proxy.stream ?? record.proxy.hash))) delete record.proxy;
  if (record.original === "shared" && (await reported(record.hash))) delete record.original;
  for (const kind of Object.keys(record.t1!) as T1Kind[]) if (await reported(record.t1![kind]?.hash)) delete record.t1![kind];

  // What is shared already counts only if it still matches what is on this machine. Hash first, then plan:
  // - the original: relinked to other footage, its proxy and shared original belong to the old footage;
  // - each T1 file: a regenerated transcript or poster is a new file.
  let original: Manifest | undefined;
  if (o.local.original) {
    original = await hash(o.local.original);
    if (record.hash !== undefined && record.hash !== original.hash) {
      delete record.proxy;
      delete record.original;
    }
    record.hash = original.hash;
    record.size = original.size;
    o.onEvent?.({ type: "hashed", what: "original", hash: original.hash });
  }
  // The record's proxy counts only while it is the shared one and still usable. One replaced since (its stream was
  // abandoned, or a part reported damaged) becomes the replacement, in the record's own profile; one with nothing
  // usable in its place is planned again (or dropped, without the original here). Checked by whoever shares, with the
  // original or not. A store that can't answer leaves the record as it is, unless its proxy was reported damaged: the
  // steps below find out for themselves.
  if (record.proxy && record.hash !== undefined) {
    const was = record.proxy;
    try {
      const p = await usableProxy(o.store, record.hash, was.profile, { staleMs: o.staleMs });
      if (p === null) delete record.proxy;
      else if ("stream" in p ? p.stream !== was.stream : p.hash !== was.hash) record.proxy = await proxyOf(o, p, was.profile, hasher);
    } catch {
      o.signal?.throwIfAborted();
      // Still drop one reported damaged: kept, it would plan no proxy work at all.
      if (await reported(was.stream ?? was.hash)) delete record.proxy;
    }
  }
  // T1 files: sizes first, so files the policy leaves out (a .context over its cap) are never read; then a hash of
  // each candidate. One unreadable T1 file is skipped, not a reason to fail the whole clip.
  const t1Sizes: Partial<Record<T1Kind, number>> = {};
  const t1Manifests: Partial<Record<T1Kind, Manifest>> = {};
  const unreadable: { what: string; why: string }[] = [];
  for (const [kind, path] of Object.entries(o.local.t1 ?? {}) as [T1Kind, string][]) {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (e) {
      unreadable.push({ what: kind, why: `can't read it: ${(e as Error).message}` });
      continue;
    }
    t1Sizes[kind] = size;
    if (kind === "context" && size > CONTEXT_CAP_BYTES) continue; // planShare reports it
    try {
      const m = await hash(path);
      t1Manifests[kind] = m;
      // The size that counts is the one hashed: a file can grow past the cap between its stat and its hash.
      t1Sizes[kind] = m.size;
      if (record.t1![kind] && record.t1![kind]!.hash !== m.hash) delete record.t1![kind];
    } catch (e) {
      if (o.signal?.aborted || (e as Error)?.name === "AbortError") throw o.signal?.aborted ? o.signal.reason : e;
      delete t1Sizes[kind];
      unreadable.push({ what: kind, why: `can't read it: ${(e as Error).message}` });
    }
  }
  const hostProxy = o.encoders.some(canReuse);
  const plan = planShare(record, { original: !!o.local.original, t1: t1Sizes, hostProxy }, o.policy);
  plan.skipped.push(...unreadable);
  for (const s of plan.skipped) o.onEvent?.({ type: "skipped", ...s });

  const upload = async (what: string, path: string, manifest: Manifest, contentType?: string): Promise<UploadResult> => {
    let source: Awaited<ReturnType<typeof fileSource>>;
    try {
      source = await fileSource(path);
    } catch (e) {
      throw new LocalFileError((e as Error).message, { cause: e });
    }
    try {
      const result = await uploadMedia({ store: o.store, hasher, source, manifest, state: o.uploadState, bytesPerSecond: o.bytesPerSecond, signal: o.signal, contentType });
      o.onEvent?.({ type: "uploaded", what, result });
      return result;
    } finally {
      await source.close();
    }
  };

  for (const step of plan.steps) {
    o.signal?.throwIfAborted();
    if (step.tier === "T1") {
      const path = o.local.t1![step.kind]!;
      const m = t1Manifests[step.kind]!;
      try {
        await upload(step.kind, path, m);
      } catch (e) {
        // This file can't be read now (its hash may have come from the manifest cache), or it changed since it was
        // hashed: skip it, like an unreadable file above. Cancellation and store errors still fail the share.
        if (o.signal?.aborted) throw o.signal.reason;
        if (!(e instanceof LocalFileError) && !(e instanceof SourceChangedError)) throw e;
        const skip = { what: step.kind, why: `can't read it: ${(e as Error).message}` };
        plan.skipped.push(skip);
        o.onEvent?.({ type: "skipped", ...skip });
        continue;
      }
      record.t1![step.kind] = { hash: m.hash, size: m.size };
    } else if (step.tier === "T2") {
      if (!original) {
        o.onEvent?.({ type: "skipped", what: "proxy", why: "the original is needed to key the proxy" });
        continue;
      }
      record.proxy = o.proxyStreams === false ? await shareProxy(o, original, profile, hash, upload) : await shareProxyStream(o, original, profile, hasher);
    } else if (step.tier === "T3") {
      await upload("original", o.local.original!, original!, record.mime);
      record.original = "shared";
    }
  }
  return { record, skipped: plan.skipped };
}

async function shareProxy(
  o: ShareMediaOptions,
  original: Manifest,
  profile: CollabProfile,
  hash: (path: string) => Promise<Manifest>,
  upload: (what: string, path: string, m: Manifest, contentType?: string) => Promise<UploadResult>,
): Promise<NonNullable<MediaRecord["proxy"]>> {
  const pointerKey = proxyPointerKey(original.hash, profile.id);
  const p = await usableProxy(o.store, original.hash, profile.id, { staleMs: o.staleMs });
  if (p && "hash" in p) {
    o.onEvent?.({ type: "proxy", how: "teammate's", hash: p.hash });
    return { hash: p.hash, size: p.size, profile: profile.id, encoder: p.encoder };
  }
  // No pointer, a broken one, one to an object that's gone or was reported damaged (its upload below replaces it):
  // make the proxy again and overwrite the pointer.
  const input = { path: o.local.original! };
  let path: string | null = null;
  let encoder = "cardboard-proxy";
  let attempts: ProxyAttempt[] | undefined;
  for (const e of o.encoders) {
    if (canReuse(e)) {
      path = await e.reusable(input, { signal: o.signal });
      if (path) break;
    }
  }
  const how = path ? "host's" : "encoded";
  if (!path) {
    path = join(o.workDir, `${original.hash}.${profile.id}.mp4`);
    // The host's proxy already said no above; don't ask it again inside the chain.
    const chain = o.encoders.filter((e) => !canReuse(e));
    const out = await encodeProxy(chain, input, { path }, profile, { signal: o.signal });
    encoder = out.encoder;
    attempts = out.attempts;
  }
  const m = await hash(path);
  await upload("proxy", path, m, "video/mp4");
  const pointer: ProxyPointer = { hash: m.hash, size: m.size, encoder };
  await o.store.put(pointerKey, new TextEncoder().encode(JSON.stringify(pointer)), { contentType: "application/json" });
  o.onEvent?.({ type: "proxy", how, hash: m.hash, attempts });
  return { hash: m.hash, size: m.size, profile: profile.id, encoder };
}

/** T2 as a segmented stream (e2e S5-1): see the top of this file. */
async function shareProxyStream(o: ShareMediaOptions, original: Manifest, profile: CollabProfile, hasher: Hasher): Promise<NonNullable<MediaRecord["proxy"]>> {
  const reuse = (p: ProxyPointer) => proxyOf(o, p, profile.id, hasher);
  // Someone's proxy first: reusing it needs no encoder here.
  const shared = await usableProxy(o.store, original.hash, profile.id, { staleMs: o.staleMs });
  if (shared) return reuse(shared);
  const input = { path: o.local.original! };
  // What can make the segments: Cardboard's own proxy, remuxed (no re-encode), then the ffmpeg encoders that run here.
  let host: string | null = null;
  for (const e of o.encoders) {
    if (canReuse(e)) {
      host = await e.reusable(input, { signal: o.signal });
      if (host) break;
    }
  }
  const candidates: { codec: FfmpegCodec | "copy"; name: string; input: string; usable: () => Promise<boolean> }[] = [];
  if (host) candidates.push({ codec: "copy", name: "cardboard-proxy", input: host, usable: async () => true });
  for (const e of o.encoders) {
    if (canReuse(e) || !(CHAIN_ORDER as readonly string[]).includes(e.name)) continue; // only ffmpeg encoders segment
    candidates.push({ codec: e.name as FfmpegCodec, name: e.name, input: input.path, usable: () => e.probe().catch(() => false) });
  }
  const attempts: ProxyAttempt[] = [];
  let first: (typeof candidates)[number] | undefined;
  for (const c of candidates) {
    if (await c.usable()) {
      first = c;
      break;
    }
    attempts.push({ encoder: c.name, outcome: "unavailable" });
  }
  if (!first) throw new ProxyChainError(attempts);

  const claim = await claimProxyStream(o.store, original.hash, profile.id, first.name, { staleMs: o.staleMs });
  if (!claim.claimed) return reuse(claim.pointer); // a teammate claimed it meanwhile

  const segmenter = o.segmenter ?? encodeSegments;
  const pointerKey = proxyPointerKey(original.hash, profile.id);
  let stream = (claim.pointer as { stream: string }).stream;
  for (const c of candidates.slice(candidates.indexOf(first))) {
    if (c !== first) {
      if (!(await c.usable())) {
        attempts.push({ encoder: c.name, outcome: "unavailable" });
        continue;
      }
      // A new stream for each attempt: the failed one's init segment belongs to its encoder. The pointer is ours.
      stream = newStreamId();
      const pointer: ProxyPointer = { stream, encoder: c.name, at: Date.now() };
      await o.store.put(pointerKey, new TextEncoder().encode(JSON.stringify(pointer)), { contentType: "application/json" });
    }
    o.onEvent?.({ type: "proxy", how: "streaming", stream });
    const writer = new ProxyStreamWriter({
      store: o.store,
      hasher,
      id: stream,
      upload: { state: o.uploadState, bytesPerSecond: o.bytesPerSecond, signal: o.signal },
      onWriteLimit: (until) => o.onEvent?.({ type: "waiting", what: "proxy", until }),
    });
    const dir = join(o.workDir, `stream-${stream}`);
    try {
      await segmenter({
        input: c.input,
        dir,
        profile,
        codec: c.codec,
        ffmpeg: o.ffmpeg,
        signal: o.signal,
        onInit: async (path) => void (await writer.init(new Uint8Array(await readFile(path)))),
        onSegment: async (sg) => void (await writer.segment(new Uint8Array(await readFile(sg.path)), sg.durationSec)),
      });
      const end = await writer.end();
      attempts.push({ encoder: c.name, outcome: "ok" });
      o.onEvent?.({ type: "proxy", how: c.codec === "copy" ? "host's" : "encoded", stream, attempts });
      return { stream, size: end.size, profile: profile.id, encoder: c.name };
    } catch (e) {
      if (o.signal?.aborted) throw o.signal.reason;
      if (writer.segments > 0) {
        // Teammates may be playing it already: don't switch it under them. Report it, so the next share replaces it.
        await giveUp(o.store, stream);
        throw e;
      }
      attempts.push({ encoder: c.name, outcome: "failed", error: e instanceof Error ? e.message : String(e) });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  // Every encoder failed: the claim points at a stream that will never have a segment. Report it, so the next share
  // (here, once an encoder works again, or a teammate's) takes it over instead of reusing a fresh-looking claim.
  await giveUp(o.store, stream);
  throw new ProxyChainError(attempts);
}

/** The record's proxy for a shared one (a teammate's, finished or still growing: theirs plays for everyone). */
async function proxyOf(o: ShareMediaOptions, p: ProxyPointer, profile: string, hasher: Hasher): Promise<NonNullable<MediaRecord["proxy"]>> {
  if ("hash" in p) {
    o.onEvent?.({ type: "proxy", how: "teammate's", hash: p.hash });
    return { hash: p.hash, size: p.size, profile, encoder: p.encoder };
  }
  const end = await new ProxyStreamReader({ store: o.store, media: new MediaReader({ store: o.store, hasher }), id: p.stream }).end();
  o.onEvent?.({ type: "proxy", how: "teammate's", stream: p.stream });
  return { stream: p.stream, size: end?.size, profile, encoder: p.encoder };
}

const giveUp = (store: ShareMediaOptions["store"], stream: string): Promise<unknown> => reportDamage(store, stream, { unfinished: true });
