// The lab's laptop client: one self-contained script (bundled by build.mjs into cf-lab-laptop.mjs) that a person runs
// on their own machine and home network against the deployed lab Worker, so the lab has numbers from a real last
// mile, not just from the lab box. It runs Carton's real client code: core's ReplicaQueue and SyncClient over
// server-node's WebSocket transport (as the harness's party.ts does), and @carton/media's uploadMedia and MediaReader
// through host-http's media client (hostMediaBlobs), as the app shares and plays media.
//
//   node cf-lab-laptop.mjs [config.json] [--upload-mb 200] [--skip probe,sync,offline,upload,dedup,download,shaped]
//                          [--out file] [--max-minutes 20]
//
// The steps, in this order, each with its own time limit, a failure recorded rather than fatal, the whole run capped
// at --max-minutes (20):
//   probe     DNS, TCP connect and TLS handshake times, 10 timed GET /api/health, WebSocket connect times, and the
//             Cloudflare location serving this network (/cdn-cgi/trace: `colo`, `loc`, `http`, `tls` only; the
//             machine's IP is never recorded)
//   sync      replicas A and B, each its own SyncClient and WebSocket, 60 edits alternating at ~1/s. Per edit: commit to
//             the other replica holding it confirmed, commit to its own confirm, and convergence (the later of the
//             two); p50/p90/p99 and every value. Lost edits, duplicate rows, order, conflict cards, same final state.
//   offline   replica C through a local proxy (proxy.ts) whose link goes dead for 45 s (--hole-sec; no close, like
//             Wi-Fi dropping) while C and A both keep editing: when C shows offline, when it is back online after the
//             link returns, how long until everything is caught up both ways, lost edits, conflict cards.
//   upload    a synthetic incompressible file (--upload-mb, default from the config, at most 300 MB) uploaded with
//             uploadMedia as the app shares media, while A and B keep editing every 3 s (edit latency during a
//             saturated uplink). If the link is too slow to finish in time, it starts again once, smaller.
//   dedup     the same content again from a fresh upload state (another machine sharing the same file): nothing sent
//   download  the first 16 MiB back through MediaReader (the app's read path: growing range requests, each 1 MiB leaf
//             checked against the manifest, network failures retried), compared with what was sent
//   shaped    optional, last, only if time is left: replica D through the same proxy shaped to ~1 Mbit/s and 100 ms
//             each way (3G-like) joins and edits with A (--shaped-hole-sec > 0 adds a dead-link cut on that link)
// The results JSON goes next to this script (or --out) and is rewritten after every step and on Ctrl+C, so a stopped
// run still leaves what it measured. No secrets in here: the config holds session tokens for one lab project, minted
// for 48 hours at most.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, cpus, totalmem, platform, arch, release, homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import tls from "node:tls";
import { sync, hashDoc } from "@carton/core";
import { webSocketTransport } from "@carton/server-node/transport";
import { hostMessageBlobs, hostMediaBlobs } from "@carton/host-http/client";
import { MediaReader, mediaHash, uploadMedia, type ByteSource, type Manifest, type ReaderEvent } from "@carton/media";
import { nodeHasher, FsUploadStateStore } from "@carton/media/node";
import { DOC0, schema, SCHEMA_VERSION, genEdit, rng, stats } from "../common.ts";
import { LinkProxy } from "./proxy.ts";

declare const CF_LAB_BUILD: Record<string, unknown> | undefined;
const BUILD = typeof CF_LAB_BUILD !== "undefined" ? CF_LAB_BUILD : { from: "source" };

