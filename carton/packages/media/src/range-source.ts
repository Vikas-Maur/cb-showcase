// What the loopback range server, the `cardboard-media://` handler and a web Service Worker read media through.
// MediaReader implements it over the BlobStore and the leaf cache; tests use small in-memory sources.

export interface MediaStat {
  size: number;
  /** For the HTTP Content-Type; players sniff MP4 without it. */
  contentType?: string;
}

/** Thrown into a running read when a leaf it already streamed fails verification (PLAN §11, R2-11). */
export class LeafMismatchError extends Error {
  override name = "LeafMismatchError";
  readonly hash: string;
  readonly leaf: number;
  constructor(hash: string, leaf: number) {
    super(`media ${hash.slice(0, 12)}: leaf ${leaf} does not match its manifest; it will be fetched again`);
    this.hash = hash;
    this.leaf = leaf;
  }
}

export interface RangeSource {
  /** Null when the media is unknown here. */
  stat(hash: string, signal?: AbortSignal): Promise<MediaStat | null>;
  /**
   * Streams bytes [offset, offset + length) as they arrive (play first). A leaf that fails verification after some of
   * its bytes were yielded ends the stream with LeafMismatchError; the caller stops playback and asks again, and the
   * repair path has refetched the leaf by then.
   */
  read(hash: string, offset: number, length: number, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}
