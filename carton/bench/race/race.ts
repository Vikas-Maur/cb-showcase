#!/usr/bin/env node
// P10, ported from proofs/race/race.mjs: can an engine that re-materializes a view file (project.json, timeline.tsx)
// destroy a write that another process (a "foreign writer") made to it? Races three replacement protocols against
// foreign writers and accounts for every foreign write. No dependencies, Node 24+, Linux, macOS and Windows.
//
// The `displace` protocol is the shipped code: `displaceThenInstall` and, with --settle 2, `DisplacedFiles` from
// @carton/cardboard. `naive` and `hardlink` are the controls, and --settle 0|1 the ablations, as in the prototype.
//
//   node race.ts                        the portable matrix (run this on NTFS); prints a table
//   node race.ts --dir D:\carton-race   the same on another volume (default: <os tmpdir>/carton-race)
//   node race.ts trial --protocol displace --writers 4 --mode free --rounds 5000 [--widen 100] [--oracle ./inotify-log]
//   node race.ts table --in results.jsonl
//
// Engine protocols:
//   naive     stat the view; if its stamp (ino:size:mtimeNs) isn't ours, import it; rename our temp over it
//   hardlink  link the view to .carton/prev/<k>; rename our temp over it; if prev/<k> isn't ours, import it
//   displace  rename the view to .carton/displaced/<n>; link our temp to the view, which fails with EEXIST if a
//             foreign write landed in between (then displace again); unlink the temp; import every displaced
//             file whose content isn't our last view
// Writer modes:
//   free  each writer loops temp+rename as fast as it can. Later foreign writes replace earlier ones before the
//         engine can see them. That loss is the writers' own, and only the Linux oracle (inotify-log.c) can tell
//         it apart from a loss the engine caused.
//   turn  writers take turns (a mkdir lock) and each waits until its write has left the path before the next
//         one, so no foreign write replaces another, and every unaccounted foreign write is the engine's loss.
// --style inplace makes writers write the view in place (open, truncate, write) instead of temp+rename.
// --widen <µs> busy-waits inside each protocol's vulnerable step, to make rare interleavings common.
// --settle 1|2 (displace only) re-reads displaced files that in-place writers may still be writing; see settle().
// Windows: rename/link/unlink retry with backoff on EPERM/EBUSY/EACCES (another process has the file open).
// fs.link is CreateHardLinkW there; FAT/exFAT have no hard links, so only `naive` can run on them.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { displaceThenInstall, retryBusy, stampOf, hardLinksWork, type BusyCounter } from "../../packages/cardboard/src/node/displace.ts";
import { DisplacedFiles } from "../../packages/cardboard/src/node/displaced.ts";

const SELF = fileURLToPath(import.meta.url);
const VIEW = "view.json";
const sab = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number): void => {
  Atomics.wait(sab, 0, 0, ms);
};
const now = (): bigint => process.hrtime.bigint();
const spin = (us: number): void => {
  const end = now() + BigInt(Math.round(us * 1000));
  while (now() < end);
};
// Windows rounds short sleeps up to its timer tick (1 to 15.6 ms), which would starve turn mode of foreign
// writes, so writers spin there instead.
const pause = process.platform === "win32" ? (ms: number) => spin(ms * 1000) : sleep;
const statStamp = (p: string): string => stampOf(fs.statSync(p, { bigint: true }));
const body = (tag: string, size: number): string => {
  const h = `{"tag":"${tag}","pad":"`;
  return h + "x".repeat(Math.max(0, size - h.length - 2)) + '"}';
};
const tagOf = (b: Buffer): string | null => /^\{"tag":"([^"]+)"/.exec(b.toString("latin1", 0, 64))?.[1] ?? null;
// A write is whole only with its tag, its full length, its closing brace and no zero bytes: a file system may
// show the final length before all the bytes are in.
const whole = (b: Buffer, size: number): boolean => b.length === size && b[size - 1] === 0x7d && b.indexOf(0) === -1 && tagOf(b) !== null;
const exists = (p: string): boolean => fs.existsSync(p);
const lvl = (v: unknown): number => (v === true ? 1 : Number(v) || 0);
const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException)?.code;
const noent = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch (e) {
    if (code(e) !== "ENOENT") throw e;
    return undefined;
  }
};

