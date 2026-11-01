// The range cache on disk, and the record of open uploads. Both are shared by every process on the machine (the app's
// library worker, `cb` calls), so every write is a whole new file renamed into place: a reader sees a complete leaf or
// none. Leaves never change once written (they are verified), so a rename that loses a race to another process's copy
// of the same leaf is fine.
//
// Layout: <dir>/<hash[0:2]>/<hash>/manifest and <dir>/<hash[0:2]>/<hash>/<leaf>, one file per verified 1 MiB leaf.
// One file per leaf keeps eviction simple and leaves no half-written state after a crash, with no sparse files
// (which FAT/exFAT lack and NTFS needs a flag for).
//
// Windows: renaming onto a file another process has open fails with EPERM/EBUSY/EACCES (antivirus scanners do this
// too), so renames are retried briefly; a leaf that still can't be placed is dropped, since the cache is optional.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMediaHash } from "../bytes.ts";
import { streamEntryName, type LeafCache } from "../cache.ts";
import type { UploadState, UploadStateStore } from "../upload.ts";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Writes `data` to `path` atomically: a temporary file in the same folder, then rename (retried on Windows locks). */
export async function writeFileAtomic(path: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= 5) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
      await new Promise((r) => setTimeout(r, 20 * 2 ** attempt));
    }
  }
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

export interface FsLeafCacheOptions {
  /** Evict least recently used leaves beyond this. Default 20 GB. */
  maxBytes?: number;
}

export class FsLeafCache implements LeafCache {
  readonly dir: string;
  readonly maxBytes: number;
  /** Leaf files and their sizes, oldest use first; filled by scanning the folder on first write. */
  #index: Map<string, number> | null = null;
  #scanning: Promise<void> | null = null;
  #bytes = 0;

  constructor(dir: string, opts: FsLeafCacheOptions = {}) {
    this.dir = dir;
    this.maxBytes = opts.maxBytes ?? 20e9;
  }

  #mediaDir(hash: string): string {
    if (!isMediaHash(hash)) throw new TypeError(`not a media hash: ${hash}`);
    return join(this.dir, hash.slice(0, 2), hash);
  }

  #leafPath(hash: string, leaf: number): string {
    if (!Number.isSafeInteger(leaf) || leaf < 0) throw new RangeError(`bad leaf ${leaf}`);
    return join(this.#mediaDir(hash), String(leaf));
  }

  async hasLeaf(hash: string, leaf: number): Promise<boolean> {
    try {
      await stat(this.#leafPath(hash, leaf));
      return true;
    } catch (e) {
      if (isMissing(e)) return false;
      throw e;
    }
  }

  async getLeaf(hash: string, leaf: number): Promise<Uint8Array | null> {
    const path = this.#leafPath(hash, leaf);
    try {
      const b = await readFile(path);
      this.#touch(path, b.length);
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async putLeaf(hash: string, leaf: number, bytes: Uint8Array): Promise<void> {
    const path = this.#leafPath(hash, leaf);
    await mkdir(this.#mediaDir(hash), { recursive: true });
    try {
      await writeFileAtomic(path, bytes);
    } catch (e) {
      if (RETRYABLE.has((e as NodeJS.ErrnoException).code ?? "")) return; // another process holds the same leaf
      throw e;
    }
    await this.#scan();
    this.#touch(path, bytes.length);
    await this.#evict();
  }

  async getManifest(hash: string): Promise<Uint8Array | null> {
    try {
      const b = await readFile(join(this.#mediaDir(hash), "manifest"));
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async putManifest(hash: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.#mediaDir(hash), { recursive: true });
    await writeFileAtomic(join(this.#mediaDir(hash), "manifest"), bytes);
  }

  // Beside the stream id's folder's would-be leaves; not numbered, so never counted or evicted as leaves (tiny, like
  // manifests).
  async getEntry(key: string): Promise<Uint8Array | null> {
    const { stream, name } = streamEntryName(key);
    try {
      const b = await readFile(join(this.#mediaDir(stream), name));
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async putEntry(key: string, bytes: Uint8Array): Promise<void> {
    const { stream, name } = streamEntryName(key);
    await mkdir(this.#mediaDir(stream), { recursive: true });
    await writeFileAtomic(join(this.#mediaDir(stream), name), bytes);
  }

  /** Bytes of leaves on disk (after the first write has scanned the folder). */
  get bytes(): number {
    return this.#bytes;
  }

  #touch(path: string, size: number): void {
    if (!this.#index) return;
    const old = this.#index.get(path);
    if (old !== undefined) {
      this.#index.delete(path);
      this.#bytes -= old;
    }
    this.#index.set(path, size);
    this.#bytes += size;
  }

  /** Learns what is on disk, oldest first by modification time (the best guess at use order after a restart). */
  #scan(): Promise<void> {
    if (this.#index) return Promise.resolve();
    this.#scanning ??= (async () => {
      const found: { path: string; size: number; at: number }[] = [];
      for (const a of await readdir(this.dir).catch(() => [] as string[])) {
        for (const h of await readdir(join(this.dir, a)).catch(() => [] as string[])) {
          const md = join(this.dir, a, h);
          for (const f of await readdir(md).catch(() => [] as string[])) {
            if (!/^\d+$/.test(f)) continue;
            const s = await stat(join(md, f)).catch(() => null);
            if (s) found.push({ path: join(md, f), size: s.size, at: s.mtimeMs });
          }
        }
      }
      found.sort((x, y) => x.at - y.at);
      const index = new Map<string, number>();
      let bytes = 0;
      for (const f of found) {
        index.set(f.path, f.size);
        bytes += f.size;
      }
      this.#bytes = bytes;
      this.#index = index;
    })();
    return this.#scanning;
  }

  async #evict(): Promise<void> {
    if (!this.#index) return;
    for (const [path, size] of this.#index) {
      if (this.#bytes <= this.maxBytes) break;
      this.#index.delete(path);
      this.#bytes -= size;
      await rm(path, { force: true }).catch(() => {});
    }
  }
}

/** Open uploads, one small JSON file each, so a restart resumes them. */
export class FsUploadStateStore implements UploadStateStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  #path(key: string): string {
    // Keys are "m/<hash>": keep them to safe file names on every OS.
    return join(this.dir, `${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  }
  async load(key: string): Promise<UploadState | null> {
    try {
      const s = JSON.parse(await readFile(this.#path(key), "utf8")) as UploadState;
      return s.v === 1 && s.key === key ? s : null;
    } catch (e) {
      if (isMissing(e) || e instanceof SyntaxError) return null;
      throw e;
    }
  }
  async save(state: UploadState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.#path(state.key), JSON.stringify(state));
  }
  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }
}
