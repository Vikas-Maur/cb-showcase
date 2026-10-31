// The world the ported system tests run in: the real engine and history (`Carton.open` on store-memory), the Cardboard
// adapter, and the real materializer on real files (`@carton/cardboard/node`), under a virtual clock. Remote changes
// are commits by another author followed by a "remote" head change, as a sync client delivers them; the GUI is the
// human's commits at head. Agents follow Claude Code's rule: Edit and Write refuse a file whose content changed since
// the agent last read it (`checks: false` models a writer without it). Port of system-v11 `world.mjs`/`agent.mjs` for
// the file-level scenarios.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import { Carton } from "@carton/core";
import type { Actor, Doc, Rec, Op } from "@carton/core";
import { createMemoryStore } from "@carton/store-memory";
import { cardboardAdapter, cardboardFilesHost, fromHost, toHost, findRev, jsonTimelineCodec, type TimelineCodec } from "@carton/cardboard";
import { Materializer, cartonMaterializerEngine, TIMELINE_FILE, PROJECT_FILE, type Clock } from "@carton/cardboard/node";

export const SCRATCH = process.env.CARTON_SCRATCH ?? path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "conformance");
export type Item = Rec & { id: string };

export const clip = (id: string, s: number, e: number, extra: Rec = {}): Item => ({ id, trackId: "V1", type: "video", name: id, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, opacity: 1, ...extra });
export const text = (id: string, s: string, track = "T2"): Item => ({ id, trackId: track, type: "text", name: id, textContent: s, startTime: 0, endTime: 3, trimStart: 0, trimEnd: 3, opacity: 1 });
export const clips = (n: number, prefix = "c"): Item[] => Array.from({ length: n }, (_, i) => clip(`${prefix}${i}`, i * 5, i * 5 + 5));
export const find = (items: Item[], id: string): Item => items.find((i) => i.id === id)!;

export class VirtualClock implements Clock {
  t = 1_800_000_000_000;
  private timers: { at: number; seq: number; fn: () => void }[] = [];
  private seq = 0;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { at: this.t + Math.max(0, ms), seq: this.seq++, fn };
    this.timers.push(timer);
    return timer;
  }
  clearTimeout(h: unknown): void {
    this.timers = this.timers.filter((x) => x !== h);
  }
  async advance(ms: number, idle: () => Promise<void>): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await idle();
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
    await idle();
  }
}

export const HUMAN: Actor = { kind: "human", id: "human:m1", name: "m1", group: "local:me@m1" };
export const BOB: Actor = { kind: "human", id: "human:m2-bob", name: "Bob" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface WorldOptions {
  items: Item[];
  tracks?: string[];
  codec?: TimelineCodec;
}

export async function openWorld(t: TestContext, o: WorldOptions) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const bundle = fs.mkdtempSync(path.join(SCRATCH, "world-"));
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  const tracks = (o.tracks ?? ["V1", "T2"]).map((id, i) => ({ id, name: id, order: i, locked: false, visible: true, muted: false }));
  const project = { id: "p-fixture", name: "Fixture", aspectRatio: "16:9", stateUpdatedAt: 1, tracks, timelineItems: o.items, media: [] };
  fs.writeFileSync(path.join(bundle, PROJECT_FILE), JSON.stringify({ format: "cardboard-project", version: 1, project, media: [] }));
  const clock = new VirtualClock();
  const store = createMemoryStore();
  const carton = await Carton.open({ adapter: cardboardAdapter, store, init: { doc: fromHost(project, null), projectId: project.id }, actor: HUMAN, clock: () => clock.now() });
  let shared = false;
  const engine = cartonMaterializerEngine(carton, { shared: () => shared, clock: () => clock.now() });
  const mz = new Materializer({ bundle, engine, host: cardboardFilesHost, codec: o.codec ?? jsonTimelineCodec, clock });
  t.after(() => mz.close());
  await engine.putMeta(["file", PROJECT_FILE, "pin"], (await engine.pin({ owner: "project-file", ttlMs: 7 * 86_400_000 })).ref);
  await mz.adoptCurrentFiles();
  await mz.start();
  const abs = (rel: string) => path.join(bundle, ...rel.split("/"));
  const tick = (ms: number) => clock.advance(ms, () => mz.idle());
  const head = async (): Promise<Item[]> => toHost((await carton.head()).doc).timelineItems as Item[];
  const headDoc = async (): Promise<Doc> => (await carton.head()).doc;
  /** A change at head by `who` (the GUI's human, or a remote teammate whose change just arrived). */
  const commitAt = async (who: Actor, fn: (items: Item[]) => void, cause: "gui" | "remote") => {
    const h = toHost((await carton.head()).doc);
    const items = structuredClone(h.timelineItems as Item[]);
    fn(items);
    const r = await carton.commit({ doc: fromHost({ ...h, timelineItems: items }, (await carton.head()).doc), author: who });
    mz.onHeadChange(cause);
    return r;
  };
  let k = 0;
  const writeAtomic = (rel: string, content: string) => {
    const tmp = abs(`.${path.basename(rel)}.${k++}.tmp`);
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, abs(rel));
    mz.onFsEvent(rel); // the watch event; read when the queue gets to it
  };
  return {
    bundle,
    carton,
    engine,
    mz,
    clock,
    abs,
    tick,
    head,
    headDoc,
    gui: (fn: (items: Item[]) => void) => commitAt(HUMAN, fn, "gui"),
    remote: (fn: (items: Item[]) => void, who: Actor = BOB) => commitAt(who, fn, "remote"),
    setShared: (v: boolean) => void (shared = v),
    writeAtomic,
    writeInPlace: (rel: string, content: string) => {
      fs.writeFileSync(abs(rel), content);
      mz.onFsEvent(rel);
    },
    agent: (name: string, a: { checks?: boolean; hooked?: boolean; actor?: Partial<Actor> } = {}) => new Agent(name, { abs, writeAtomic, mz, tick }, a),
  };
}
export type World = Awaited<ReturnType<typeof openWorld>>;