// 1 µs buckets up to 2 ms, then one overflow bucket; mergeable across trials.
const H = 2000;
type Hist = number[];
const hist = (): Hist => new Array(H + 1).fill(0);
const hadd = (h: Hist, ns: number): void => {
  h[Math.min(H, Math.floor(ns / 1000))]!++;
};
function hq(h: Hist, q: number): number | string | null {
  const n = h.reduce((a, b) => a + b, 0);
  if (!n) return null;
  const want = Math.ceil(q * n);
  let c = 0;
  for (let i = 0; i <= H; i++) {
    c += h[i]!;
    if (c >= want) return i === H ? `>${H}` : i;
  }
  return null;
}
const hmax = (h: Hist): number | string | null => {
  for (let i = H; i >= 0; i--) if (h[i]) return i === H ? `>${H}` : i;
  return null;
};

// ---------------------------------------------------------------- engine
interface Opts {
  base: string;
  fsLabel: string;
  fs?: string;
  size: number;
  mode: "turn" | "free";
  style: "rename" | "inplace";
  protocol: "naive" | "hardlink" | "displace";
  engine: "sync" | "async";
  writers: number;
  rounds: number;
  widen: number;
  jitter: number;
  pace: number;
  reader: "read" | "stat" | "both" | false | "";
  oracle: string | null;
  keep: boolean;
  settle?: number | boolean;
  trials?: number;
}
interface Trial {
  dir: string;
  view: string;
  size: number;
  widen: number;
  drop: boolean;
  settle: number;
  tmpDir: string;
  dispDir: string;
  prevDir: string;
}
interface Pending {
  d: string;
  k?: number;
  own?: { c: Buffer; stamp: string } | null;
}
interface Engine extends BusyCounter {
  k: number;
  n: number;
  size: number;
  recorded: Set<string>;
  pending: Pending[];
  lastInstall: { c: Buffer; stamp: string } | null;
  eexist: number;
  selfImports: number;
  tornImports: number;
  gap: Hist;
  gapTotal: Hist;
  lastStamp: string | null;
  lastContent: Buffer | null;
  held: DisplacedFiles | null;
}

