// One machine of S5 (the owner or a teammate), in its own process, as the app's media side would run: its range cache
// on disk (FsLeafCache) and its open uploads remembered on disk (FsUploadStateStore) under <home>, and a store reached
// as the app would reach it (blob-fs on a shared folder, blob-s3, or the host's HTTP media API). Commands on stdin, one
// JSON object per line with a `seq`; the reply carries the same `seq` (or `error`). Progress and reader events are
// printed as they happen, so the scenario can act mid-upload (kill this process, cut its link).
//   S5_STORE=<store JSON> s5-machine <home>
//
// Collab proxies are segmented streams (media's stream.ts): `share` with `holdEnd` puts every segment but holds the
// stream's `end` entry until `release` (prints {endHeld}, then {endSent}), so "while the proxy uploads" lasts as long
// as a test needs; `play` reads a stream as a player does (init, then each segment, verified, waiting for the rest).
//
// The store goes in the environment, not the command line, since it may hold keys. Store JSON: {kind:"fs", root} | {kind:"s3", endpoint, bucket, region, accessKeyId, secretAccessKey}
//           | {kind:"http", baseUrl, projectId, token}
//
// An upload with `holdComplete` sends its parts but doesn't complete the object until `release`: prints
// {completeHeld} when it gets there and {completeSent} once released, so "while it uploads" lasts as long as a test
// needs, whatever the runner's speed. `project` reads the media records from this machine's own Carton (its head), as
// the app finds what a teammate shared; `proxyOf` follows a source's proxy pointer in the store (§11).
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { BlobStore, ByteRange, MultipartUpload, ProxyEncoder } from "@carton/core/plugins";
import type { HostAdapter } from "@carton/core";
import { createFsBlobStore } from "@carton/blob-fs";
import { createS3BlobStore } from "@carton/blob-s3";
import { cardboardAdapter } from "@carton/cardboard";
import { openLocal } from "@carton/local";
import { COLLAB_PROXY_720P, mediaHash, MediaReader, ProxyStreamReader, proxyPointerKey, serveMedia, toMediaRecord, uploadMedia, type RangeSource, type ReaderEvent } from "@carton/media";
import { FsLeafCache, FsUploadStateStore, fileSource, hashFile, hostProxyEncoder, nodeHasher, shareMedia, startRangeServer, type RangeServer, type ShareEvent } from "@carton/media/node";
import { locateCartonDb } from "@carton/store-sqlite";
import { assertInScratch, dataDirFor } from "./env.ts";
import { HostBlobStore } from "./s5-host-store.ts";

const [home] = process.argv.slice(2) as [string];
const cfg = JSON.parse(process.env.S5_STORE ?? "{}") as Record<string, string> & { kind: "fs" | "s3" | "http" };