/** A file the agent read: the text, its header line, and the timeline it shows. */
export interface Read {
  text: string;
  header: string;
  ref: string | null;
  items: Item[];
  doc: Rec;
}
export function parseFile(content: string): Read {
  const f = findRev(content);
  const body = f ? content.slice(f.end) : content;
  const doc = JSON.parse(body.slice(body.indexOf("{"))) as Rec;
  return { text: content, header: f?.line ?? "", ref: f?.rev?.kind === "carton" ? f.rev.ref : null, items: (doc.timelineItems ?? []) as Item[], doc };
}
export function render(r: Read, items: Item[]): string {
  return `// edited by an agent\n${r.header}\n${JSON.stringify({ ...r.doc, timelineItems: items })}\n`;
}

export class Agent {
  readonly name: string;
  readonly actor: Actor;
  readonly checks: boolean;
  readonly hooked: boolean;
  private seen = new Map<string, string>();
  readonly stats = { reads: 0, edits: 0, refusals: 0 };
  private readonly w: { abs: (rel: string) => string; writeAtomic: (rel: string, c: string) => void; mz: Materializer; tick: (ms: number) => Promise<void> };
  constructor(name: string, w: Agent["w"], o: { checks?: boolean; hooked?: boolean; actor?: Partial<Actor> }) {
    this.w = w;
    this.name = name;
    this.checks = o.checks ?? true;
    this.hooked = o.hooked ?? false;
    this.actor = { kind: "agent", id: name, name, ...(o.actor ?? {}) };
  }
  async read(rel = TIMELINE_FILE): Promise<Read> {
    if (this.hooked && rel === TIMELINE_FILE) await this.w.mz.hookRead(this.actor); // PreToolUse, before the read
    const content = fs.readFileSync(this.w.abs(rel), "utf8");
    this.seen.set(rel, sha(content));
    this.stats.reads++;
    return parseFile(content);
  }
  /** Claude Code's Edit: refuses when the file changed since the last read; returns false then. */
  async edit(rel: string, fn: (items: Item[]) => void): Promise<boolean> {
    const content = fs.readFileSync(this.w.abs(rel), "utf8");
    if (this.checks && this.seen.get(rel) !== sha(content)) {
      this.stats.refusals++;
      return false;
    }
    const r = parseFile(content);
    const items = structuredClone(r.items);
    fn(items);
    const out = render(r, items);
    if (this.hooked) await this.w.mz.hookWrite(this.actor, rel); // PreToolUse on Edit
    this.w.writeAtomic(rel, out);
    this.seen.set(rel, sha(out));
    this.stats.edits++;
    return true;
  }
  /** Edit, re-reading after a refusal, as agents do. */
  async editUntilDone(rel: string, fn: (items: Item[]) => void): Promise<void> {
    for (let i = 0; i < 10; i++) {
      if (await this.edit(rel, fn)) return;
      await this.read(rel);
    }
    throw new Error(`${this.name}: 10 refusals editing ${rel}`);
  }
  /** A whole-file write of content built earlier (no staleness check). */
  async write(rel: string, content: string): Promise<void> {
    if (this.hooked) await this.w.mz.hookWrite(this.actor, rel); // PreToolUse on Write
    this.w.writeAtomic(rel, content);
  }
  async stop(): Promise<void> {
    if (this.hooked) await this.w.mz.hookStop(this.actor);
  }
}

export const opsTouch = (ops: readonly Op[]) => new Set(ops.map((o) => o.path.slice(0, 2).join("/")));