function writeTmp(T: Trial, E: Engine): { p: string; c: Buffer; stamp: string } {
  const p = path.join(T.tmpDir, "e-" + E.k);
  const c = Buffer.from(body("E-" + E.k, T.size));
  fs.writeFileSync(p, c, { flag: "wx" });
  return { p, c, stamp: statStamp(p) };
}
function importFrom(E: Engine, buf: Buffer): void {
  const tag = tagOf(buf);
  if (tag?.[0] === "F" && whole(buf, E.size)) E.recorded.add(tag);
  else if (tag?.[0] === "E") E.selfImports++;
  else E.tornImports++;
}
// --settle 1 (ablation): a displaced file that is incomplete (here: not exactly the writers' size; in the app: JSON
// that doesn't parse) may still be written in place by a writer that opened it before it was displaced. Keep it and
// read it again on later rounds instead of importing the partial bytes.
// --settle 2 is the shipped rule, `DisplacedFiles`: also hold every displaced file for one round before calling it
// ours. writeFileSync truncates inside open(), after the path lookup, so a writer can resolve the view just before we
// displace it and truncate and write the inode just after we read our own old bytes from it. A file is ours only if,
// a round later, both its bytes and its install-time stamp are unchanged.
const complete = (E: Engine, b: Buffer): boolean => whole(b, E.size);
function settle(T: Trial, E: Engine, last = false): void {
  if (E.held) {
    const r = E.held.review((b) => complete(E, b), { final: last });
    for (const f of r.foreign) {
      importFrom(E, f.bytes);
      if (T.drop) E.held.release(f.path);
    }
    return;
  }
  E.pending = E.pending.filter((p) => {
    const b = fs.readFileSync(p.d);
    if (!complete(E, b) && !last) return true;
    importFrom(E, b);
    if (T.drop) fs.unlinkSync(p.d);
    return false;
  });
}
type Proto = (T: Trial, E: Engine) => void | Promise<void>;
const PROTO: Record<string, Proto> = {
  naive(T, E) {
    const t = writeTmp(T, E);
    const s = noent(() => fs.statSync(T.view, { bigint: true }));
    if (s && stampOf(s) !== E.lastStamp) {
      const b = noent(() => retryBusy(() => fs.readFileSync(T.view), E));
      if (b) importFrom(E, b);
    }
    if (T.widen) spin(T.widen);
    retryBusy(() => fs.renameSync(t.p, T.view), E);
    E.lastStamp = t.stamp;
  },
  hardlink(T, E) {
    const t = writeTmp(T, E);
    const prev = path.join(T.prevDir, String(E.k));
    let linked = true;
    try {
      retryBusy(() => fs.linkSync(T.view, prev), E);
    } catch (e) {
      if (code(e) !== "ENOENT") throw e;
      linked = false;
    }
    if (T.widen) spin(T.widen);
    retryBusy(() => fs.renameSync(t.p, T.view), E);
    if (linked) {
      if (statStamp(prev) === E.lastStamp) retryBusy(() => fs.unlinkSync(prev), E);
      else {
        importFrom(E, fs.readFileSync(prev));
        if (T.drop) fs.unlinkSync(prev);
      }
    }
    E.lastStamp = t.stamp;
  },
  // The shipped protocol.
  displace(T, E) {
    const t = writeTmp(T, E);
    const next = E.held ? E.held.next : () => path.join(T.dispDir, String(E.n++));
    const r = displaceThenInstall(T.view, t.p, next, { counter: E, between: T.widen ? () => spin(T.widen) : undefined });
    E.eexist += r.eexist;
    hadd(E.gap, r.gapNs);
    hadd(E.gapTotal, r.gapTotalNs);
    if (E.held) {
      E.held.hold(r.displaced, E.lastInstall ? { bytes: E.lastInstall.c, stamp: E.lastInstall.stamp } : null);
    } else {
      for (const d of r.displaced) {
        const b = fs.readFileSync(d);
        if (E.lastContent && b.equals(E.lastContent)) retryBusy(() => fs.unlinkSync(d), E);
        else if (T.settle && !complete(E, b)) E.pending.push({ d });
        else {
          importFrom(E, b);
          if (T.drop) fs.unlinkSync(d);
        }
      }
    }
    settle(T, E);
    E.held?.endRound();
    E.lastContent = t.c;
    E.lastInstall = { c: t.c, stamp: t.stamp };
  },
  // The same displace protocol through fs.promises, as an engine on the libuv thread pool would do it; used only to
  // measure the missing-path gap (why the shipped code is synchronous).
  async displaceAsync(T, E) {
    const p = path.join(T.tmpDir, "e-" + E.k);
    const c = Buffer.from(body("E-" + E.k, T.size));
    await fsp.writeFile(p, c, { flag: "wx" });
    const moved: string[] = [];
    for (let first: bigint | null = null; ; ) {
      const d = path.join(T.dispDir, String(E.n++));
      const t0 = now();
      first ??= t0;
      try {
        await fsp.rename(T.view, d);
        moved.push(d);
      } catch (e) {
        if (code(e) !== "ENOENT") throw e;
      }
      const t1 = now();
      try {
        await fsp.link(p, T.view);
      } catch (e) {
        if (code(e) !== "EEXIST") throw e;
        E.eexist++;
        continue;
      }
      const t2 = now();
      hadd(E.gap, Number(t2 - t1));
      hadd(E.gapTotal, Number(t2 - first));
      break;
    }
    await fsp.unlink(p);
    for (const d of moved) {
      const b = await fsp.readFile(d);
      if (E.lastContent && b.equals(E.lastContent)) await fsp.unlink(d);
      else importFrom(E, b);
    }
    E.lastContent = c;
  },
};

