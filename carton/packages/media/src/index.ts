// Media (PLAN §11): mediaHash = SHA-256(size ‖ SHA-256 per 1 MiB leaf), with the leaf list as the manifest; lazy
// hashing; tiers T0–T3; one blob per media variant, resumable multipart with per-upload part size (8–64 MiB, equal
// parts, ≤ 10,000); play first, verify each leaf as it completes, refetch on mismatch; the collab proxy encoder chain;
// the loopback range server for ffmpeg-based tools. Nothing happens for solo local projects. Owner: media.
import type { BlobStore, Hasher, ProxyEncoder } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

/** L = 1 MiB (P6). */
export const LEAF_SIZE = 1024 * 1024;

export interface MediaManifest {
  hash: string;
  size: number;
  leafSize: number;
  leaves: string[];
}

/** Hash a media source in leaves (byte-identical in browsers and Node, P6). */
export async function mediaHash(source: Blob | AsyncIterable<Uint8Array>, hasher: Hasher, opts?: { size?: number }): Promise<MediaManifest> {
  return todo("mediaHash");
}

/** Part size for one upload: 8 MiB on slow links up to 64 MiB on fast ones, equal parts, at most 10,000. */
export function partSizeFor(size: number, linkBytesPerSec?: number): number {
  return todo("partSizeFor");
}

export interface UploadProgress {
  uploaded: number;
  total: number;
}

/** Upload one media variant as one blob, resuming from completed parts. */
export async function uploadMedia(blobs: BlobStore, key: string, source: Blob, opts?: { uploadId?: string; onProgress?: (p: UploadProgress) => void; signal?: AbortSignal }): Promise<{ key: string; uploadId?: string }> {
  return todo("uploadMedia");
}

/** The first encoder in the chain whose 1-frame probe succeeds (NVENC → QSV → AMF → libx264). */
export async function pickEncoder(chain: readonly ProxyEncoder[]): Promise<ProxyEncoder | null> {
  return todo("pickEncoder");
}

/** Verify a fetched leaf against the manifest (play-first, verify-when-the-leaf-completes). */
export async function verifyLeaf(manifest: MediaManifest, index: number, bytes: Uint8Array, hasher: Hasher): Promise<boolean> {
  return todo("verifyLeaf");
}
