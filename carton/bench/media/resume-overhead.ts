// What resuming an upload after a cut link costs, against a clean upload and against starting over (what an uploader
// without resume does). The link is simulated: every request pays a round trip, and bytes go up at a fixed rate. The
// upload is @carton/media's real uploadMedia, reading a real file, with its state on disk (FsUploadStateStore), and the
// second session is a fresh store object, as after an app restart.
//
//   node carton/bench/media/resume-overhead.ts run <rounds> <out.jsonl> [MiB=64] [MBps=4] [rttMs=60]
//   node carton/bench/media/resume-overhead.ts one <clean|resume|restart> <file> <cutFraction> <MBps> <rttMs>
//
// Per run: `bytesUp` all bytes sent (both sessions), `ms` time spent uploading (both sessions; the time offline is not
// counted), `extraBytes` and `extraMs` against the file size and the round's clean run.

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomFillSync } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BlobStore } from "../../packages/media/src/contracts.ts";
import { hashFile } from "../../packages/media/src/node/hash-file.ts";
import { fileSource } from "../../packages/media/src/node/file-source.ts";
import { FsUploadStateStore } from "../../packages/media/src/node/fs-cache.ts";
import { nodeHasher } from "../../packages/media/src/node/node-hasher.ts";
import { CountingMemoryStore, LinkDroppedError } from "../../packages/media/src/testing.ts";
import { uploadMedia } from "../../packages/media/src/upload.ts";
import { median, runRounds } from "./runner.ts";

const SCRATCH = process.env.CARTON_MEDIA_SCRATCH ?? "/home/ubuntu/gfv-scratch/carton/media/bench";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A link: each request waits one round trip; uploads also wait size / rate. Cuts once `cutAt` bytes have gone up. */
function link(inner: CountingMemoryStore, MBps: number, rttMs: number, cutAt: number | null): BlobStore & { sent: () => number } {
  let sent = 0;
  let cut = cutAt;
  const up = async (n: number) => {
    await sleep(rttMs);
    if (cut !== null && sent + n > cut) {
      // The connection dies partway through this request: the bytes before the cut were sent for nothing.
      const partial = cut - sent;
      await sleep((partial / (MBps * 1e6)) * 1000);
      sent += partial;
      cut = null;
      throw new LinkDroppedError("connection reset by peer");
    }
    await sleep((n / (MBps * 1e6)) * 1000);
    sent += n;
  };
  return {
    kind: "simulated-link",
    sent: () => sent,
    head: async (k) => (await sleep(rttMs), inner.head(k)),
    get: async (k, r) => (await sleep(rttMs), inner.get(k, r)),
    put: async (k, d, o) => (await up(d.length), inner.put(k, d, o)),
    delete: (k) => inner.delete(k),
    list: (p, o) => inner.list(p, o),
    createMultipart: async (k, o) => wrap(await (await sleep(rttMs), inner.createMultipart(k, o))),
    resumeMultipart: async (k, id) => wrap(await inner.resumeMultipart(k, id)),
  };
  function wrap(u: Awaited<ReturnType<BlobStore["createMultipart"]>>) {
    return {
      key: u.key,
      uploadId: u.uploadId,
      uploadPart: async (n: number, d: Uint8Array) => (await up(d.length), u.uploadPart(n, d)),
      listParts: async () => (await sleep(rttMs), u.listParts()),
      complete: async (p: { partNumber: number; etag: string }[]) => (await sleep(rttMs), u.complete(p)),
      abort: () => u.abort(),
    };
  }
}