// ---------------------------------------------------------------- child processes
interface ChildCfg {
  dir: string;
  size: number;
  ctl: string;
  mode: string;
  style: string;
  jitter: number;
  w?: number;
  kind?: string;
}
function writer(cfg: ChildCfg): void {
  const { dir, mode, style, size, jitter, ctl } = cfg;
  const w = cfg.w!;
  const view = path.join(dir, VIEW);
  const stop = path.join(ctl, "stop");
  const go = path.join(ctl, "go");
  const lock = path.join(ctl, "lock");
  const out = { w, n: 0, abandoned: [] as string[], busy: 0 };
  process.stdout.write("ready\n");
  while (!exists(go)) sleep(1);
  const write = (tag: string): string | null => {
    if (style === "inplace") {
      retryBusy(() => fs.writeFileSync(view, body(tag, size)), out);
      return null;
    }
    const tmp = path.join(dir, `${VIEW}.${tag}.tmp`);
    fs.writeFileSync(tmp, body(tag, size));
    const st = mode === "turn" ? statStamp(tmp) : null;
    try {
      retryBusy(() => fs.renameSync(tmp, view), out);
    } catch (e) {
      out.abandoned.push(tag);
      noent(() => fs.unlinkSync(tmp));
      throw e;
    }
    return st;
  };
  if (mode === "free") {
    for (let seq = 0; ; seq++) {
      if ((seq & 15) === 0 && exists(stop)) break;
      write(`F${w}-${seq}`);
      out.n = seq + 1;
    }
  } else {
    outer: for (let seq = 0; ; seq++) {
      for (;;) {
        // take the turn
        if (exists(stop)) break outer;
        try {
          fs.mkdirSync(lock);
          break;
        } catch (e) {
          if (code(e) !== "EEXIST") throw e;
          pause(0.05);
        }
      }
      if (jitter) spin(Math.random() * jitter);
      const tag = `F${w}-${seq}`;
      const mine = write(tag);
      out.n = seq + 1;
      for (;;) {
        // wait until our write left the path
        if (exists(stop)) break outer; // keep the turn: our write may still be at the view
        if (style === "inplace") {
          const b = noent(() => fs.readFileSync(view));
          if (!b || tagOf(b) !== tag) break;
        } else {
          const s = noent(() => fs.statSync(view, { bigint: true }));
          if (!s || stampOf(s) !== mine) break;
        }
        pause(0.02);
      }
      fs.rmdirSync(lock);
    }
  }
  fs.writeFileSync(path.join(ctl, `w${w}.json`), JSON.stringify(out));
}

// kind "read": readFile in a loop, as the app's readers do; counts ENOENT and torn reads. A failed readFile
// spends tens of µs building its Error, so its ENOENT streaks overstate the gap. kind "stat": stat with
// throwIfNoEntry:false in a loop (no exception, a sample every few µs); its absent streaks time the gap.
function reader(cfg: ChildCfg): void {
  const { dir, size, ctl, kind } = cfg;
  const view = path.join(dir, VIEW);
  const stop = path.join(ctl, "stop");
  const go = path.join(ctl, "go");
  const out = { reads: 0, enoent: 0, torn: 0, other: {} as Record<string, number>, streaks: 0, streak: hist() };
  process.stdout.write("ready\n");
  while (!exists(go)) sleep(1);
  let since: bigint | null = null;
  for (;;) {
    if ((out.reads & 1023) === 0 && exists(stop)) break;
    const t = now();
    out.reads++;
    let ok: boolean;
    if (kind === "stat") ok = fs.statSync(view, { throwIfNoEntry: false }) !== undefined;
    else
      try {
        ok = true;
        if (!whole(fs.readFileSync(view), size)) out.torn++;
      } catch (e) {
        const c = code(e) ?? "?";
        if (c !== "ENOENT") {
          out.other[c] = (out.other[c] ?? 0) + 1;
          continue;
        }
        ok = false;
      }
    if (!ok) {
      out.enoent++;
      since ??= t;
    } else if (since !== null) {
      hadd(out.streak, Number(t - since));
      out.streaks++;
      since = null;
    }
  }
  fs.writeFileSync(path.join(ctl, `reader-${kind}.json`), JSON.stringify(out));
}

