// One machine of S5 (the owner or a teammate), in its own process, as the app's media side would run: its range cache
// on disk (FsLeafCache) and its open uploads remembered on disk (FsUploadStateStore) under <home>, and a store reached
// as the app would reach it (blob-fs on a shared folder, blob-s3, or the host's HTTP media API). Commands on stdin, one
// JSON object per line with a `seq`; the reply carries the same `seq` (or `error`). Progress and reader events are
// printed as they happen, so the scenario can act mid-upload (kill this process, cut its link).
//   S5_STORE=<store JSON> s5-machine <home>
//
// The store goes in the environment, not the command line, since it may hold keys. Store JSON: {kind:"fs", root} | {kind:"s3", endpoint, bucket, region, accessKeyId, secretAccessKey}
//           | {kind:"http", baseUrl, projectId, token}
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { BlobStore, ProxyEncoder } from "@carton/core/plugins";
import { createFsBlobStore } from "@carton/blob-fs";
import { createS3BlobStore } from "@carton/blob-s3";
import { mediaHash, MediaReader, serveMedia, toMediaRecord, uploadMedia, type RangeSource, type ReaderEvent } from "@carton/media";
import { FsLeafCache, FsUploadStateStore, fileSource, hashFile, hostProxyEncoder, nodeHasher, shareMedia, startRangeServer, type RangeServer, type ShareEvent } from "@carton/media/node";
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
        store,
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
          store,
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