async function one(mode: string, file: string, cutFraction: number, MBps: number, rttMs: number) {
  const size = statSync(file).size;
  const manifest = await hashFile(file);
  const mem = new CountingMemoryStore();
  const stateDir = mkdtempSync(join(SCRATCH, "upload-state-"));
  const source = await fileSource(file);
  let ms = 0;
  let bytesUp = 0;
  let sessions = 0;
  const session = async (cutAt: number | null, useState: boolean) => {
    const store = link(mem, MBps, rttMs, cutAt);
    const t = performance.now();
    sessions++;
    try {
      // Bytes sent per second on this link: the uploader picks its part size from it (8 MiB below ~2 MB/s).
      return await uploadMedia({ store, hasher: nodeHasher, source, manifest, state: useState ? new FsUploadStateStore(stateDir) : undefined, bytesPerSecond: MBps * 1e6, concurrency: 1, retries: 0 });
    } finally {
      ms += performance.now() - t;
      bytesUp += store.sent();
    }
  };
  let partSize = 0;
  try {
    if (mode === "clean") {
      partSize = (await session(null, true)).partSize;
    } else {
      const cutAt = Math.round(size * cutFraction);
      await session(cutAt, true).then(
        () => {
          throw new Error("the cut did not happen");
        },
        (e) => {
          if (!(e instanceof LinkDroppedError)) throw e;
        },
      );
      // "restart": an uploader without resume starts the object over (new state, new multipart upload).
      partSize = (await session(null, mode === "resume")).partSize;
    }
  } finally {
    await source.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
  const stored = mem.objects.get(`m/${manifest.hash}`);
  if (!stored || stored.length !== size) throw new Error("upload incomplete");
  return { mode, size, cutFraction: mode === "clean" ? null : cutFraction, MBps, rttMs, partSize, sessions, bytesUp, ms: Math.round(ms) };
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "one") {
  console.log(JSON.stringify(await one(args[0], args[1], Number(args[2]), Number(args[3]), Number(args[4]))));
} else if (cmd === "run") {
  const [rounds, out, mib = "64", MBps = "4", rttMs = "60"] = args;
  const file = join(SCRATCH, `resume-${mib}m.bin`);
  const buf = Buffer.allocUnsafe(Number(mib) << 20);
  randomFillSync(buf);
  writeFileSync(file, buf);
  const self = fileURLToPath(import.meta.url);
  const cuts = [0.23, 0.37, 0.51, 0.68, 0.85];
  const all: Record<string, unknown>[] = [];
  for (let r = 0; r < Number(rounds); r++) {
    const cut = String(cuts[r % cuts.length]);
    const methods = ["clean", "resume", "restart"].map((m) => ({ id: m, cmd: [process.execPath, self, "one", m, file, cut, MBps, rttMs] }));
    // One round at a time, rotating the order, so each cut point has its own clean run to compare with.
    const rot = methods.slice(r % 3).concat(methods.slice(0, r % 3));
    const runs = runRounds(rot, 1, out);
    const clean = runs.find((x) => x.id === "clean");
    for (const x of runs) {
      x.extraBytes = (x.bytesUp as number) - (x.size as number);
      x.extraMs = clean ? (x.ms as number) - (clean.ms as number) : null;
      all.push(x);
    }
  }
  rmSync(file, { force: true });
  const by = (id: string, f: string) => all.filter((x) => x.id === id).map((x) => x[f] as number);
  const summary: Record<string, unknown> = {};
  for (const id of ["clean", "resume", "restart"]) {
    summary[id] = {
      msMedian: median(by(id, "ms")),
      ms: by(id, "ms"),
      extraBytesMedian: median(by(id, "extraBytes")),
      extraBytes: by(id, "extraBytes"),
      extraMsMedian: median(by(id, "extraMs")),
      extraMs: by(id, "extraMs"),
    };
  }
  console.log(JSON.stringify({ size: Number(mib) << 20, MBps: Number(MBps), rttMs: Number(rttMs), cuts: cuts.slice(0, Number(rounds)), summary }, null, 1));
} else {
  console.log("usage: resume-overhead.ts run <rounds> <out.jsonl> [MiB] [MBps] [rttMs] | one <mode> <file> <cut> <MBps> <rttMs>");
}