function makeStore(): BlobStore {
  if (cfg.kind === "fs") return createFsBlobStore({ root: cfg.root, minPartSize: 5 * 1024 * 1024, durable: false });
  if (cfg.kind === "s3") return createS3BlobStore({ endpoint: cfg.endpoint, bucket: cfg.bucket, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
  return new HostBlobStore({ baseUrl: cfg.baseUrl, projectId: cfg.projectId, token: cfg.token });
}

const store = makeStore();
const cache = new FsLeafCache(join(home, "media-cache"));
const uploads = new FsUploadStateStore(join(home, "uploads"));
let events: ReaderEvent[] = [];
const reader = new MediaReader({
  store,
  hasher: nodeHasher,
  cache,
  retryDelayMs: 50,
  contentType: () => "video/mp4",
  onEvent: (e) => {
    events.push(e);
    out({ readerEvent: e });
  },
});
const servers: (RangeServer | Server)[] = [];

const out = (x: unknown) => process.stdout.write(JSON.stringify(x) + "\n");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Proxy encoders for a share: Cardboard's own proxy (when the machine has one), then one that must never run. */
function encoders(hostProxy: string | null): ProxyEncoder[] {
  const never: ProxyEncoder = {
    name: "must-not-run",
    hardware: false,
    probe: async () => true,
    encode: async () => {
      throw new Error("encoded a proxy although Cardboard's proxy or a teammate's should have been used");
    },
  };
  return [hostProxyEncoder({ locate: () => hostProxy, ffprobe: process.env.FFPROBE ?? "ffprobe" }), never];
}

/** A file on this machine as a RangeSource: how the uploader plays its own proxy while it uploads. */
function localSource(path: string, hash: string): RangeSource {
  return {
    async stat(h) {
      if (h !== hash) return null;
      const fh = await open(path, "r");
      try {
        return { size: (await fh.stat()).size, contentType: "video/mp4" };
      } finally {
        await fh.close();
      }
    },
    async *read(h, offset, length) {
      if (h !== hash) return;
      const src = await fileSource(path);
      try {
        const end = Math.min(src.size, offset + length);
        for (let at = offset; at < end; at += 1 << 20) yield await src.read(at, Math.min(1 << 20, end - at));
      } finally {
        await src.close();
      }
    },
  };
}

/** Opens the completions `holdCompletes` is holding back. */
let releaseHeld: (() => void) | null = null;

/** `s` with its multipart uploads' completion held until `releaseHeld()`; everything else goes straight through. */
function holdCompletes(s: BlobStore): BlobStore {
  const gate = new Promise<void>((r) => (releaseHeld = r));
  const wrap = (up: MultipartUpload): MultipartUpload => ({
    key: up.key,
    uploadId: up.uploadId,
    uploadPart: (n, data) => up.uploadPart(n, data),
    listParts: () => up.listParts(),
    abort: () => up.abort(),
    complete: async (parts) => {
      out({ completeHeld: up.key });
      await gate;
      out({ completeSent: up.key });
      return up.complete(parts);
    },
  });
  return {
    kind: s.kind,
    put: (key, data, opts) => s.put(key, data, opts),
    get: (key, range) => s.get(key, range),
    ...(s.getStream ? { getStream: (key: string, range?: ByteRange) => s.getStream!(key, range) } : {}),
    head: (key) => s.head(key),
    delete: (key) => s.delete(key),
    list: (prefix, opts) => s.list(prefix, opts),
    createMultipart: async (key, opts) => wrap(await s.createMultipart(key, opts)),
    resumeMultipart: async (key, uploadId) => wrap(await s.resumeMultipart(key, uploadId)),
    ...(s.signedUrl ? { signedUrl: (key: string, opts: { method: "GET" | "PUT"; expiresIn: number }) => s.signedUrl!(key, opts) } : {}),
  };
}

/** `s` with a stream's `end` entry (ps/<stream>/end) held until `releaseHeld()`: its segments go up, it never ends. */
function holdStreamEnd(s: BlobStore): BlobStore {
  const gate = new Promise<void>((r) => (releaseHeld = r));
  return new Proxy(s, {
    get(target, prop) {
      if (prop !== "put") {
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v; // stores may be classes with private fields
      }
      return async (key: string, data: Uint8Array, opts?: unknown) => {
        if (/^ps\/[0-9a-f]{64}\/end$/.test(key)) {
          out({ endHeld: key });
          await gate;
          out({ endSent: key });
        }
        return (target.put as (k: string, d: Uint8Array, o?: unknown) => Promise<unknown>)(key, data, opts);
      };
    },
  });
}

/** The player's route: `GET /p/<hash>` answered by serveMedia, as protocol.handle("cardboard-media") would. */
async function startPlayer(source: RangeSource): Promise<string> {
  const server = createServer((req, res) => {
    void (async () => {
      const hash = (req.url ?? "").replace(/^\/p\//, "");
      const ctl = new AbortController();
      res.on("close", () => ctl.abort());
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      try {
        const r = await serveMedia(source, hash, new Request(`http://player${req.url}`, { method: req.method, headers, signal: ctl.signal }));
        const h: Record<string, string> = {};
        r.headers.forEach((v, k) => (h[k] = v));
        res.writeHead(r.status, h);
        if (!r.body) return void res.end();
        const body = Readable.fromWeb(r.body as import("node:stream/web").ReadableStream<Uint8Array>);
        body.on("error", () => res.destroy());
        body.pipe(res);
      } catch {
        res.destroy();
      }
    })();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  servers.push(server);
  const a = server.address();
  return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/p/`;
}

type Cmd = Record<string, any> & { cmd: string; seq: number };

async function run(c: Cmd): Promise<Record<string, unknown>> {
  switch (c.cmd) {
    case "share": {
      const shareEvents: ShareEvent[] = [];
      const r = await shareMedia({
        store: c.holdEnd ? holdStreamEnd(store) : store,
        ...(process.env.FFMPEG ? { ffmpeg: process.env.FFMPEG } : {}),
        record: toMediaRecord(c.record),
        local: { original: c.original },
        policy: { originals: c.originals === true, proxies: c.proxies !== false },
        encoders: encoders(c.hostProxy ?? null),
        workDir: join(home, "work"),
        uploadState: uploads,
        onEvent: (e) => {
          shareEvents.push(e);
          out({ shareEvent: e });
        },
      });
      return { record: r.record, skipped: r.skipped, events: shareEvents };
    }
    case "upload": {
      const manifest = await hashFile(c.path);
      out({ hashed: manifest.hash, size: manifest.size });
      const source = await fileSource(c.path);
      try {
        const result = await uploadMedia({
          store: c.holdComplete ? holdCompletes(store) : store,
          hasher: nodeHasher,
          source,
          manifest,
          state: uploads,
          contentType: c.contentType,
          ...(c.retries !== undefined ? { retries: c.retries } : {}),
          ...(c.retryDelayMs !== undefined ? { retryDelayMs: c.retryDelayMs } : {}),
          onProgress: (p) => out({ progress: p }),
        });
        return { result };
      } finally {
        await source.close();
      }
    }
    case "release": {
      const held = releaseHeld !== null;
      releaseHeld?.();
      return { released: held };
    }
    case "project": {
      // the media records as this machine's own carton.db has them at head, opened as `cb` opens a project
      const dataDir = dataDirFor(c.bundle);
      assertInScratch(locateCartonDb({ bundleDir: c.bundle, projectId: c.projectId, appDataDir: dataDir }).dbPath, "carton.db");
      const local = await openLocal({ projectDir: c.bundle, projectId: c.projectId, dataDir, adapter: cardboardAdapter as HostAdapter });
      try {
        const { doc } = await local.carton.head();
        return { dbPath: local.dbPath, media: doc.media ?? [] };
      } finally {
        await local.close();
      }
    }
    case "proxyOf": {
      // the collab proxy made from source `hash` with the app's profile: the pointer keyed by (source hash, profile)
      const b = await store.get(proxyPointerKey(c.hash, c.profile ?? COLLAB_PROXY_720P.id));
      return { pointer: b ? JSON.parse(new TextDecoder().decode(b)) : null };
    }
    case "play": {
      // a stream as a player reads it: init, then each segment verified, waiting for the ones still uploading; `segments`
      // stops after that many (a teammate mid-upload); `save` writes what was played (for ffprobe)
      events = [];
      const sr = new ProxyStreamReader({ store, media: reader, id: c.stream, pollMs: 100, maxPollMs: 500 });
      const parts: Uint8Array[] = [];
      let segments = 0;
      let init = 0;
      let failed: string | undefined;
      try {
        for await (const p of sr.play()) {
          parts.push(p.bytes.slice());
          if (p.part === "init") init = p.bytes.length;
          else if (++segments === c.segments) break;
        }
      } catch (e) {
        failed = `${(e as Error).name}: ${(e as Error).message}`;
      }
      const all = Buffer.concat(parts);
      if (c.save) {
        assertInScratch(c.save, "played stream");
        await writeFile(c.save, all);
      }
      return { init, segments, bytes: all.length, sha256: sha(all), ended: (await sr.end().catch(() => null)) ?? null, failed, events };
    }
    case "stat":
      return { stat: await reader.stat(c.hash) };
    case "read": {
      // mode: "play" (play first, verify after), "tool" (verified before it goes out), "verified" (readVerified)
      events = [];
      const parts: Uint8Array[] = [];
      let n = 0;
      let failed: string | undefined; // not `error`: that names a failed command
      try {
        if (c.mode === "verified") {
          const b = await reader.readVerified(c.hash, c.offset ?? 0, c.length ?? Number.MAX_SAFE_INTEGER);
          parts.push(b);
          n = b.length;
        } else {
          const src = c.mode === "tool" ? reader.toolSource() : reader;
          for await (const piece of src.read(c.hash, c.offset ?? 0, c.length ?? Number.MAX_SAFE_INTEGER)) {
            parts.push(piece.slice());
            n += piece.length;
          }
        }
      } catch (e) {
        failed = `${(e as Error).name}: ${(e as Error).message}`;
      }
      const all = Buffer.concat(parts);
      const whole = !failed && (c.offset ?? 0) === 0 && c.length === undefined;
      return { bytes: n, sha256: sha(all), mediaHash: whole ? (await mediaHash(all, nodeHasher)).hash : null, failed, events };
    }
    case "serve": {
      // tools: the loopback range server on verified bytes; the player: serveMedia, play first
      const tools = await startRangeServer({ source: reader.toolSource() });
      servers.push(tools);
      return { toolUrl: tools.url(c.hash), playUrl: (await startPlayer(reader)) + c.hash };
    }
    case "serveLocal": {
      const src = localSource(c.path, c.hash);
      const tools = await startRangeServer({ source: src });
      servers.push(tools);
      return { toolUrl: tools.url(c.hash) };
    }
    default:
      throw new Error(`unknown command ${c.cmd}`);
  }
}

out({ ready: true, pid: process.pid });
setTimeout(() => process.exit(0), 600_000).unref(); // never outlive the test run
for await (const line of createInterface({ input: process.stdin })) {
  const c = JSON.parse(line) as Cmd;
  if (c.cmd === "exit") {
    await Promise.all(servers.map((s) => ("url" in s ? s.close() : new Promise((r) => s.close(r)))));
    process.exit(0);
  }
  run(c).then(
    (r) => out({ ...r, seq: c.seq }),
    (e: Error) => out({ seq: c.seq, error: `${e?.name}: ${e?.message}` }),
  );
}