const live = new Set<ChildProcess>();
process.on("exit", () => {
  for (const p of live) p.kill();
});
function child(role: string, cfg: ChildCfg): { ready: Promise<unknown>; done: Promise<unknown> } {
  const p = spawn(process.execPath, [SELF, role, JSON.stringify(cfg)], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  live.add(p);
  p.once("exit", () => live.delete(p));
  const ready = new Promise((res, rej) => {
    p.stdout!.once("data", res);
    p.once("exit", (c) => rej(new Error(`${role} exited ${c}`)));
  });
  const done = new Promise((res) => p.once("exit", res));
  return { ready, done };
}

// ---------------------------------------------------------------- one trial
export async function trial(o: Opts): Promise<Record<string, any>> {
  const dir = fs.mkdtempSync(path.join(o.base, "t-"));
  // Free mode makes ~10^5 foreign files per trial, so it deletes each one once recorded, as the app does after
  // importing it; turn mode keeps them for the keptNotRecorded check.
  const T: Trial = {
    dir,
    view: path.join(dir, VIEW),
    size: o.size,
    widen: o.widen,
    drop: o.mode === "free",
    settle: lvl(o.settle),
    tmpDir: path.join(dir, ".carton", "tmp"),
    dispDir: path.join(dir, ".carton", "displaced"),
    prevDir: path.join(dir, ".carton", "prev"),
  };
  const ctl = path.join(dir, "ctl");
  for (const d of [T.tmpDir, T.dispDir, T.prevDir, ctl]) fs.mkdirSync(d, { recursive: true });
  const E: Engine = {
    k: 0,
    n: 0,
    size: o.size,
    recorded: new Set(),
    pending: [],
    lastInstall: null,
    eexist: 0,
    selfImports: 0,
    tornImports: 0,
    gap: hist(),
    gapTotal: hist(),
    lastStamp: null,
    lastContent: null,
    // The shipped hold is round-based here (the engine materializes every few µs), not 150 ms.
    held: o.protocol === "displace" && o.engine !== "async" && T.settle >= 2 ? new DisplacedFiles(T.dispDir, { holdMs: 0, quietMs: 0 }) : null,
  };
  const proto = o.engine === "async" ? PROTO.displaceAsync! : PROTO[o.protocol]!;

  let oracle: { log: string; done: Promise<unknown> } | null = null;
  if (o.oracle) {
    const log = path.join(o.base, path.basename(dir) + ".inotify");
    const p = spawn(o.oracle, [log, ".stop", dir, T.dispDir, T.prevDir, T.tmpDir], { stdio: ["ignore", "pipe", "inherit"] });
    live.add(p);
    p.once("exit", () => live.delete(p));
    await new Promise((res, rej) => {
      p.stdout!.once("data", res);
      p.once("exit", (c) => rej(new Error("oracle exited " + c)));
    });
    oracle = { log, done: new Promise((res) => p.once("exit", res)) };
  }
  await proto(T, E); // round 0: the first view
  const cfg: ChildCfg = { dir, size: o.size, ctl, mode: o.mode, style: o.style, jitter: o.jitter };
  const kids: { ready: Promise<unknown>; done: Promise<unknown> }[] = [];
  for (let w = 1; w <= o.writers; w++) kids.push(child("writer", { ...cfg, w }));
  const kinds = o.reader === "both" ? ["read", "stat"] : o.reader ? [o.reader === "stat" ? "stat" : "read"] : [];
  for (const kind of kinds) kids.push(child("reader", { ...cfg, kind }));
  await Promise.all(kids.map((k) => k.ready));
  fs.writeFileSync(path.join(ctl, "go"), "");
  const t0 = now();
  for (E.k = 1; E.k <= o.rounds; E.k++) {
    await proto(T, E);
    if (o.pace) sleep(o.pace);
  }
  const ms = Number(now() - t0) / 1e6;
  fs.writeFileSync(path.join(ctl, "stop"), "");
  await Promise.all(kids.map((k) => k.done));
  if (oracle) {
    fs.writeFileSync(path.join(dir, ".stop"), "");
    await oracle.done;
  }
  const pendingAtEnd = E.held ? E.held.size : E.pending.length;
  settle(T, E, true); // the engine's next round, after writers stopped

  // Accounting. A foreign write is safe if it is the final view or the engine imported it: every foreign
  // file the engine moved aside was read and recorded at that moment.
  const landed: string[] = [];
  const ws: { busy: number }[] = [];
  for (let w = 1; w <= o.writers; w++) {
    const r = JSON.parse(fs.readFileSync(path.join(ctl, `w${w}.json`), "utf8"));
    ws.push(r);
    const ab = new Set<string>(r.abandoned);
    for (let s = 0; s < r.n; s++) if (!ab.has(`F${w}-${s}`)) landed.push(`F${w}-${s}`);
  }
  const final = tagOf(fs.readFileSync(T.view));
  const kept = new Set<string>();
  for (const d of [T.dispDir, T.prevDir])
    for (const f of fs.readdirSync(d)) {
      const t = tagOf(fs.readFileSync(path.join(d, f)));
      if (t?.[0] === "F") kept.add(t);
    }
  const unaccounted = landed.filter((t) => t !== final && !E.recorded.has(t));
  const res: Record<string, any> = {
    ...o,
    base: undefined,
    fs: o.fsLabel,
    ms: Math.round(ms),
    rounds: o.rounds,
    landed: landed.length,
    unaccounted: unaccounted.length,
    keptNotRecorded: [...kept].filter((t) => !E.recorded.has(t)).length,
    eexist: E.eexist,
    pendingAtEnd,
    selfImports: E.selfImports,
    tornImports: E.tornImports,
    busy: (E.busy ?? 0) + ws.reduce((a, r) => a + r.busy, 0),
    gap: o.protocol === "displace" ? E.gap : null,
    gapTotal: o.protocol === "displace" ? E.gapTotal : null,
  };
  if (o.mode === "turn") {
    res.lostByEngine = unaccounted.length;
    res.superseded = 0;
  }
  for (const kind of kinds) {
    const r = JSON.parse(fs.readFileSync(path.join(ctl, `reader-${kind}.json`), "utf8"));
    if (kind === "read") Object.assign(res, { reads: r.reads, enoent: r.enoent, torn: r.torn, readErr: r.other, streaks: r.streaks, streak: r.streak });
    else Object.assign(res, { probes: r.reads, absent: r.enoent, pstreaks: r.streaks, pstreak: r.streak });
  }
  if (oracle) Object.assign(res, replay(fs.readFileSync(oracle.log, "utf8"), landed, final, E.recorded, unaccounted, o.mode));
  if (!o.keep) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (oracle) fs.rmSync(oracle.log, { force: true });
  }
  return res;
}

