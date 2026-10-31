// Hashing files on desktop (PLAN §11: "Desktop hashes in Node workers"). Worker threads read 8 MiB segments into a
// buffer each reuses, and SHA-256 every 1 MiB leaf straight into a shared digest array, taking segments from a shared
// counter as P6's harness did; the calling thread only waits. The disk is the bottleneck [V P1], so one worker is the
// default for background work, and more help only on fast SSDs when someone is waiting for a share.
//
// The worker's code is a string run with `eval`, so the module still works when a bundler folds this file into
// another one (Cardboard's library worker is one bundle). The pool starts on first use and stops when idle.

import { open, stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { DIGEST_SIZE, LEAF_SIZE, leafCountOf, manifestFromDigests, type Manifest } from "../manifest.ts";
import { SourceChangedError } from "../upload.ts";
import { nodeHasher } from "./node-hasher.ts";

const SEGMENT = 8 * LEAF_SIZE;
/** Below this, hashing in the calling thread costs less than handing the job to a worker. */
const SMALL = 8 * LEAF_SIZE;

const WORKER_SOURCE = String.raw`
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
let buf = null;
parentPort.on("message", (job) => {
  const { id, path, size, segment, leaf, digests, shared } = job;
  const out = new Uint8Array(digests);
  const ctl = new Int32Array(shared); // [0] next segment, [1] leaves done, [2] stop
  if (!buf || buf.length < segment) buf = Buffer.allocUnsafe(segment);
  let fd = -1;
  try {
    fd = fs.openSync(path, "r");
    for (;;) {
      if (Atomics.load(ctl, 2)) break;
      const s = Atomics.add(ctl, 0, 1);
      const off = s * segment;
      if (off >= size) break;
      const len = Math.min(segment, size - off);
      for (let got = 0; got < len; ) {
        const n = fs.readSync(fd, buf, got, len - got, off + got);
        if (n === 0) throw new Error("short read at " + (off + got) + ": the file changed while it was hashed");
        got += n;
      }
      let leaves = 0;
      for (let o = 0; o < len; o += leaf, leaves++) {
        out.set(createHash("sha256").update(buf.subarray(o, Math.min(len, o + leaf))).digest(), ((off + o) / leaf) * 32);
      }
      Atomics.add(ctl, 1, leaves);
    }
    parentPort.postMessage({ id, ok: true });
  } catch (e) {
    Atomics.store(ctl, 2, 1);
    parentPort.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
});
`;

interface Job {
  id: number;
  remaining: number;
  error?: string;
  resolve: () => void;
}

/** A few worker threads shared by every hash job in the process. */
class HashPool {
  readonly #workers: Worker[] = [];
  readonly #jobs = new Map<number, Job>();
  #nextId = 1;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #busy = 0;

  #grow(n: number): void {
    while (this.#workers.length < n) {
      const w = new Worker(WORKER_SOURCE, { eval: true });
      w.on("message", (m: { id: number; ok: boolean; error?: string }) => {
        const job = this.#jobs.get(m.id);
        if (!job) return;
        if (!m.ok && !job.error) job.error = m.error;
        if (--job.remaining === 0) job.resolve();
      });
      w.on("error", (e) => {
        // A crashed worker fails the jobs it was part of; the next job starts a fresh one.
        const i = this.#workers.indexOf(w);
        if (i >= 0) this.#workers.splice(i, 1);
        for (const job of this.#jobs.values()) {
          job.error ??= String(e);
          job.resolve();
        }
      });
      this.#workers.push(w);
    }
  }

  async run(path: string, size: number, workers: number, digests: SharedArrayBuffer, shared: SharedArrayBuffer): Promise<void> {
    clearTimeout(this.#idle);
    const n = Math.max(1, Math.min(workers, Math.ceil(size / SEGMENT)));
    this.#grow(n);
    this.#busy++;
    for (const w of this.#workers) w.ref();
    const id = this.#nextId++;
    try {
      await new Promise<void>((resolve) => {
        this.#jobs.set(id, { id, remaining: n, resolve });
        for (let i = 0; i < n; i++) this.#workers[i].postMessage({ id, path, size, segment: SEGMENT, leaf: LEAF_SIZE, digests, shared });
      });
      const err = this.#jobs.get(id)?.error;
      if (err) throw new SourceChangedError(err);
    } finally {
      this.#jobs.delete(id);
      if (--this.#busy === 0) {
        // Idle workers must not keep the process alive, and are stopped after a while.
        for (const w of this.#workers) w.unref();
        this.#idle = setTimeout(() => this.close(), 30_000);
        this.#idle.unref();
      }
    }
  }

  close(): void {
    clearTimeout(this.#idle);
    for (const w of this.#workers.splice(0)) void w.terminate();
  }
}

let pool: HashPool | undefined;

/** Stops the hashing workers now (they also stop on their own after 30 s idle). */
export function closeHashWorkers(): void {
  pool?.close();
  pool = undefined;
}

export interface HashFileOptions {
  /** Worker threads for this file. 1 for background work; up to 4 when a share waits on it and the disk is fast. */
  workers?: number;
  signal?: AbortSignal;
  /** Bytes hashed so far, about every 100 ms. */
  onProgress?: (bytes: number) => void;
}

/** The file's manifest. Fails with SourceChangedError if the file changes while it is read. */
export async function hashFile(path: string, opts: HashFileOptions = {}): Promise<Manifest> {
  opts.signal?.throwIfAborted();
  const before = await stat(path);
  const size = before.size;
  let digests: Uint8Array;
  if (size <= SMALL) {
    const fh = await open(path, "r");
    try {
      const buf = new Uint8Array(size);
      for (let got = 0; got < size; ) {
        const { bytesRead } = await fh.read(buf, got, size - got, got);
        if (bytesRead === 0) throw new SourceChangedError(`short read at ${got}: the file changed while it was hashed`);
        got += bytesRead;
      }
      digests = new Uint8Array(leafCountOf(size) * DIGEST_SIZE);
      for (let o = 0, i = 0; o < size; o += LEAF_SIZE, i++) digests.set(await nodeHasher.sha256(buf.subarray(o, Math.min(size, o + LEAF_SIZE))), i * DIGEST_SIZE);
    } finally {
      await fh.close();
    }
    opts.onProgress?.(size);
  } else {
    const digestsBuf = new SharedArrayBuffer(leafCountOf(size) * DIGEST_SIZE);
    const sharedBuf = new SharedArrayBuffer(12);
    const ctl = new Int32Array(sharedBuf);
    const onAbort = () => Atomics.store(ctl, 2, 1);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort(); // aborted while the file was being stat'ed
    const tick = opts.onProgress && setInterval(() => opts.onProgress!(Math.min(size, Atomics.load(ctl, 1) * LEAF_SIZE)), 100);
    try {
      pool ??= new HashPool();
      await pool.run(path, size, opts.workers ?? 1, digestsBuf, sharedBuf);
    } finally {
      if (tick) clearInterval(tick);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    opts.signal?.throwIfAborted();
    if (Atomics.load(ctl, 1) !== leafCountOf(size)) throw new SourceChangedError("not every leaf was hashed");
    opts.onProgress?.(size);
    digests = new Uint8Array(digestsBuf);
  }
  const after = await stat(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new SourceChangedError(`${path} changed while it was hashed`);
  return manifestFromDigests(size, digests, nodeHasher);
}
