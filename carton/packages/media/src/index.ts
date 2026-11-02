// @carton/media (PLAN §11): content ids, lazy hashing, tiers, resumable uploads and verified range reads through any
// BlobStore, the range cache, and the collab proxy encoder chain. This entry runs everywhere (browsers, Workers, Node);
// `@carton/media/node` adds worker-thread file hashing, the disk cache, the loopback range server and the ffmpeg
// encoders. Nothing here does anything for a solo local project: it all starts when a project is shared.

import { equalBytes } from "./bytes.ts";
import type { Hasher } from "./contracts.ts";
import { blobSource, bytesSource, hashSource, type ByteSource, type HashOptions } from "./hash.ts";
import { leafDigest, type Manifest } from "./manifest.ts";

export { fromHex, isMediaHash, toHex } from "./bytes.ts";
export {
  decodeManifest,
  DIGEST_SIZE,
  LEAF_SIZE,
  leafCountOf,
  leafDigest,
  leafSpan,
  leavesCovering,
  ManifestBuilder,
  ManifestError,
  manifestFromDigests,
  type Manifest,
} from "./manifest.ts";
export { blobSource, bytesSource, hashSource, webCryptoHasher, type ByteSource, type HashOptions } from "./hash.ts";
export { HashScheduler, MemoryManifestCache, type HashJobOptions, type HashPriority, type HashSchedulerOptions, type HashTarget, type ManifestCache } from "./scheduler.ts";
export { damagedKey, manifestKey, mediaKey, proxyPointerKey, streamEndKey, streamInitKey, streamSegmentKey, type ProxyPointer } from "./keys.ts";
export { isDamaged, markRepaired, openReport, repairedKey, reportDamage, reportToHost, type HostDamageReporting } from "./damage.ts";
export {
  claimProxyStream,
  usableProxy,
  findProxy,
  newStreamId,
  ProxyStreamReader,
  ProxyStreamWriter,
  streamRangeSource,
  StreamDamagedError,
  StreamPartMissingError,
  StreamRouteMissingError,
  isStreamAppender,
  isStreamBatchReader,
  streamPartOf,
  streamSegmentOf,
  streamEndOf,
  entryManifest,
  toBase64,
  fromBase64,
  type ClaimResult,
  type PlayedPart,
  type ProxyStreamReaderOptions,
  type ProxyStreamWriterOptions,
  type StreamAppendBatch,
  type StreamAppendPart,
  type StreamAppender,
  type StreamBatchReader,
  type StreamEnd,
  type StreamPart,
  type StreamReadItem,
  type StreamReadOptions,
  type StreamSegment,
} from "./stream.ts";
export {
  cancelUpload,
  choosePartSize,
  FAST_PART_SIZE,
  MAX_PARTS,
  MemoryUploadStateStore,
  MIN_PART_SIZE,
  SourceChangedError,
  uploadMedia,
  type CompletedPart,
  type UploadOptions,
  type UploadProgress,
  type UploadResult,
  type UploadState,
  type UploadStateStore,
} from "./upload.ts";
export { MemoryLeafCache, type LeafCache } from "./cache.ts";
export { MediaMissingError, MediaReader, type MediaReaderOptions, type ReaderEvent } from "./read.ts";
export { LeafMismatchError, type MediaStat, type RangeSource } from "./range-source.ts";
export { serveMedia, type ServeMediaOptions } from "./fetch-handler.ts";
export { parseRange, type ByteSpan } from "./http-range.ts";
export {
  COLLAB_PROXY_720P,
  collabProfile,
  encodeProxy,
  moovBeforeMdat,
  pickEncoder,
  ProxyChainError,
  ProxyDeclinedError,
  REUSE_MAX_KBPS,
  REUSE_MAX_LONG_EDGE,
  reusableProxy,
  type CollabProfile,
  type EncodeProxyOptions,
  type EncodeProxyOutcome,
  type ProxyAttempt,
  type ProxyFacts,
  type ReuseDecision,
} from "./proxy.ts";
export {
  CONTEXT_CAP_BYTES,
  planShare,
  sourceFor,
  T1_KINDS,
  toMediaRecord,
  type Availability,
  type LocalMedia,
  type MediaRecord,
  type MediaUse,
  type SharedObject,
  type SharePolicy,
  type ShareStep,
  type T1Kind,
  type Tier,
  type UseSource,
} from "./tiers.ts";

/** The manifest (and so the media hash) of a Blob, bytes, or any ByteSource. Identical in browsers and Node (P6). */
export function mediaHash(source: Blob | Uint8Array | ByteSource, hasher: Hasher, opts?: HashOptions): Promise<Manifest> {
  const src = source instanceof Uint8Array ? bytesSource(source) : typeof Blob !== "undefined" && source instanceof Blob ? blobSource(source) : (source as ByteSource);
  return hashSource(src, hasher, opts);
}

/** Checks one leaf against the manifest. */
export async function verifyLeaf(manifest: Manifest, index: number, bytes: Uint8Array, hasher: Hasher): Promise<boolean> {
  return equalBytes(await hasher.sha256(bytes), leafDigest(manifest, index));
}

/** @deprecated The contracts skeleton's name; use choosePartSize. */
export { choosePartSize as partSizeFor } from "./upload.ts";