// Replays the oracle's ordered name events on the view path. Watched dirs: 0 the view's dir, 1 displaced,
// 2 prev, 3 the engine's temp dir. Whoever puts an inode at the view replaces the one there; that tells, for
// each unaccounted foreign write, whether a later foreign write or the engine removed it.
function replay(text: string, landed: string[], final: string | null, recorded: Set<string>, unaccounted: string[], mode: string) {
  const from = new Map<string, { di: string; name: string }>();
  const fate = new Map<string, string>();
  const arrived = new Set<string>();
  let occ: string | null = null;
  let overflow = 0;
  let bad = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [di, k, cookie, name] = line.split(" ") as [string, string, string, string];
    if (k === "O") {
      overflow++;
      continue;
    }
    // A link into prev/ takes prev/'s lock, not the view directory's, so its event isn't ordered with the view's
    // events and can't say which inode it linked. It isn't needed: the engine records whatever it finds in prev/k.
    if (di !== "0") {
      if (k === "F") from.set(cookie, { di, name });
      continue;
    }
    if (name !== VIEW) {
      if (k === "F") from.set(cookie, { di, name });
      continue;
    }
    if (k === "F") {
      if (occ?.[0] === "F") fate.set(occ, "displaced");
      occ = null;
      continue;
    } // displace moved it away
    let arriving: string;
    if (k === "C") {
      if (occ) bad++;
      arriving = "E";
    } // the engine's link
    else if (k === "T") {
      const src = from.get(cookie);
      from.delete(cookie);
      arriving = src?.di === "0" ? src.name.slice(VIEW.length + 1, -4) : src?.di === "3" ? "E" : "?";
      if (arriving === "?") bad++;
    } else {
      bad++;
      continue;
    }
    if (occ?.[0] === "F" && !fate.has(occ)) fate.set(occ, arriving[0] === "F" ? "superseded" : "engine");
    if (arriving[0] === "F") {
      if (arrived.has(arriving)) bad++;
      arrived.add(arriving);
    }
    occ = arriving;
  }
  const set = new Set(landed);
  const missing = landed.filter((t) => !arrived.has(t)).length;
  const extra = [...arrived].filter((t) => !set.has(t)).length;
  let superseded = 0;
  let lostByEngine = 0;
  let unattributed = 0;
  let engineAfterImport = 0;
  for (const t of unaccounted) {
    const f = fate.get(t);
    if (f === "superseded") superseded++;
    else if (f === "engine") lostByEngine++;
    else unattributed++;
  }
  for (const [t, f] of fate) if (f === "engine" && recorded.has(t)) engineAfterImport++;
  const finalMatch = occ === final || (occ === "E" && final?.[0] === "E");
  // An unaccounted write that nothing removed from the path, yet isn't the final view, means the log is incomplete.
  const oracleOk = !overflow && !bad && !missing && !extra && finalMatch && !unattributed;
  return {
    oracleOk,
    oracleBad: { overflow, bad, missing, extra, finalMatch, unattributed },
    engineAfterImport,
    superseded,
    lostByEngine: mode === "turn" ? lostByEngine + unattributed : lostByEngine,
    unattributed,
  };
}

