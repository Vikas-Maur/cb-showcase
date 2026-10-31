// Sharing one clip (PLAN §11): carries out planShare for the tiers that must move, and returns the updated T0 record.
//   - The original is hashed first (lazily, through the scheduler when there is one): its id names the clip and keys
//     its proxy.
//   - T1 files are hashed and uploaded (deduped, so a poster two clips share goes up once).
//   - T2: a proxy a teammate already made for this source and profile is reused through its pointer (no encode, no
//     upload). Else the host's own proxy is used as it is when it qualifies; else the encoder chain makes one into
//     `workDir`. The proxy is hashed, uploaded, and its pointer written.
//   - T3 only with the owner's opt-in or a teammate's request.

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { BlobStore, Hasher, ProxyEncoder } from "../contracts.ts";
import { proxyPointerKey, mediaKey, type ProxyPointer } from "../keys.ts";
import type { Manifest } from "../manifest.ts";
import { COLLAB_PROXY_720P, encodeProxy, type CollabProfile, type ProxyAttempt } from "../proxy.ts";
import type { HashScheduler } from "../scheduler.ts";
import { CONTEXT_CAP_BYTES, planShare, type MediaRecord, type SharePolicy, type T1Kind } from "../tiers.ts";
import { uploadMedia, type UploadResult, type UploadStateStore } from "../upload.ts";
import { fileSource } from "./file-source.ts";
import { hashFile } from "./hash-file.ts";
import { nodeHasher } from "./node-hasher.ts";

export type ShareEvent =
  | { type: "hashed"; what: string; hash: string }
  | { type: "uploaded"; what: string; result: UploadResult }
  | { type: "proxy"; how: "teammate's" | "host's" | "encoded"; hash: string; attempts?: ProxyAttempt[] }
  | { type: "skipped"; what: string; why: string };

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
}

export interface ShareMediaResult {
  record: MediaRecord;
  skipped: { what: string; why: string }[];
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
      if (record.t1![kind] && record.t1![kind]!.hash !== m.hash) delete record.t1![kind];
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      delete t1Sizes[kind];
      unreadable.push({ what: kind, why: `can't read it: ${(e as Error).message}` });
    }
  }
  const hostProxy = o.encoders.some(canReuse);
  const plan = planShare(record, { original: !!o.local.original, t1: t1Sizes, hostProxy }, o.policy);
  plan.skipped.push(...unreadable);
  for (const s of plan.skipped) o.onEvent?.({ type: "skipped", ...s });

  const upload = async (what: string, path: string, manifest: Manifest, contentType?: string): Promise<UploadResult> => {
    const source = await fileSource(path);
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
      await upload(step.kind, path, m);
      record.t1![step.kind] = { hash: m.hash, size: m.size };
    } else if (step.tier === "T2") {
      if (!original) {
        o.onEvent?.({ type: "skipped", what: "proxy", why: "the original is needed to key the proxy" });
        continue;
      }
      record.proxy = await shareProxy(o, original, profile, hash, upload);
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
  const existing = await o.store.get(pointerKey);
  if (existing) {
    try {
      const p = JSON.parse(new TextDecoder().decode(existing)) as ProxyPointer;
      const head = await o.store.head(mediaKey(p.hash));
      if (head && head.size === p.size) {
        o.onEvent?.({ type: "proxy", how: "teammate's", hash: p.hash });
        return { hash: p.hash, size: p.size, profile: profile.id, encoder: p.encoder };
      }
    } catch {
      // A broken pointer: make the proxy again and overwrite it.
    }
  }
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
