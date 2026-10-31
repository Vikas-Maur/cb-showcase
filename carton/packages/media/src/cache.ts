// The range cache: verified leaves and manifests, keyed by media hash. Only bytes that matched their manifest go in,
// so anything read back from it is trusted. The loopback range server, the player (`cardboard-media://` on desktop, a
// Service Worker on the web) and tools all read through one cache, so a range fetched once is never fetched again.
// Node keeps it on disk (`@carton/media/node` FsLeafCache); this file has the interface and a memory version.

export interface LeafCache {
  hasLeaf(hash: string, leaf: number): Promise<boolean>;
  getLeaf(hash: string, leaf: number): Promise<Uint8Array | null>;
  /** `bytes` must already be verified. The cache may keep a reference: callers must not modify it afterwards. */
  putLeaf(hash: string, leaf: number, bytes: Uint8Array): Promise<void>;
  getManifest(hash: string): Promise<Uint8Array | null>;
  putManifest(hash: string, bytes: Uint8Array): Promise<void>;
}

/** Leaves in memory, least recently used dropped first once over `maxBytes`. Manifests are small and kept. */
export class MemoryLeafCache implements LeafCache {
  readonly maxBytes: number;
  #bytes = 0;
  readonly #leaves = new Map<string, Uint8Array>();
  readonly #manifests = new Map<string, Uint8Array>();

  constructor(maxBytes = 256 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }

  get bytes(): number {
    return this.#bytes;
  }

  async hasLeaf(hash: string, leaf: number): Promise<boolean> {
    return this.#leaves.has(`${hash}:${leaf}`);
  }

  async getLeaf(hash: string, leaf: number): Promise<Uint8Array | null> {
    const k = `${hash}:${leaf}`;
    const v = this.#leaves.get(k);
    if (!v) return null;
    // Re-insert: Map keeps insertion order, so the first key is always the least recently used.
    this.#leaves.delete(k);
    this.#leaves.set(k, v);
    return v;
  }

  async putLeaf(hash: string, leaf: number, bytes: Uint8Array): Promise<void> {
    const k = `${hash}:${leaf}`;
    const old = this.#leaves.get(k);
    if (old) {
      this.#bytes -= old.length;
      this.#leaves.delete(k);
    }
    if (bytes.length > this.maxBytes) return;
    // A view into a bigger buffer (one ranged response holds several leaves) would pin all of it; keep a copy.
    if (bytes.byteLength !== bytes.buffer.byteLength) bytes = bytes.slice();
    this.#leaves.set(k, bytes);
    this.#bytes += bytes.length;
    for (const [key, v] of this.#leaves) {
      if (this.#bytes <= this.maxBytes) break;
      this.#leaves.delete(key);
      this.#bytes -= v.length;
    }
  }

  async getManifest(hash: string): Promise<Uint8Array | null> {
    return this.#manifests.get(hash) ?? null;
  }

  async putManifest(hash: string, bytes: Uint8Array): Promise<void> {
    this.#manifests.set(hash, bytes);
  }
}