// ---------------------------------------------------------------- matrix and table
function args(argv: string[]): Record<string, any> {
  const o: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++)
    if (argv[i]!.startsWith("--")) {
      const k = argv[i]!.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) o[k] = true;
      else {
        o[k] = v === "false" ? false : v === "true" ? true : isNaN(Number(v)) ? v : Number(v);
        i++;
      }
    }
  return o;
}

export function table(results: Record<string, any>[]): string {
  const g = new Map<string, Record<string, any>>();
  for (const r of results) {
    const key = [r.fs, r.mode, r.style, (r.engine === "async" ? "displace(async)" : r.protocol) + (r.settle ? "+settle" + lvl(r.settle) : ""), r.writers, r.widen, r.pace, r.reader || "none"].join("|");
    const a = g.get(key) ?? { key, trials: 0, rounds: 0, landed: 0, unaccounted: 0, superseded: 0, lostByEngine: null, eexist: 0, engineAfterImport: 0, oracleBad: 0, reads: 0, enoent: 0, torn: 0, probes: 0, absent: 0, busy: 0, gap: hist(), streak: hist(), pstreak: hist() };
    a.trials++;
    a.rounds += r.rounds;
    a.landed += r.landed;
    a.unaccounted += r.unaccounted;
    a.superseded += r.superseded ?? 0;
    if (r.lostByEngine !== undefined) a.lostByEngine = (a.lostByEngine ?? 0) + r.lostByEngine;
    a.eexist += r.eexist;
    a.engineAfterImport += r.engineAfterImport ?? 0;
    a.oracleBad += r.oracleOk === false ? 1 : 0;
    a.reads += r.reads ?? 0;
    a.enoent += r.enoent ?? 0;
    a.torn += r.torn ?? 0;
    a.probes += r.probes ?? 0;
    a.absent += r.absent ?? 0;
    a.busy += r.busy ?? 0;
    for (const k of ["gap", "streak", "pstreak"]) if (r[k]) (r[k] as Hist).forEach((v, i) => (a[k][i] += v));
    g.set(key, a);
  }
  const rows: unknown[][] = [["fs", "mode", "style", "protocol", "W", "widen µs", "pace ms", "readers", "trials", "rounds", "foreign writes", "unaccounted", "superseded by foreign", "LOST BY ENGINE", "imported then replaced", "EEXIST retries", "reads", "ENOENT", "torn", "engine gap µs p50/p99/max", "readFile ENOENT streak µs", "stat probes", "absent", "stat absent streak µs", "busy retries", "oracle bad"]];
  for (const a of g.values()) {
    const [fsl, mode, style, proto, w, widen, pace, rd] = (a.key as string).split("|");
    const q = (h: Hist) => (hq(h, 0.5) === null ? "" : `${hq(h, 0.5)}/${hq(h, 0.99)}/${hmax(h)}`);
    rows.push([fsl, mode, style, proto, w, widen, pace, rd, a.trials, a.rounds, a.landed, a.unaccounted, a.superseded, a.lostByEngine ?? "n/a (no oracle)", a.engineAfterImport, a.eexist, a.reads, a.enoent, a.torn, q(a.gap), q(a.streak), a.probes, a.absent, q(a.pstreak), a.busy, a.oracleBad]);
  }
  return rows
    .map((r) => "| " + r.join(" | ") + " |")
    .join("\n")
    .replace(/\n/, "\n|" + rows[0]!.map(() => "---").join("|") + "|\n");
}

