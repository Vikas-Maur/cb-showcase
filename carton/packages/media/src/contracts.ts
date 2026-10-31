// The plug-in shapes the media package uses (PLAN §3.1): BlobStore, Hasher, ProxyEncoder.
// PROVISIONAL: these mirror the plan until foundation-core's `contracts:` commit lands in @carton/core/plugins; then
// this file re-exports those types and keeps only the media-specific additions.

/** SHA-256, from node:crypto or WebCrypto. Both must give the same bytes (P6). */
export interface Hasher {
  sha256(data: Uint8Array): Promise<Uint8Array>;
}

export interface ByteRange {
  offset: number;
  /** Bytes wanted; the store returns fewer only at the end of the object. */
  length: number;
}

export interface BlobHead {
  size: number;
  etag?: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
  size?: number;
}

export interface BlobGetOptions {
  signal?: AbortSignal;
}

/**
 * Media objects, keyframes and archived segments (PLAN §3.1). One implementation per backend: R2 inside
 * server-cloudflare, S3-compatible, fs, memory. The media package never assumes which.
 */
export interface BlobStore {
  head(key: string): Promise<BlobHead | null>;
  get(key: string, range?: ByteRange, opts?: BlobGetOptions): Promise<Uint8Array | null>;
  /** Streams the bytes as they arrive, for play-first reads. Optional: `get` is used when it is missing. */
  getStream?(key: string, range?: ByteRange, opts?: BlobGetOptions): Promise<ReadableStream<Uint8Array> | null>;
  put(key: string, body: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Multipart: every part but the last has the same size (R2's rule), at most 10,000 parts. */
  createMultipart(key: string): Promise<{ uploadId: string }>;
  uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array, opts?: BlobGetOptions): Promise<{ etag: string }>;
  /** The parts the store holds for an open upload. Optional: R2's Workers binding can't list them. */
  listParts?(key: string, uploadId: string): Promise<CompletedPart[]>;
  completeMultipart(key: string, uploadId: string, parts: CompletedPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

/** What a collab proxy looks like. The id is part of the proxy's dedup key: (source hash, profile id). */
export interface ProxyProfile {
  id: string;
  /** Longest side in pixels; the other side keeps the aspect ratio. */
  longEdge: number;
  /** Target and ceiling video rate, kbit/s. */
  videoKbps: number;
  maxKbps: number;
  audioKbps: number;
  /** A keyframe at least this often, so range reads can seek without decoding far back. */
  keyframeSeconds: number;
}

export interface ProxyJob {
  /** The source file (an original) on the local disk. */
  input: string;
  /** Where the finished proxy goes. Encoders write a temporary file and rename it here. */
  output: string;
  profile: ProxyProfile;
  /** Lets a "reuse what exists" encoder find the host's own proxy for this media. */
  mediaId?: string;
  signal?: AbortSignal;
  /** 0..1 */
  onProgress?: (fraction: number) => void;
}

export interface ProxyResult {
  /** The proxy file. Equal to `job.output`, or an existing file an encoder chose to reuse. */
  path: string;
  encoder: string;
  reused: boolean;
}

/** Makes collab proxies (PLAN §11 T2): the host's own proxy, or NVENC → QSV → AMF → libx264. */
export interface ProxyEncoder {
  readonly id: string;
  /** False when this encoder can't run here at all. Probed once, then cached. */
  available(): Promise<boolean>;
  /** Null when this encoder declines the job (e.g. no reusable proxy exists); throws when it fails. */
  encode(job: ProxyJob): Promise<ProxyResult | null>;
}
