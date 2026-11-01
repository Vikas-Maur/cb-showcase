// Puts the sample clips into a project's media store (PLAN §11), the way a share does: each clip is hashed into its
// manifest and uploaded with @carton/media's resumable uploadMedia (dedup by content, manifest first; a clip smaller
// than one part goes as a single PUT), then its poster and filmstrip go up as T1 files next to it. Any BlobStore works:
// the seed script passes httpBlobStore, tests may pass a memory store.

import { readFile } from "node:fs/promises";
import type { BlobStore } from "@carton/core/plugins";
import { mediaHash, uploadMedia, type UploadStateStore } from "@carton/media";
import { fileSource, nodeHasher } from "@carton/media/node";
import type { SampleClip } from "./clips.ts";

export interface UploadedClip {
  clipId: string;
  /** The media hash: the clip's bytes are at m/<hash>, its manifest at mf/<hash>. */
  hash: string;
  size: number;
  /** T1 keys in the same store. */
  poster: string;
  filmstrip: string;
  duration: number;
  /** The store already had the bytes, so nothing was sent. */
  deduped: boolean;
}

export interface UploadSampleOptions {
  store: BlobStore;
  clips: readonly SampleClip[];
  /** Overrides the part size uploadMedia picks (tests use it to force a multipart upload of a small clip). */
  partSize?: number;
  /** Where open uploads are remembered, so a run cut short resumes (default: in memory, this run only). */
  state?: UploadStateStore;
  signal?: AbortSignal;
}

/** The T1 key of a clip's poster or filmstrip. */
export const t1Key = (hash: string, file: "poster.jpg" | "filmstrip.jpg"): string => `t1/${hash}/${file}`;

export async function uploadSampleMedia(o: UploadSampleOptions): Promise<UploadedClip[]> {
  const out: UploadedClip[] = [];
  for (const clip of o.clips) {
    const source = await fileSource(clip.file);
    let hash: string, size: number, deduped: boolean;
    try {
      // The clips are a few MB, so hashing in this thread is fine (hashFile's worker threads are for big originals).
      const manifest = await mediaHash(source, nodeHasher, o.signal ? { signal: o.signal } : {});
      const r = await uploadMedia({
        store: o.store,
        hasher: nodeHasher,
        source,
        manifest,
        contentType: "video/mp4",
        ...(o.partSize ? { partSize: o.partSize } : {}),
        ...(o.state ? { state: o.state } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      });
      ({ hash, size, deduped } = r);
    } finally {
      await source.close();
    }
    const poster = t1Key(hash, "poster.jpg");
    const filmstrip = t1Key(hash, "filmstrip.jpg");
    // Keyed by the clip's hash. A clip the host already had (deduped) most likely has them too: look before sending, so
    // a second seed run sends nothing. A new clip's go straight up, create-only (atomic on the host).
    for (const [key, file] of [[poster, clip.poster], [filmstrip, clip.filmstrip]] as const)
      if (!deduped || !(await o.store.head(key))) await o.store.put(key, await readFile(file), { contentType: "image/jpeg", ifAbsent: true });
    out.push({ clipId: clip.id, hash, size, poster, filmstrip, duration: clip.duration, deduped });
  }
  return out;
}