async function main(): Promise<void> {
  const [role, json] = process.argv.slice(2);
  if (role === "writer") return writer(JSON.parse(json!));
  if (role === "reader") return reader(JSON.parse(json!));
  const a = args(process.argv.slice(2));
  const base = path.resolve(String(a.dir ?? path.join(os.tmpdir(), "carton-race")));
  fs.mkdirSync(base, { recursive: true });
  const defaults: Opts = {
    base,
    fsLabel: a.fs ?? `${process.platform}:${base}`,
    size: a.size ?? 4096,
    mode: "turn",
    style: "rename",
    protocol: "displace",
    engine: "sync",
    writers: 1,
    rounds: 5000,
    widen: 0,
    jitter: 60,
    pace: 0,
    reader: "read",
    oracle: a.oracle ? path.resolve(String(a.oracle)) : null,
    keep: !!a.keep,
  };
  const out = a.out ? path.resolve(String(a.out)) : null;
  const emit = (r: Record<string, any>) => {
    if (out) fs.appendFileSync(out, JSON.stringify(r) + "\n");
  };
  if (role === "trial") {
    const o: Opts = { ...defaults, ...a, base, fsLabel: defaults.fsLabel, oracle: defaults.oracle };
    const same = (r: Record<string, any>) => ["fs", "mode", "style", "protocol", "engine", "writers", "widen", "pace", "reader", "rounds"].every((k) => r[k] === (o as any)[k]) && lvl(r.settle) === lvl(o.settle);
    o.fs = o.fsLabel;
    const done = a.resume && out && exists(out) ? fs.readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter(same).length : 0;
    for (let i = done; i < (a.trials ?? 1); i++) {
      const r = await trial(o);
      emit(r);
      console.log(JSON.stringify({ ...r, gap: undefined, gapTotal: undefined, streak: undefined, pstreak: undefined }));
    }
    return;
  }
  if (role === "table") {
    const rs = fs.readFileSync(path.resolve(String(a.in)), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    console.log(table(rs));
    return;
  }
  // The portable matrix: every protocol, writers taking turns (exact accounting without an oracle), natural and
  // widened windows, plus in-place writers and the missing-path gap with a paced engine.
  const links = hardLinksWork(base);
  if (!links) console.log(`fs.link fails in ${base}: no hard links on this volume (FAT/exFAT?). Only "naive" can run; Carton falls back to stat-then-rename there (L13).`);
  const trials = a.trials ?? 3;
  const rounds = a.rounds ?? 3000;
  const protos: Opts["protocol"][] = links ? ["naive", "hardlink", "displace"] : ["naive"];
  const plan: Partial<Opts>[] = [];
  for (const protocol of protos) for (const writers of [1, 4]) for (const widen of [0, 100]) plan.push({ protocol, writers, widen });
  for (const protocol of protos) plan.push({ protocol, writers: 1, style: "inplace" });
  if (links) for (const settle of [1, 2]) plan.push({ protocol: "displace", writers: 1, style: "inplace", settle });
  if (links) for (const engine of ["sync", "async"] as const) plan.push({ protocol: "displace", engine, writers: 0, pace: 2, rounds: 1000, reader: "both" });
  const results: Record<string, any>[] = [];
  console.log(`${process.platform} ${os.release()}, node ${process.version}, dir ${base}; ${plan.length} configs x ${trials} trials`);
  for (const p of plan)
    for (let i = 0; i < trials; i++) {
      const r = await trial({ ...defaults, rounds, ...p });
      results.push(r);
      emit(r);
      process.stdout.write(`${p.protocol}${p.engine === "async" ? "(async)" : ""}${p.settle ? "+settle" + p.settle : ""} ${p.style ?? "rename"} W=${p.writers} widen=${p.widen ?? 0}: writes ${r.landed} unaccounted ${r.unaccounted} eexist ${r.eexist} enoent ${r.enoent}/${r.reads}${r.busy ? " busy-retries " + r.busy : ""}\n`);
    }
  console.log("\n" + table(results));
  console.log("\nIn turn mode every unaccounted foreign write was destroyed by the engine (writers never replace each other).");
  for (const style of ["rename", "inplace"])
    for (const p of protos) {
      const rs = results.filter((r) => r.protocol === p && r.style === style && r.writers > 0 && !r.settle);
      console.log(`${style.padEnd(7)} ${p.padEnd(8)}: ${rs.reduce((n, r) => n + r.unaccounted, 0)} of ${rs.reduce((n, r) => n + r.landed, 0)} foreign writes lost by the engine`);
    }
  for (const level of [1, 2]) {
    const st = results.filter((r) => lvl(r.settle) === level);
    if (st.length) console.log(`inplace displace+settle${level}: ${st.reduce((n, r) => n + r.unaccounted, 0)} of ${st.reduce((n, r) => n + r.landed, 0)} foreign writes lost by the engine`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
