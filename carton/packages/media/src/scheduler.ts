// Lazy hashing (PLAN §11: nothing happens for solo local projects). Importing never hashes. Media are hashed when a
// project is shared, or in the background when the host says it's idle, one file at a time by default because the
// disk is the bottleneck [V P1]. The host pauses background hashing while it plays or exports; a share someone waits
// on keeps going. Results are kept per (file, size, mtime), so an unchanged file is never hashed twice.

import type { Hasher } from "./contracts.ts";
import { decodeManifest, type Manifest } from "./manifest.ts";

export type HashPriority = "share" | "background";

/** A file to hash, identified by whatever the host uses (a path, a media id) plus what tells it changed. */
export interface HashTarget {
  key: string;
  size: number;
  mtimeMs: number;
}

export interface HashJobOptions {
  priority: HashPriority;
  signal: AbortSignal;
  onProgress?: (bytes: number) => void;
}

/** Remembers manifests across sessions (the local store keeps them next to the project). */
export interface ManifestCache {
  get(t: HashTarget): Promise<Uint8Array | null>;
  put(t: HashTarget, manifest: Uint8Array): Promise<void>;
}

export class MemoryManifestCache implements ManifestCache {
  readonly #m = new Map<string, Uint8Array>();
  async get(t: HashTarget) {
    return this.#m.get(`${t.key}\0${t.size}\0${t.mtimeMs}`) ?? null;
  }
  async put(t: HashTarget, manifest: Uint8Array) {
    this.#m.set(`${t.key}\0${t.size}\0${t.mtimeMs}`, manifest);
  }
}

export interface HashSchedulerOptions {
  /** Hashes one file: `hashFile` in Node, `hashSource(blobSource(file))` in a browser. */
  hash: (t: HashTarget, o: HashJobOptions) => Promise<Manifest>;
  hasher: Hasher;
  cache?: ManifestCache;
  /** Files hashed at once. */
  concurrency?: number;
  onProgress?: (t: HashTarget, bytes: number) => void;
}

interface Entry {
  t: HashTarget;
  id: string;
  priority: HashPriority;
  promise: Promise<Manifest>;
  resolve: (m: Manifest) => void;
  reject: (e: unknown) => void;
  ac?: AbortController;
  /** Callers still interested; cancel() drops one. */
  waiters: number;
}

class Requeue extends Error {}

export class HashScheduler {
  readonly #o: HashSchedulerOptions;
  readonly #queue: Entry[] = [];
  readonly #running = new Set<Entry>();
  readonly #byId = new Map<string, Entry>();
  #paused = false;

  constructor(opts: HashSchedulerOptions) {
    this.#o = opts;
  }

  get pending(): number {
    return this.#queue.length + this.#running.size;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** The file's manifest, hashing it if needed. A second request for the same file shares the first one's work. */
  request(t: HashTarget, priority: HashPriority = "share"): Promise<Manifest> {
    const id = `${t.key}\0${t.size}\0${t.mtimeMs}`;
    let e = this.#byId.get(id);
    if (e) {
      e.waiters++;
      if (priority === "share") e.priority = "share";
      this.#pump();
      return e.promise;
    }
    let resolve!: (m: Manifest) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<Manifest>((a, b) => {
      resolve = a;
      reject = b;
    });
    e = { t, id, priority, promise, resolve, reject, waiters: 1 };
    this.#byId.set(id, e);
    this.#queue.push(e);
    this.#pump();
    return promise;
  }

  /** Stop starting background work, and stop background work in progress (it is queued again). */
  pause(): void {
    this.#paused = true;
    for (const e of this.#running) if (e.priority === "background") e.ac?.abort(new Requeue());
  }

  resume(): void {
    this.#paused = false;
    this.#pump();
  }

  /** Drops a request; the work stops once nobody waits for it. */
  cancel(t: HashTarget): void {
    const id = `${t.key}\0${t.size}\0${t.mtimeMs}`;
    const e = this.#byId.get(id);
    if (!e || --e.waiters > 0) return;
    const err = new DOMException("hash request cancelled", "AbortError");
    const i = this.#queue.indexOf(e);
    if (i >= 0) {
      this.#queue.splice(i, 1);
      this.#byId.delete(id);
      e.reject(err);
    } else {
      e.ac?.abort(err);
    }
  }

  #next(): Entry | undefined {
    let i = this.#queue.findIndex((e) => e.priority === "share");
    if (i < 0 && !this.#paused) i = this.#queue.findIndex((e) => e.priority === "background");
    return i < 0 ? undefined : this.#queue.splice(i, 1)[0];
  }

  #pump(): void {
    while (this.#running.size < Math.max(1, this.#o.concurrency ?? 1)) {
      const e = this.#next();
      if (!e) return;
      this.#run(e);
    }
  }

  async #run(e: Entry): Promise<void> {
    this.#running.add(e);
    const ac = new AbortController();
    e.ac = ac;
    try {
      const cached = await this.#o.cache?.get(e.t);
      let m: Manifest | null = null;
      if (cached) {
        try {
          m = await decodeManifest(cached, this.#o.hasher);
          if (m.size !== e.t.size) m = null;
        } catch {
          m = null;
        }
      }
      if (!m) {
        ac.signal.throwIfAborted();
        m = await this.#o.hash(e.t, { priority: e.priority, signal: ac.signal, onProgress: (b) => this.#o.onProgress?.(e.t, b) });
        await this.#o.cache?.put(e.t, m.bytes);
      }
      this.#byId.delete(e.id);
      e.resolve(m);
    } catch (err) {
      if (ac.signal.reason instanceof Requeue) {
        e.ac = undefined;
        this.#queue.unshift(e);
      } else {
        this.#byId.delete(e.id);
        e.reject(ac.signal.aborted ? ac.signal.reason : err);
      }
    } finally {
      this.#running.delete(e);
      this.#pump();
    }
  }
}