// ---------------------------------------------------------------- setup
const major = Number(process.versions.node.split(".")[0]);
const getBuiltin = (process as { getBuiltinModule?: unknown }).getBuiltinModule;
if (major < 22 || typeof globalThis.WebSocket !== "function" || typeof getBuiltin !== "function") {
  console.error(`This needs Node.js 22.3 or newer (this is ${process.version}). Install the LTS version from https://nodejs.org and run it again.`);
  process.exit(2);
}

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    // default: the config's uploadMB (set when the config was made), else 200
    "upload-mb": { type: "string", default: "" },
    "download-mib": { type: "string", default: "16" },
    "part-mib": { type: "string", default: "" },
    concurrency: { type: "string", default: "" },
    edits: { type: "string", default: "60" },
    "interval-ms": { type: "string", default: "1000" },
    // longer than the transport's dead-link check (a ping after 15 s of silence, dead 15 s later), so the client
    // really shows offline, reconnects, and sends what it made meanwhile
    "hole-sec": { type: "string", default: "45" },
    "hole-edits": { type: "string", default: "5" },
    // during the upload, A and B edit every this many seconds (0: no edits during the upload)
    "upload-edit-sec": { type: "string", default: "3" },
    "shaped-kbps": { type: "string", default: "1000" },
    "shaped-delay-ms": { type: "string", default: "100" },
    "shaped-edits": { type: "string", default: "20" },
    "shaped-hole-sec": { type: "string", default: "0" },
    skip: { type: "string", default: "" },
    "max-minutes": { type: "string", default: "20" },
    out: { type: "string", default: "" },
    help: { type: "boolean", default: false },
  },
});
if (args.help) {
  console.log("node cf-lab-laptop.mjs [config.json] [--upload-mb 200] [--skip probe,sync,offline,upload,dedup,download,shaped] [--out results.json] [--max-minutes 20]");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(positionals[0] ?? join(here, "config.json"));
interface Config {
  host: string;
  projectId: string;
  branch: string;
  tokens: { a: string; b: string; c: string };
  createdAt?: string;
  expiresAt?: string;
  uploadMB?: number;
  transport?: Record<string, unknown>;
}
let cfg: Config;
try {
  cfg = JSON.parse(readFileSync(configPath, "utf8")) as Config;
  if (!/^https:\/\//.test(cfg.host) || !cfg.projectId || !cfg.branch || !cfg.tokens?.a || !cfg.tokens?.b || !cfg.tokens?.c) throw new Error("missing fields");
} catch (e) {
  console.error(`Couldn't read the config file ${configPath}: ${(e as Error).message}. Put config.json next to this script, or pass its path.`);
  process.exit(2);
}
if (cfg.expiresAt && Date.parse(cfg.expiresAt) < Date.now()) {
  console.error(`This config expired at ${cfg.expiresAt}. Ask for a fresh config.json.`);
  process.exit(2);
}

const num = (name: string, v: string | undefined, min: number, max: number): number => {
  const x = Number(v);
  if (!Number.isFinite(x) || x < min || x > max) {
    console.error(`--${name} must be a number from ${min} to ${max}`);
    process.exit(2);
  }
  return x;
};
// the lab's cap: at most 300 MB sent from a person's network
const UPLOAD_MB = num("upload-mb", args["upload-mb"] || String(cfg.uploadMB ?? 200), 1, 300);
const DOWNLOAD_MIB = num("download-mib", args["download-mib"], 1, 64);
const EDITS = num("edits", args.edits, 2, 600), INTERVAL = num("interval-ms", args["interval-ms"], 100, 10_000);
const HOLE_MS = num("hole-sec", args["hole-sec"], 1, 300) * 1000, HOLE_EDITS = num("hole-edits", args["hole-edits"], 1, 50);
const UPLOAD_EDIT_MS = num("upload-edit-sec", args["upload-edit-sec"], 0, 60) * 1000;
const SHAPED = {
  kbps: num("shaped-kbps", args["shaped-kbps"], 16, 1_000_000),
  delayMs: num("shaped-delay-ms", args["shaped-delay-ms"], 0, 2000),
  edits: num("shaped-edits", args["shaped-edits"], 2, 200),
  holeMs: num("shaped-hole-sec", args["shaped-hole-sec"], 0, 300) * 1000,
};
const MAX_MS = num("max-minutes", args["max-minutes"], 2, 120) * 60_000;
const PART_MIB = args["part-mib"] ? num("part-mib", args["part-mib"], 8, 64) : 0;
const CONCURRENCY = args.concurrency ? num("concurrency", args.concurrency, 1, 8) : 0;
const skip = new Set(args.skip!.split(",").map((s) => s.trim()).filter(Boolean));

const HOST = cfg.host.replace(/\/+$/, "");
const B = cfg.branch;
const wsUrl = (origin: string) => `${origin.replace(/^http/, "ws")}/api/projects/${encodeURIComponent(cfg.projectId)}/ws`;

const now = () => performance.timeOrigin + performance.now();
const T0 = now();
const deadline = T0 + MAX_MS;
const runRid = randomBytes(4).toString("hex");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
// next to the bundle a person runs; next to the config when run from the repo's source
const outPath = resolve(args.out || join(BUILD.from === "source" ? dirname(configPath) : here, `cf-lab-results-${stamp}.json`));
const clock = () => {
  const s = Math.floor((now() - T0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const log = (m: string) => console.log(`[${clock()}] ${m}`);

// What leaves this machine in the results: no paths with the user's name, no IP addresses but loopback, no session
// tokens, no query strings (a signed URL's signature).
const home = homedir(), user = (() => { try { return userInfo().username; } catch { return ""; } })();
const secretsInText = Object.values(cfg.tokens).filter((t) => t.length > 8);
function clean(s: string): string {
  let o = s;
  for (const t of secretsInText) o = o.split(t).join("<token>");
  if (home) o = o.split(home).join("~");
  if (user && user.length > 2) o = o.split(user).join("<user>");
  o = o.replace(/(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>]*/g, "$1?…");
  o = o.replace(/\b(?!127\.)\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>");
  // IPv6: a "::" or six or more groups (so a clock time like 12:34:56 stays)
  o = o.replace(/(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi, (m) => (m.includes("::") || m.split(":").length >= 6 ? "<ip>" : m));
  return o.slice(0, 400);
}
const msg = (e: unknown): string => {
  const err = e as { message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const cause = err?.cause ? ` (${String(err.cause.code ?? err.cause.message ?? "")})` : "";
  return clean(String(err?.message ?? e) + cause);
};
const r0 = (x: number) => (Number.isFinite(x) ? Math.round(x) : null);
const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const mbit = (bytes: number, ms: number) => r1((bytes * 8) / 1e6 / (ms / 1000));
/** p50/p90/p99/max/mean, and every value (rounded ms) in the order given. */
const st = (xs: number[]) => {
  const s = stats(xs);
  return { n: s.n, p50: r0(s.p50), p90: r0(s.p90), p99: r0(s.p99), max: r0(s.max), mean: r0(s.mean), values: xs.map(r0) };
};

const R: Record<string, any> = {
  tool: "cf-lab-laptop",
  version: 2,
  build: BUILD,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  host: HOST,
  projectId: cfg.projectId,
  config: { createdAt: cfg.createdAt ?? null, expiresAt: cfg.expiresAt ?? null },
  run: runRid,
  args: { uploadMB: UPLOAD_MB, downloadMiB: DOWNLOAD_MIB, edits: EDITS, intervalMs: INTERVAL, holeMs: HOLE_MS, holeEdits: HOLE_EDITS, uploadEditMs: UPLOAD_EDIT_MS, shaped: SHAPED, maxMinutes: MAX_MS / 60_000, partMiB: PART_MIB || null, concurrency: CONCURRENCY || null, skip: [...skip], transport: cfg.transport ?? null },
  env: { node: process.version, platform: platform(), arch: arch(), osRelease: release(), cpus: cpus().length, cpuModel: cpus()[0]?.model ?? null, memGB: Math.round(totalmem() / 1e9) },
  steps: {} as Record<string, any>,
  failures: [] as { step: string; error: string }[],
  bytes: { up: 0, down: 0 },
};
function save(): void {
  try {
    writeFileSync(outPath, JSON.stringify(R, null, 1));
  } catch (e) {
    console.error(`couldn't write ${outPath}: ${(e as Error).message}`);
  }
}
process.on("uncaughtException", (e) => {
  R.failures.push({ step: "uncaught", error: msg(e) });
  log(`unexpected error (continuing): ${msg(e)}`);
});
process.on("unhandledRejection", (e) => {
  R.failures.push({ step: "unhandled", error: msg(e) });
});

// The running step's "what I have so far" summaries: called on Ctrl+C (or a closed window) and when a step fails or
// times out, so the results hold the partial step too. Each step has its own set, so a step's late cleanup can't add
// to the next one's.
type OnPartial = (f: () => void) => () => void;
let partials = new Set<() => void>();
const runPartials = (set: Set<() => void>) => {
  for (const f of set) {
    try {
      f();
    } catch (e) {
      R.failures.push({ step: "partial", error: msg(e) });
    }
  }
};
let stopping = false;
function interrupted(why: string): void {
  if (stopping) return;
  stopping = true;
  runPartials(partials);
  R.interrupted = why;
  R.finishedAt = new Date().toISOString();
  R.totalMs = r0(now() - T0);
  save();
  console.log(`\nStopped. What was measured so far is in ${outPath}`);
  process.exit(130);
}
// Ctrl+C; Windows also sends SIGHUP when the console window is closed (a few seconds before it ends the process),
// and SIGBREAK on Ctrl+Break
for (const s of ["SIGINT", "SIGTERM", "SIGHUP", ...(platform() === "win32" ? ["SIGBREAK"] : [])]) process.on(s, () => interrupted(s));

// ---------------------------------------------------------------- helpers
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((ok, no) => {
    if (signal?.aborted) return no(signal.reason);
    const t = setTimeout(() => (signal?.removeEventListener("abort", stop), ok()), Math.max(0, ms));
    const stop = () => (clearTimeout(t), no(signal!.reason));
    signal?.addEventListener("abort", stop, { once: true });
  });
}
/** Polls `pred` until it holds (true) or `ms` pass (false). Event times come from the events, not from this. */
async function until(pred: () => boolean, ms: number, signal: AbortSignal): Promise<boolean> {
  const end = now() + ms;
  while (!pred()) {
    if (now() > end) return false;
    await sleep(20, signal);
  }
  return true;
}
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();

/**
 * Runs one step under its own time limit (and what is left of the run's). `fn` fills `out`, and registers with
 * `partial` what summarizes its work so far. An optional step that doesn't fit in the time left is skipped without
 * counting as a failure.
 */
async function step(
  name: string,
  budgetMs: number,
  fn: (signal: AbortSignal, out: Record<string, any>, endsAt: number, partial: OnPartial) => Promise<void>,
  opt: { optional?: boolean; minMs?: number } = {},
): Promise<boolean> {
  const out: Record<string, any> = (R.steps[name] = {});
  if (skip.has(name)) return (out.skipped = true), save(), false;
  const ms = Math.min(budgetMs, deadline - now() - 10_000);
  if (ms < (opt.minMs ?? 15_000)) {
    out.skipped = "out of time";
    if (!opt.optional) R.failures.push({ step: name, error: "skipped: the run's time limit" });
    save();
    return false;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
  lag.reset();
  const t = now();
  log(`${name}: starting (limit ${Math.round(ms / 1000)} s)`);
  const mine = (partials = new Set());
  const partial: OnPartial = (f) => (mine.add(f), () => void mine.delete(f));
  let ok = true;
  try {
    await Promise.race([fn(ac.signal, out, t + ms, partial), new Promise<never>((_, no) => ac.signal.addEventListener("abort", () => no(ac.signal.reason), { once: true }))]);
  } catch (e) {
    ok = false;
    out.failed = msg(e);
    R.failures.push({ step: name, error: out.failed });
    log(`${name}: FAILED: ${out.failed}`);
    runPartials(mine);
  } finally {
    clearTimeout(timer);
    partials = new Set();
    if (!ac.signal.aborted) ac.abort(new Error("step over"));
    out.stepMs = r0(now() - t);
    // this process's own scheduling delay: a busy laptop inflates every latency measured here
    out.loopLagMs = { p50: r1(lag.percentile(50) / 1e6), p99: r1(lag.percentile(99) / 1e6), max: r1(lag.max / 1e6) };
    save();
  }
  return ok;
}

/** Seeded incompressible bytes, readable at any offset: the same keystream as ../media-client.ts. */
function syntheticSource(seed: string, size: number): ByteSource {
  const key = createHash("sha256").update(`cf-lab:${seed}`).digest().subarray(0, 16);
  return {
    size,
    async read(offset, length) {
      const end = Math.min(size, offset + length);
      if (end <= offset) return new Uint8Array(0);
      const block = Math.floor(offset / 16), skipB = offset - block * 16;
      const iv = Buffer.alloc(16);
      iv.writeBigUInt64BE(BigInt(block), 8);
      const c = createCipheriv("aes-128-ctr", key, iv);
      const o = c.update(Buffer.alloc(end - offset + skipB));
      return new Uint8Array(o.buffer, o.byteOffset + skipB, end - offset);
    },
  };
}

// ---------------------------------------------------------------- a replica: the client the app runs
interface Ev { t: number; ev: string; detail?: string }
class Replica {
  readonly name: string;
  readonly who: string;
  readonly q = new sync.ReplicaQueue(schema);
  readonly client: sync.SyncClient;
  readonly commits = new Map<string, { t: number; online: boolean }>();
  readonly confirmed = new Map<string, { t: number; seq: number }>();
  /** Absorbed (its effect was already there) or rejected by the server's validation, and when. */
  readonly outcome = new Map<string, { what: string; t: number }>();
  /** Conflict cards each of this replica's changes raised (rebases up to its confirmed version, or its absorption). */
  readonly cards = new Map<string, number>();
  /** Other replicas' changes: when this one first held each confirmed (its remote row). */
  readonly held = new Map<string, number>();
  readonly keyframes: { t: number; seq: number }[] = [];
  readonly events: Ev[] = [];
  readonly startedAt = now();
  private readonly rid = randomBytes(4).toString("hex");
  private n = 0;
  constructor(name: string, url: string, token: string) {
    this.name = name;
    this.who = `laptop-${name.toLowerCase()}`;
    this.q.addBranch({ id: B, name: "main", kind: "main", sequencer: { kind: "server", since: 0 } }, DOC0);
    this.q.on((e) => {
      const t = now();
      if (e.type === "confirmed") {
        this.confirmed.set(e.row.id, { t, seq: e.row.seq });
        if (e.lateCards.length) this.cards.set(e.row.id, e.lateCards.length);
      } else if (e.type === "remote") {
        for (const r of e.rows) if (!this.held.has(r.id)) this.held.set(r.id, t);
      } else if (e.type === "absorbed") {
        this.outcome.set(e.change.id, { what: "absorbed", t });
        if (e.cards.length) this.cards.set(e.change.id, e.cards.length);
      } else if (e.type === "rejected") this.outcome.set(e.change.id, { what: `rejected: ${e.reason}`, t });
    });
    this.client = sync.createSyncClient(this.q, {
      transport: webSocketTransport(cfg.transport ?? {}),
      url,
      token,
      branchId: B,
      schemaVersion: SCHEMA_VERSION,
      blobs: hostMessageBlobs({ origin: HOST, projectId: cfg.projectId, token }),
      onEvent: (e) => {
        const t = now();
        if (e.type === "status") this.ev(t, "status", e.status);
        else if (e.type === "offline") this.ev(t, "offline", e.why);
        else if (e.type === "online") this.ev(t, "online");
        else if (e.type === "keyframe") this.keyframes.push({ t, seq: e.seq }), this.ev(t, "keyframe", String(e.seq));
        else if (e.type === "reject") this.ev(t, "reject", e.reason);
        else if (e.type === "rebase") this.ev(t, "rebase", String(e.n));
        else if (e.type === "overwritten") this.ev(t, "overwritten");
        else if (e.type === "error") this.ev(t, "error", `${e.code ? `${e.code}: ` : ""}${e.error}`);
      },
    });
  }
  private ev(t: number, ev: string, detail?: string): void {
    if (this.events.length < 600) this.events.push({ t, ev, ...(detail !== undefined ? { detail: clean(detail).slice(0, 200) } : {}) });
  }
  start(): this {
    this.client.start();
    return this;
  }
  stop(): void {
    this.client.stop();
  }
  get upToDate(): boolean {
    return this.client.status === "up-to-date";
  }
  get pending(): number {
    return this.q.pending(B).length;
  }
  get head(): number {
    return this.q.headSeq(B);
  }
  /** When this replica first showed "up to date" since `from`. */
  upToDateAt(from: number): number | undefined {
    return this.events.find((e) => e.t >= from && e.ev === "status" && e.detail === "up-to-date")?.t;
  }
  commit(rand: () => number): string | null {
    for (let tries = 0; tries < 10; tries++) {
      const e = genEdit(rand, this.q.optimistic(B).doc);
      if (!e) continue;
      const id = `${this.who}.${this.rid}.${++this.n}`;
      const t = now();
      this.q.commit(B, { id, author: { kind: "human", id: this.who }, ops: e.ops, policy: e.policy, at: Date.now() });
      this.client.pump();
      this.commits.set(id, { t, online: this.client.online });
      return id;
    }
    return null;
  }
  /** Committed here and still in the queue (not yet confirmed, absorbed or rejected). */
  isPending(id: string): boolean {
    return this.q.pending(B).some((c) => c.id === id);
  }
  /** When a change committed here settled: confirmed, absorbed or rejected. */
  settledAt(id: string): number | undefined {
    return this.confirmed.get(id)?.t ?? this.outcome.get(id)?.t;
  }
  /** When this replica first held `id` confirmed: its remote row, or a keyframe at or past its seq after the commit. */
  heldAt(id: string, seq: number | undefined, after: number): number | undefined {
    const t = this.held.get(id);
    if (t !== undefined) return t;
    if (seq === undefined) return undefined;
    return this.keyframes.find((k) => k.seq >= seq && k.t >= after)?.t;
  }
  final() {
    const head = this.head;
    return {
      head,
      pending: this.pending,
      ids: this.q.rows(B).map((r) => (r.placeholder ? null : r.id)),
      stateHash: hashDoc(this.q.confirmedState(B, head), schema),
      stats: { ...this.client.stats },
    };
  }
  timeline(from: number): { atMs: number; ev: string; detail?: string }[] {
    return this.events.filter((e) => e.t >= from).map((e) => ({ atMs: r0(e.t - from)!, ev: e.ev, ...(e.detail ? { detail: e.detail } : {}) }));
  }
}

/** Who committed `id` among `reps`. */
const committer = (reps: Replica[], id: string) => reps.find((r) => r.commits.has(id));

/**
 * For the edits in `ids`, in commit order: commit to own confirm, commit to every other replica in `observers` holding
 * it, and convergence (commit to confirmed and held everywhere: the later of those).
 */
function latencies(committers: Replica[], observers: Replica[], ids: Set<string>) {
  const rows: { t: number; confirm?: number; peers: number[]; conv?: number }[] = [];
  let unseen = 0;
  for (const c of committers)
    for (const [id, cm] of c.commits) {
      if (!ids.has(id)) continue;
      const cf = c.confirmed.get(id);
      const row: (typeof rows)[number] = { t: cm.t, peers: [] };
      if (cf) row.confirm = cf.t - cm.t;
      let all = !!cf;
      for (const o of observers) {
        if (o === c) continue;
        const t = o.heldAt(id, cf?.seq, cm.t);
        if (t === undefined) (unseen++, (all = false));
        else row.peers.push(t - cm.t);
      }
      if (all) row.conv = Math.max(row.confirm!, ...row.peers);
      rows.push(row);
    }
  rows.sort((x, y) => x.t - y.t);
  return {
    convergenceMs: st(rows.flatMap((r) => (r.conv === undefined ? [] : [r.conv]))),
    otherHoldsItMs: st(rows.flatMap((r) => r.peers)),
    ownConfirmMs: st(rows.flatMap((r) => (r.confirm === undefined ? [] : [r.confirm]))),
    unseenPairs: unseen,
  };
}

/** Lost edits, duplicate rows, order, conflict cards, and whether every replica ends on the same state. */
function integrity(reps: Replica[], ids: string[]) {
  const finals = reps.map((r) => r.final());
  let duplicateRows = 0;
  for (const f of finals) {
    const seen = new Set<string>();
    for (const id of f.ids) if (id) seen.has(id) ? duplicateRows++ : seen.add(id);
  }
  const inLog = new Set(finals.flatMap((f) => f.ids.filter((x): x is string => !!x)));
  const outcome = new Map<string, string>();
  for (const r of reps) for (const [id, o] of r.outcome) outcome.set(id, o.what);
  // still in its replica's queue, waiting to be sent or confirmed (a run stopped part-way, or a step that didn't
  // settle in time): not lost, and not counted as such
  const unsettled = new Set(ids.filter((id) => committer(reps, id)?.isPending(id)));
  const lost = ids.filter((id) => !inLog.has(id) && !outcome.has(id) && !unsettled.has(id));
  // each replica holds every kept edit: as its row, or inside a stretch it caught up on by keyframe (rows[seq - 1] is a
  // placeholder there)
  const seqOf = new Map<string, number>();
  for (const r of reps) for (const [id, c] of r.confirmed) seqOf.set(id, c.seq);
  const holds = (ids0: (string | null)[], id: string) => ids0.includes(id) || (seqOf.has(id) && ids0[seqOf.get(id)! - 1] === null);
  const missing = finals.map((f) => ids.filter((id) => !outcome.has(id) && !unsettled.has(id) && !holds(f.ids, id)).length);
  const ref = finals.reduce((x, y) => (y.ids.length > x.ids.length ? y : x)).ids;
  const orderMismatches = finals.reduce((s, f) => s + f.ids.reduce((k, id, j) => k + (id && ref[j] && id !== ref[j] ? 1 : 0), 0), 0);
  const cards = ids.map((id) => committer(reps, id)?.cards.get(id) ?? 0);
  const mine = ids.map((id) => outcome.get(id)).filter((o): o is string => !!o);
  return {
    edits: ids.length,
    lost: lost.length,
    lostIds: lost.slice(0, 5),
    unsettled: unsettled.size,
    absorbed: mine.filter((o) => o === "absorbed").length,
    rejected: mine.filter((o) => o.startsWith("rejected")).length,
    conflictCards: cards.reduce((s, n) => s + n, 0),
    editsWithConflictCards: cards.filter((n) => n > 0).length,
    duplicateRows,
    orderMismatches,
    missingPerReplica: Object.fromEntries(reps.map((r, i) => [r.name, missing[i]])),
    sameState: new Set(finals.map((f) => f.stateHash)).size === 1 && new Set(finals.map((f) => f.head)).size === 1,
    heads: Object.fromEntries(reps.map((r, i) => [r.name, finals[i]!.head])),
    clientStats: Object.fromEntries(reps.map((r, i) => [r.name, finals[i]!.stats])),
  };
}

/** Every edit settled where it was made and held by every other replica, nothing pending, one head. */
function settled(reps: Replica[], ids: string[]): boolean {
  for (const id of ids) {
    const by = committer(reps, id);
    if (!by || by.settledAt(id) === undefined) return false;
    if (by.outcome.has(id)) continue; // absorbed or rejected: nothing for the others to hold
    const seq = by.confirmed.get(id)!.seq, t = by.commits.get(id)!.t;
    if (reps.some((r) => r !== by && r.heldAt(id, seq, t) === undefined)) return false;
  }
  return reps.every((r) => r.pending === 0 && r.head === reps[0]!.head);
}

// A is the long-lived replica the other steps edit against (connected directly, not through the proxy)
let A: Replica | null = null;
async function replicaA(signal: AbortSignal): Promise<Replica> {
  if (A && !A.client.stopped) return A;
  A = new Replica("A", wsUrl(HOST), cfg.tokens.a).start();
  if (!(await until(() => A!.upToDate, 45_000, signal))) throw new Error(`replica A never got up to date (${A.client.status})`);
  return A;
}
async function joined(r: Replica, ms: number, signal: AbortSignal, how = ""): Promise<number | null> {
  if (!(await until(() => r.upToDate, ms, signal))) throw new Error(`replica ${r.name}${how} never got up to date (${r.client.status})`);
  return r0((r.upToDateAt(r.startedAt) ?? NaN) - r.startedAt);
}
const rand = rng(Number.parseInt(runRid, 16) || 1);

/**
 * Replica `r` (through `proxy`) loses its link for `cutMs`, a dead link that closes nothing; `r` and `peer` (connected
 * directly) each make `edits` edits meanwhile, interleaved. Then the link comes back and both settle. Fills `out`, and
 * pushes every edit's id into `ids` as it is made (for a partial summary).
 */
async function cutWindow(r: Replica, peer: Replica, proxy: LinkProxy, cutMs: number, edits: number, ids: string[], out: Record<string, any>, signal: AbortSignal): Promise<void> {
  const reconnects0 = r.client.stats.reconnects;
  const mine: string[] = [], theirs: string[] = [];
  const tCut = now();
  proxy.blackhole(true);
  log(`  link dead for ${cutMs / 1000} s; ${r.name} and ${peer.name} make ${edits} edits each meanwhile`);
  const gap = cutMs / (edits + 1);
  const plan = [...Array.from({ length: edits }, (_, k) => ({ at: (k + 1) * gap, who: r })), ...Array.from({ length: edits }, (_, k) => ({ at: (k + 1.5) * gap, who: peer }))]
    .filter((p) => p.at < cutMs)
    .sort((x, y) => x.at - y.at);
  for (const p of plan) {
    await sleep(tCut + p.at - now(), signal);
    const id = p.who.commit(rand);
    if (id) (p.who === r ? mine : theirs).push(id), ids.push(id);
  }
  await sleep(tCut + cutMs - now(), signal);
  out.statusWhenLinkCameBack = r.client.status;
  const tBack = now();
  proxy.blackhole(false);
  log(`  link back; waiting for everything to be caught up both ways`);
  out.cutMs = cutMs;
  out.editsDuringCut = { [r.name]: mine.length, [peer.name]: theirs.length };
  out.believedOnlineAtCommit = mine.filter((id) => r.commits.get(id)?.online).length;
  out.heldBytesMax = proxy.stats.heldMaxBytes;
  const all = [...mine, ...theirs];
  out.settled = await until(() => settled([r, peer], all), 120_000, signal);
  const tSettled = now();
  const off = r.events.find((e) => e.t >= tCut && e.ev === "offline");
  const on = r.events.find((e) => e.t >= tBack && e.ev === "online");
  const latest = (ts: (number | undefined)[]) => (ts.length && ts.every((t) => t !== undefined) ? r0(Math.max(...(ts as number[])) - tBack) : null);
  Object.assign(out, {
    wentOffline: !!off,
    // when the app would show "offline": the transport's dead-link check closing the silent connection
    offlineAfterCutMs: off ? r0(off.t - tCut) : null,
    offlineWhy: off?.detail ?? null,
    connectAttemptsDuringCut: r.events.filter((e) => e.t >= tCut && e.t < tBack && e.ev === "status" && e.detail === "connecting").length,
    onlineAfterLinkBackMs: on ? r0(on.t - tBack) : null,
    upToDateAfterLinkBackMs: r0((r.upToDateAt(tBack) ?? NaN) - tBack),
    // from the link coming back: the edits made offline confirmed, the peer holding them, and this replica holding
    // what the peer made meanwhile
    catchUp: {
      ownEditsConfirmedMs: latest(mine.map((id) => r.settledAt(id))),
      peerHoldsThemMs: latest(mine.filter((id) => r.confirmed.has(id)).map((id) => peer.heldAt(id, r.confirmed.get(id)!.seq, r.commits.get(id)!.t))),
      holdsPeersEditsMs: latest(theirs.filter((id) => peer.confirmed.has(id)).map((id) => r.heldAt(id, peer.confirmed.get(id)!.seq, peer.commits.get(id)!.t))),
      allSettledMs: out.settled ? r0(tSettled - tBack) : null,
    },
    ownEditsConfirmedAfterLinkBackMs: mine.map((id) => r0((r.settledAt(id) ?? NaN) - tBack)),
    // the peer, online all along, edited normally meanwhile
    peerConfirmDuringCutMs: st(theirs.map((id) => (peer.confirmed.get(id)?.t ?? NaN) - peer.commits.get(id)!.t).filter(Number.isFinite)),
    reconnects: r.client.stats.reconnects - reconnects0,
    timeline: r.timeline(tCut - 1000),
  });
}

// ---------------------------------------------------------------- the steps
const MB = 1_000_000, MiB = 1 << 20;
log(`Carton lab, laptop client. Host ${HOST}, project ${cfg.projectId}. Results: ${outPath}`);
log(`This takes ${MAX_MS > 10 * 60_000 ? "about 5-10 minutes on a typical home connection, never more than" : "at most"} ${MAX_MS / 60_000} minutes, and sends about ${UPLOAD_MB + 5} MB. Ctrl+C stops it and keeps what was measured.`);
save();

await step("probe", 90_000, async (signal, out) => {
  const name = new URL(HOST).hostname;
  // each part on its own: one that fails leaves the others' numbers
  const part = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      if (signal.aborted) throw e;
      out[`${what}Error`] = msg(e);
    }
  };
  // DNS (the address itself is not kept)
  await part("dns", async () => {
    const dns: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = now();
      await lookup(name);
      dns.push(now() - t);
    }
    out.dnsMs = dns.map(r0);
  });
  // TCP connect (about one round trip to Cloudflare's edge) and the TLS handshake on top
  const tcp: number[] = [], tlsMs: number[] = [];
  await part("tls", async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>((ok, no) => {
        const t = now();
        let tc = 0;
        const s = tls.connect({ host: name, port: 443, servername: name, ALPNProtocols: ["http/1.1"] });
        const timer = setTimeout(() => (s.destroy(), no(new Error("TLS connect timed out"))), 15_000);
        s.once("connect", () => (tc = now()));
        s.once("secureConnect", () => {
          tcp.push(tc - t);
          tlsMs.push(now() - tc);
          clearTimeout(timer);
          s.end();
          s.destroy();
          ok();
        });
        s.once("error", (e) => (clearTimeout(timer), no(e)));
      });
      await sleep(200, signal);
    }
  });
  out.tcpConnectMs = st(tcp);
  out.tlsHandshakeMs = st(tlsMs);
  // 10 health checks over one kept-alive connection (the first one also pays for connecting)
  const health: (number | null)[] = [];
  for (let i = 0; i < 10; i++) {
    const t = now();
    try {
      const r = await fetch(`${HOST}/api/health`, { signal });
      await r.text();
      health.push(r.ok ? now() - t : null);
    } catch (e) {
      if (signal.aborted) throw e;
      health.push(null);
      out.healthError = msg(e);
    }
    await sleep(150, signal);
  }
  out.healthMs = health.map((x) => (x === null ? null : r0(x)));
  out.healthWarmMs = st(health.slice(1).filter((x): x is number => x !== null));
  out.healthFailed = health.filter((x) => x === null).length;
  // which Cloudflare location answers this network, and over what (never the `ip` line)
  try {
    const r = await fetch(`${HOST}/cdn-cgi/trace`, { signal });
    const kv = Object.fromEntries((await r.text()).split("\n").map((l) => l.split("=")).filter((p) => p.length === 2));
    out.cloudflare = { colo: kv.colo ?? null, loc: kv.loc ?? null, http: kv.http ?? null, tls: kv.tls ?? null };
  } catch (e) {
    out.cloudflare = { error: msg(e) };
  }
  // WebSocket connect: from new WebSocket to the host's accepted subprotocol (the room's own handshake); the first
  // may wake the project's room
  const ws: number[] = [];
  await part("ws", async () => {
    for (let i = 0; i < 5; i++) {
      const t = now();
      const c = await webSocketTransport({ keepaliveMs: 0 }).connect(wsUrl(HOST), { token: cfg.tokens.a, signal });
      ws.push(now() - t);
      c.close();
      await sleep(300, signal);
    }
  });
  out.wsConnectMs = ws.map(r0);
  log(`probe: Cloudflare ${out.cloudflare?.colo ?? "?"} (${out.cloudflare?.loc ?? "?"}); TCP connect p50 ${out.tcpConnectMs.p50} ms; health p50 ${out.healthWarmMs.p50} ms; WebSocket connect ${out.wsConnectMs.join(", ")} ms`);
});

await step("sync", 3 * 60_000 + EDITS * INTERVAL, async (signal, out, _end, partial) => {
  const tA = now();
  const a = await replicaA(signal);
  const b = new Replica("B", wsUrl(HOST), cfg.tokens.b).start();
  const ids: string[] = [];
  const both = [a, b];
  const summary = () => Object.assign(out, latencies(both, both, new Set(ids)), integrity(both, ids));
  partial(summary);
  try {
    await joined(b, 45_000, signal);
    out.upToDateMs = { A: r0((a.upToDateAt(a.startedAt) ?? NaN) - a.startedAt), B: r0((b.upToDateAt(b.startedAt) ?? NaN) - b.startedAt) };
    log(`sync: A and B up to date; ${EDITS} edits alternating, one every ${INTERVAL} ms`);
    const t0 = now();
    for (let i = 0; i < EDITS; i++) {
      await sleep(t0 + i * INTERVAL - now(), signal);
      const id = (i % 2 === 0 ? a : b).commit(rand);
      if (id) ids.push(id);
      if ((i + 1) % 10 === 0) log(`sync: ${i + 1}/${EDITS} edits`);
    }
    out.editingMs = r0(now() - t0);
    out.settled = await until(() => settled(both, ids), 60_000, signal);
    out.settleMs = r0(now() - t0 - out.editingMs);
    summary();
    out.timelines = { A: a.timeline(tA), B: b.timeline(tA) };
    const v = out.convergenceMs, c = out.ownConfirmMs;
    log(`sync: convergence p50 ${v.p50} / p90 ${v.p90} / p99 ${v.p99} / max ${v.max} ms; own confirm p50 ${c.p50} / p99 ${c.p99} ms; lost ${out.lost}, duplicate rows ${out.duplicateRows}, conflict cards ${out.conflictCards}, same state ${out.sameState}`);
  } finally {
    b.stop();
  }
});

await step("offline", 2.5 * 60_000 + HOLE_MS, async (signal, out, _end, partial) => {
  const a = await replicaA(signal);
  const proxy = new LinkProxy(HOST);
  const port = await proxy.start();
  const c = new Replica("C", wsUrl(`http://127.0.0.1:${port}`), cfg.tokens.c).start();
  const ids: string[] = [];
  const summary = () => Object.assign(out, integrity([a, c], ids), { proxy: { ...proxy.stats } });
  partial(summary);
  try {
    out.upToDateMs = await joined(c, 45_000, signal, " (through the local proxy)");
    await sleep(2000, signal);
    await cutWindow(c, a, proxy, HOLE_MS, HOLE_EDITS, ids, out, signal);
    summary();
    const u = out.catchUp;
    log(`offline: C showed offline ${out.wentOffline ? `after ${r1(out.offlineAfterCutMs / 1000)} s` : "NEVER"}; after the link came back: online in ${out.onlineAfterLinkBackMs} ms, its edits confirmed in ${u.ownEditsConfirmedMs} ms, A's edits held in ${u.holdsPeersEditsMs} ms; lost ${out.lost}, conflict cards ${out.conflictCards}, same state ${out.sameState}`);
  } finally {
    c.stop();
    proxy.close();
  }
});

// ---------------------------------------------------------------- media
const store = hostMediaBlobs({ origin: HOST, projectId: cfg.projectId, token: cfg.tokens.a });
const seed = `laptop:${cfg.projectId}:${runRid}`;
/** What the upload step stored: the dedup and download steps use it. */
let uploaded: { size: number; manifest: Manifest } | null = null;

/**
 * One uploadMedia of `size` synthetic bytes from a fresh upload state. With `giveUpAt`: once two parts are done (the
 * first rate that means something), if the rest wouldn't be done by then, it stops and reports the rate instead.
 */
async function uploadOnce(size: number, out: Record<string, any>, signal: AbortSignal, partial: OnPartial, label: string, giveUpAt?: number): Promise<{ manifest: Manifest } | { tooSlow: { bytesPerMs: number; doneBytes: number; sentBytes: number; ms: number } }> {
  const source = syntheticSource(seed, size);
  let t = now();
  const m = await mediaHash(source, nodeHasher);
  out.hashMs = r0(now() - t);
  const dir = mkdtempSync(join(tmpdir(), "cf-lab-upload-"));
  const ac = new AbortController();
  const stop = () => ac.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  let last = { done: 0, sent: 0 }, shown = -1, counted = false;
  let tooSlow = null as { bytesPerMs: number; doneBytes: number; sentBytes: number; ms: number } | null;
  t = now();
  // stopped part-way: how far it got, and the bytes it sent (counted once)
  const summary = () => {
    out.partial = { ms: r0(now() - t), doneBytes: last.done, sentBytes: last.sent, mbps: mbit(last.done, now() - t) };
    if (!counted) (counted = true), (R.bytes.up += last.sent);
  };
  const forget = partial(summary);
  try {
    const r = await uploadMedia({
      store, hasher: nodeHasher, source, manifest: m, state: new FsUploadStateStore(dir), signal: ac.signal,
      ...(PART_MIB ? { partSize: PART_MIB * MiB } : {}), ...(CONCURRENCY ? { concurrency: CONCURRENCY } : {}),
      onProgress: (p) => {
        last = { done: p.done, sent: p.sent };
        const ms = now() - t;
        const pct = Math.floor((10 * p.done) / p.total) * 10;
        // (nothing sent yet, or nothing to send: deduped)
        if (pct > shown && p.done > 0 && p.sent > 0) (shown = pct), log(`${label}: ${Math.floor((100 * p.done) / p.total)}% (${Math.round(p.done / MB)} of ${Math.round(p.total / MB)} MB, ${mbit(p.done, ms)} Mbit/s)`);
        const partSize = PART_MIB * MiB || 8 * MiB;
        if (giveUpAt && !tooSlow && p.done >= 2 * partSize && p.done < p.total && now() + (p.total - p.done) / (p.done / ms) > giveUpAt) {
          tooSlow = { bytesPerMs: p.done / ms, doneBytes: p.done, sentBytes: p.sent, ms };
          ac.abort(new Error("too slow for the time left"));
        }
      },
    });
    const ms = now() - t;
    Object.assign(out, { ms: r0(ms), mbps: mbit(r.bytesSent, ms), partSize: r.partSize, parts: Math.ceil(size / r.partSize), partsSent: r.partsSent, bytesSent: r.bytesSent, deduped: r.deduped, resumedParts: r.resumedParts });
    R.bytes.up += r.bytesSent;
    counted = true;
    return { manifest: m };
  } catch (e) {
    if (tooSlow && !signal.aborted) {
      // the store's part uploads take no signal, so the parts in flight when it stopped still went out (uploadMedia
      // waits for them): counted as sent in full, an upper bound
      tooSlow.sentBytes = last.sent + (CONCURRENCY || 2) * (PART_MIB * MiB || 8 * MiB);
      R.bytes.up += tooSlow.sentBytes;
      counted = true;
      return { tooSlow };
    }
    summary();
    throw e;
  } finally {
    forget();
    signal.removeEventListener("abort", stop);
    rmSync(dir, { recursive: true, force: true });
  }
}

await step("upload", Math.min(15 * 60_000, deadline - now() - 3 * 60_000), async (signal, out, endsAt, partial) => {
  let size = Math.round(UPLOAD_MB * MB);
  out.sizeBytes = size;
  // live edits between A and B (both direct) for as long as the upload runs: what a saturated uplink does to sync
  const a = await replicaA(signal);
  const b = UPLOAD_EDIT_MS > 0 ? new Replica("B", wsUrl(HOST), cfg.tokens.b).start() : null;
  const ids: string[] = [];
  let editing = !!b;
  const both = b ? [a, b] : [];
  const editLoop = (async () => {
    if (!b) return;
    // (a fast upload may be over before B is up to date)
    await until(() => b.upToDate || !editing, 30_000, signal).catch(() => false);
    if (!b.upToDate) return void (out.liveSyncError = `replica B wasn't up to date in time (${b.client.status})`);
    const t0 = now();
    // at most 150 edits (7.5 minutes at the default 3 s): the guard's worst case counts them
    for (let i = 0; editing && ids.length < 150; i++) {
      await sleep(t0 + i * UPLOAD_EDIT_MS - now(), signal).catch(() => (editing = false));
      if (!editing) break;
      const id = (i % 2 === 0 ? a : b).commit(rand);
      if (id) ids.push(id);
    }
  })();
  const liveSync = () => {
    if (b) out.liveSync = { everyMs: UPLOAD_EDIT_MS, ...latencies(both, both, new Set(ids)), ...integrity(both, ids) };
  };
  partial(liveSync);
  try {
    let r = await uploadOnce(size, out, signal, partial, "upload", endsAt - 15_000);
    if ("tooSlow" in r) {
      // start again, smaller: what this link moves in 80% of the time left, less 20 s for hashing it and letting the
      // edits made meanwhile settle (the first try's parts are thrown away)
      const ts = r.tooSlow;
      const fit = Math.floor((ts.bytesPerMs * (endsAt - now() - 20_000) * 0.8) / MB) * MB;
      out.firstTry = { sizeBytes: size, ms: r0(ts.ms), doneBytes: ts.doneBytes, sentBytesAtMost: ts.sentBytes, mbps: mbit(ts.doneBytes, ts.ms) };
      if (fit < 8 * MB) throw new Error(`this link (${out.firstTry.mbps} Mbit/s up) is too slow for even a small upload in the time left`);
      log(`upload: at ${out.firstTry.mbps} Mbit/s, ${UPLOAD_MB} MB wouldn't finish in time; starting again with ${fit / MB} MB`);
      size = fit;
      out.sizeBytes = size;
      r = await uploadOnce(size, out, signal, partial, "upload");
      if ("tooSlow" in r) throw new Error("unreachable");
    }
    uploaded = { size, manifest: r.manifest };
    log(`upload: ${Math.round(size / MB)} MB in ${r1(out.ms / 1000)} s, ${out.mbps} Mbit/s (${out.parts} parts of ${out.partSize / MiB} MiB)`);
  } finally {
    editing = false;
    await editLoop;
    if (b) {
      await until(() => settled(both, ids), 30_000, signal).catch(() => false);
      liveSync();
      b.stop();
      const l = out.liveSync;
      if (l.edits) log(`upload: ${l.edits} edits meanwhile: convergence p50 ${l.convergenceMs.p50} / p90 ${l.convergenceMs.p90} / max ${l.convergenceMs.max} ms; lost ${l.lost}`);
    }
  }
});

if (uploaded as typeof uploaded | null) {
  await step("dedup", 90_000, async (signal, out, _end, partial) => {
    // the same content again from a fresh upload state: another machine sharing the same file
    const r = await uploadOnce(uploaded!.size, out, signal, partial, "dedup");
    if ("tooSlow" in r) throw new Error("unreachable");
    log(`dedup: the same ${Math.round(uploaded!.size / MB)} MB again: ${out.deduped ? "already there" : "NOT deduped"}, ${out.bytesSent} bytes sent, ${r1(out.ms / 1000)} s (+ ${r1(out.hashMs / 1000)} s hashing)`);
  });
  await step("download", 90_000, async (signal, out, _end, partial) => {
    const { size, manifest } = uploaded!;
    const want = Math.min(size, DOWNLOAD_MIB * MiB);
    const events: ReaderEvent[] = [];
    // the app's read path: the manifest fetched and checked, then growing range requests (1, 2, 4, 8 leaves), each
    // 1 MiB leaf checked against the manifest as it lands, a request that fails on the network retried
    const reader = new MediaReader({ store, hasher: nodeHasher, onEvent: (e) => void (events.length < 50 && events.push(e)) });
    let t = now();
    const info = await reader.stat(manifest.hash, signal);
    out.statMs = r0(now() - t); // what a player waits for before its first read: the manifest and the object's size
    if (!info) throw new Error("the uploaded file isn't there");
    if (info.size !== size) throw new Error(`the stored file is ${info.size} bytes, not ${size}`);
    const h = createHash("sha256");
    let got = 0, first = 0;
    t = now();
    partial(() => (out.partial = { bytes: got, ms: r0(now() - t) }));
    for await (const piece of reader.read(manifest.hash, 0, want, signal)) {
      if (!first) first = now() - t;
      got += piece.byteLength;
      h.update(piece);
    }
    const ms = now() - t;
    R.bytes.down += got;
    // the bytes that came back are the bytes that went up
    const sent = createHash("sha256").update(await syntheticSource(seed, size).read(0, want)).digest("hex");
    Object.assign(out, { bytes: got, ms: r0(ms), firstByteMs: r0(first), mbps: mbit(got, ms), mbpsAfterFirstByte: mbit(got, ms - first), matchesWhatWasSent: got === want && h.digest("hex") === sent, readerEvents: events });
    log(`download: ${r1(got / MiB)} MiB in ${r1(ms / 1000)} s, ${out.mbps} Mbit/s (first byte ${out.firstByteMs} ms after ${out.statMs} ms for the manifest); same bytes as sent: ${out.matchesWhatWasSent ? "yes" : "NO"}`);
  });
}

// optional, last: a slowed-down link through the local proxy, only if the run has time left
await step(
  "shaped",
  3 * 60_000 + SHAPED.edits * INTERVAL + SHAPED.holeMs,
  async (signal, out, _end, partial) => {
    const a = await replicaA(signal);
    const proxy = new LinkProxy(HOST);
    const port = await proxy.start();
    proxy.shape({ kbps: SHAPED.kbps, delayMs: SHAPED.delayMs });
    out.link = { kbps: SHAPED.kbps, delayMsEachWay: SHAPED.delayMs };
    const d = new Replica("D", wsUrl(`http://127.0.0.1:${port}`), cfg.tokens.c).start();
    const ids: string[] = [];
    const summary = () => Object.assign(out, integrity([a, d], ids), { proxy: { ...proxy.stats } });
    partial(summary);
    try {
      // joining on the slow link: connect and catch up on everything so far
      out.joinMs = await joined(d, 90_000, signal, " (shaped link)");
      log(`shaped: D joined over ${SHAPED.kbps} kbit/s, ${SHAPED.delayMs} ms each way in ${out.joinMs} ms; ${SHAPED.edits} edits alternating with A`);
      const t0 = now();
      for (let i = 0; i < SHAPED.edits; i++) {
        await sleep(t0 + i * INTERVAL - now(), signal);
        const id = (i % 2 === 0 ? d : a).commit(rand);
        if (id) ids.push(id);
      }
      out.settled = await until(() => settled([a, d], ids), 60_000, signal);
      const edited = new Set(ids);
      out.fromShaped = latencies([d], [a, d], edited); // D's edits: D's confirm, A holding them
      out.toShaped = latencies([a], [a, d], edited); // A's edits: D holding them
      if (SHAPED.holeMs > 0) await cutWindow(d, a, proxy, SHAPED.holeMs, HOLE_EDITS, ids, (out.deadLink = {}), signal);
      summary();
      const cut = out.deadLink ? `; a ${SHAPED.holeMs / 1000} s cut: offline ${out.deadLink.wentOffline ? `after ${r1(out.deadLink.offlineAfterCutMs / 1000)} s` : "NEVER"}, caught up ${out.deadLink.catchUp.allSettledMs} ms after` : "";
      log(`shaped: D's edits confirmed p50 ${out.fromShaped.ownConfirmMs.p50} ms, A holds them p50 ${out.fromShaped.otherHoldsItMs.p50} ms; A's edits reach D p50 ${out.toShaped.otherHoldsItMs.p50} ms${cut}; lost ${out.lost}, same state ${out.sameState}`);
    } finally {
      d.stop();
      proxy.close();
    }
  },
  { optional: true, minMs: 100_000 },
);

const lastA = A as Replica | null; // assigned inside the steps
if (lastA) {
  R.replicaA = { timeline: lastA.timeline(lastA.startedAt).slice(0, 200), stats: { ...lastA.client.stats } };
  lastA.stop();
}

// ---------------------------------------------------------------- the end
R.finishedAt = new Date().toISOString();
R.totalMs = r0(now() - T0);
save();
const S = R.steps;
const why = (s: Record<string, any> | undefined) => s?.failed ?? (s?.skipped ? (s.skipped === true ? "skipped" : s.skipped) : "no result");
const lines = [
  "",
  "Summary",
  `  network     Cloudflare ${S.probe?.cloudflare?.colo ?? "?"} (${S.probe?.cloudflare?.loc ?? "?"}), round trip ~${S.probe?.tcpConnectMs?.p50 ?? "?"} ms, health p50 ${S.probe?.healthWarmMs?.p50 ?? "?"} ms`,
  S.sync?.convergenceMs
    ? `  live sync   ${S.sync.edits} edits: both devices have each in p50 ${S.sync.convergenceMs.p50} / p90 ${S.sync.convergenceMs.p90} / p99 ${S.sync.convergenceMs.p99} ms; lost ${S.sync.lost}, same state ${S.sync.sameState ? "yes" : "NO"}`
    : `  live sync   ${why(S.sync)}`,
  S.offline?.cutMs
    ? `  offline     ${S.offline.cutMs / 1000} s with no connection: showed offline ${S.offline.wentOffline ? `after ${r1(S.offline.offlineAfterCutMs / 1000)} s` : "never"}; caught up ${S.offline.catchUp?.allSettledMs ?? "?"} ms after it came back; lost ${S.offline.lost ?? "?"}, conflict cards ${S.offline.conflictCards ?? "?"}`
    : `  offline     ${why(S.offline)}`,
  S.upload?.ms
    ? `  upload      ${Math.round(S.upload.sizeBytes / MB)} MB in ${r1(S.upload.ms / 1000)} s (${S.upload.mbps} Mbit/s)${S.upload.liveSync?.edits ? `; edits meanwhile p50 ${S.upload.liveSync.convergenceMs.p50} / max ${S.upload.liveSync.convergenceMs.max} ms` : ""}; again: ${S.dedup?.bytesSent ?? "?"} bytes sent`
    : `  upload      ${why(S.upload)}${S.upload?.partial ? ` (${Math.round(S.upload.partial.doneBytes / MB)} MB done, ${S.upload.partial.mbps} Mbit/s)` : ""}`,
  S.download?.ms !== undefined ? `  download    ${r1(S.download.bytes / MiB)} MiB in ${r1(S.download.ms / 1000)} s (${S.download.mbps} Mbit/s), same bytes ${S.download.matchesWhatWasSent ? "yes" : "NO"}` : "",
  S.shaped?.joinMs !== undefined
    ? `  3G-like     joined in ${S.shaped.joinMs} ms; edits confirmed p50 ${S.shaped.fromShaped?.ownConfirmMs?.p50 ?? "?"} ms${S.shaped.deadLink?.cutMs ? `; after a ${S.shaped.deadLink.cutMs / 1000} s cut caught up in ${S.shaped.deadLink.catchUp?.allSettledMs ?? "?"} ms` : ""}; lost ${S.shaped.lost ?? "?"}`
    : "",
  `  problems    ${R.failures.length ? R.failures.map((f: { step: string; error: string }) => `${f.step}: ${f.error}`).join("; ") : "none"}`,
  `  data used   about ${Math.round((R.bytes.up + R.bytes.down) / MB)} MB`,
  "",
  `Done in ${Math.max(1, Math.round(R.totalMs / 60_000))} min. Please send back this file:`,
  `  ${outPath}`,
].filter((l) => l !== "");
console.log(lines.join("\n"));
process.exit(R.failures.length ? 1 : 0);
