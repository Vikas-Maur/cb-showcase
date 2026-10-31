// S5's stores and media. Three ways a machine reaches the shared store, each with real processes and files:
//   - blob-fs: one folder both machines see (a shared drive);
//   - blob-s3: a local VersityGW (a strict SigV4 S3 gateway, hosts-plugins' harness), one fresh bucket per test;
//   - host-http: a real server-node process (blob-fs behind it) through its HTTP media API, one host per test.
// The S3 gateway and the host can be reached through a Link (support/s5-link.ts) to count, slow or cut the bytes.
// Test media: small H.264 clips from ffmpeg's lavfi test source with noise (so they don't compress to nothing), or
// random bytes when ffmpeg isn't on PATH (then only the tests that need no decoder run).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pkg, scratchRoot, support } from "./env.ts";
import type { Link } from "./s5-link.ts";
import type { Proc, Procs } from "./procs.ts";
import { readEnvelope, type Machine } from "./project.ts";

export const MiB = 1024 * 1024;
export const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
export const FFPROBE = process.env.FFPROBE ?? "ffprobe";

export function haveFfmpeg(): boolean {
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-version"], { stdio: "ignore" });
    execFileSync(FFPROBE, ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ media

export interface Clips {
  /** Decodable H.264 clips (else random bytes). */
  playable: boolean;
  /** The camera original the sample project lists: ~12 MiB, so it goes up in two 8 MiB parts. */
  original: string;
  /** Cardboard's own proxy of it: 640x360, 600 kbit/s, moov first, so media reuses it as the collab proxy. */
  hostProxy: string;
  /** A ~26 MiB original for the resume cases: four parts. */
  big: string;
  /** A ~12 MiB collab proxy (moov first) for the streaming cases: two parts. */
  proxy: string;
}

function encode(path: string, seconds: number, o: { size?: string; kbps?: number; faststart?: boolean; noise?: boolean; freq?: number }): void {
  execFileSync(FFMPEG, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${o.size ?? "640x360"}:rate=30:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=${o.freq ?? 440}:sample_rate=48000:duration=${seconds}`,
    ...(o.noise ? ["-vf", "noise=alls=40:allf=t"] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p",
    ...(o.kbps ? ["-b:v", `${o.kbps}k`, "-maxrate", `${o.kbps}k`, "-bufsize", `${o.kbps * 2}k`] : ["-crf", "16"]),
    "-c:a", "aac", "-b:a", "96k", "-shortest",
    ...(o.faststart ? ["-movflags", "+faststart"] : []),
    path,
  ], { stdio: ["ignore", "ignore", "inherit"], timeout: 120_000 });
}

export function makeClips(dir: string): Clips {
  mkdirSync(dir, { recursive: true });
  const c: Clips = { playable: haveFfmpeg(), original: join(dir, "camera.mp4"), hostProxy: join(dir, "host-proxy.mp4"), big: join(dir, "big.mp4"), proxy: join(dir, "proxy.mp4") };
  if (c.playable) {
    encode(c.original, 2.5, { noise: true });
    encode(c.hostProxy, 2.5, { kbps: 600, faststart: true });
    encode(c.big, 5.5, { noise: true, freq: 550 });
    encode(c.proxy, 2.5, { noise: true, faststart: true, freq: 660 });
  } else {
    writeFileSync(c.original, randomBytes(12 * MiB + 12345));
    writeFileSync(c.hostProxy, randomBytes(300_000));
    writeFileSync(c.big, randomBytes(26 * MiB + 777));
    writeFileSync(c.proxy, randomBytes(12 * MiB + 4321));
  }
  return c;
}

/** The sample project's video (Cardboard's `media[]` entry) and where its file belongs in the bundle. */
export function sampleVideo(m: Machine): { record: Record<string, unknown>; path: string } {
  const env = readEnvelope(m) as unknown as { project: { media: { id: string; data: Record<string, any> }[] }; media: { mediaId: string; nativePath: string }[] };
  const v = env.project.media.find((x) => x.data.type === "video")!;
  const native = env.media.find((x) => x.mediaId === v.id)!.nativePath;
  const d = v.data;
  return {
    record: { id: v.id, kind: "video", fileName: d.fileName, size: d.size, durationSec: d.duration, width: d.width, height: d.height, fps: d.frameRate, hasAudio: d.hasAudio, mime: "video/mp4" },
    path: native,
  };
}

/** Puts the clip where the project says its media is (the bundle's media/ folder). */
export function placeOriginal(m: Machine, from: string): string {
  const { path } = sampleVideo(m);
  mkdirSync(join(path, ".."), { recursive: true });
  copyFileSync(from, path);
  return path;
}

/** Cardboard's own proxy of the clip, in the bundle's proxies/ folder. */
export function placeHostProxy(m: Machine, from: string): string {
  const dir = join(m.bundle, "proxies");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sampleVideo(m).record.id}.mp4`);
  copyFileSync(from, path);
  return path;
}

// ------------------------------------------------------------------ machines and the host

/** A machine's media process (support/s5-machine.ts). The store config goes in the environment: it may hold keys. */
export async function startMachine(procs: Procs, name: string, home: string, store: string): Promise<Proc> {
  const p = procs.start(name, [support("s5-machine.ts"), home], { env: { S5_STORE: store, FFPROBE, FFMPEG } });
  await p.next((x) => x.ready, 30_000);
  return p;
}

export interface Host {
  proc: Proc;
  port: number;
  httpUrl: string;
  blobRoot: string;
  /** Session tokens per project, for the owner and the teammate (editors). */
  tokens: Record<string, { owner: string; mate: string }>;
}

/** A server-node process serving `projectIds` (support/s5-host.ts); data under `dir`, so a restart keeps it. */
export async function startHost(procs: Procs, dir: string, projectIds: string[], port = 0, team?: string): Promise<Host> {
  const proc = procs.start("host", [support("s5-host.ts"), dir, projectIds.join(","), String(port)], team ? { env: { S5_TEAM: team } } : {});
  const r = await proc.next((x) => x.ready, 30_000);
  return { proc, port: r.port, httpUrl: r.httpUrl, blobRoot: r.blobRoot, tokens: r.tokens };
}

/** A machine's store config for a project on a host, through `link` when given. */
export const hostStore = (host: Host, projectId: string, who: "owner" | "mate", link?: Link | null): string =>
  JSON.stringify({ kind: "http", baseUrl: link?.url ?? host.httpUrl, projectId, token: host.tokens[projectId]![who] });

// ------------------------------------------------------------------ the store, three ways

export type StoreKind = "blob-fs" | "blob-s3" | "host-http";

export interface StoreSide {
  kind: StoreKind;
  /** The port a Link connects to (the gateway or the host); null for a shared folder. */
  target: number | null;
  /** A machine's store config (JSON), through `link` when given. */
  storeFor(who: "owner" | "mate", link?: Link | null): string;
  /** The file holding the object's bytes on the store's disk (to damage it), or null. */
  objectFile(hash: string): string | null;
  host?: Host;
}

interface Gateway {
  endpoint: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  dataDir: string;
  stop(): Promise<void>;
}
interface GatewayModule {
  versitygwMissingReason(): string | null;
  startVersityGw(o?: { timeoutMs?: number }): Promise<Gateway>;
  createBucket(g: Gateway, bucket: string): Promise<void>;
}

let gwModule: Promise<GatewayModule> | null = null;
let gateway: Promise<Gateway> | null = null;
let buckets = 0;

/** hosts-plugins' VersityGW harness, with its data under our scratch (it reads the folder when imported). */
function gatewayModule(): Promise<GatewayModule> {
  process.env.CARTON_S3_SCRATCH ??= join(scratchRoot(), "s3");
  gwModule ??= import(pathToFileURL(pkg("blob-s3", "test", "versitygw.ts")).href) as Promise<GatewayModule>;
  return gwModule;
}

/** Why the S3 cases can't run here, or null. */
export async function s3MissingReason(): Promise<string | null> {
  return (await gatewayModule()).versitygwMissingReason();
}

export async function stopGateway(): Promise<void> {
  if (gateway) await (await gateway).stop();
  gateway = null;
}

/** The store `kind` for one test; a host serves `projectId` and any `moreProjects`. */
export async function openSide(kind: StoreKind, procs: Procs, dir: string, projectId: string, moreProjects: string[] = [], team?: string): Promise<StoreSide> {
  if (kind === "blob-fs") {
    const root = join(dir, "shared-drive");
    return {
      kind,
      target: null,
      storeFor: () => JSON.stringify({ kind: "fs", root }),
      objectFile: (hash) => join(root, "objects", "m", `${hash}~b`),
    };
  }
  if (kind === "blob-s3") {
    const mod = await gatewayModule();
    gateway ??= mod.startVersityGw();
    const gw = await gateway;
    const bucket = `s5-media-${process.pid}-${++buckets}`;
    await mod.createBucket(gw, bucket);
    return {
      kind,
      target: Number(new URL(gw.endpoint).port),
      storeFor: (_who, link) =>
        JSON.stringify({ kind: "s3", endpoint: link?.url ?? gw.endpoint, bucket, region: gw.region, accessKeyId: gw.credentials.accessKeyId, secretAccessKey: gw.credentials.secretAccessKey }),
      objectFile: (hash) => {
        const f = join(gw.dataDir, "posix", bucket, "m", hash);
        return existsSync(f) ? f : null;
      },
    };
  }
  const host = await startHost(procs, join(dir, "host"), [projectId, ...moreProjects], 0, team);
  return {
    kind,
    target: host.port,
    host,
    storeFor: (who, link) => hostStore(host, projectId, who, link),
    objectFile: (hash) => findFile(join(host.blobRoot, "objects"), `${hash}~b`),
  };
}

function findFile(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (e.name === name) return p;
  }
  return null;
}
