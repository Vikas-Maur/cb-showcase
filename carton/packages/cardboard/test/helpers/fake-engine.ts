// Test doubles for the materializer: a fake clock that runs timers in order, and a small engine with a linear log,
// pins, notices and a field-level three-way merge over `timelineItems`. The real engine is exercised by the ported
// system tests in @carton/conformance; these keep the materializer's own logic testable on real files.
import type { Actor, Doc } from "@carton/core";
import type { Clock, HeldBase, MaterializerEngine, MaterializerHost, SaveResult } from "../../src/node/materializer.ts";
import type { Rev } from "../../src/header.ts";
import type { Project } from "../../src/codec.ts";

export class FakeClock implements Clock {
  t = 1_000_000;
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
  /** Advances time by `ms`, running due timers in order and waiting for the work each one queues. */
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

type Item = Record<string, unknown> & { id: string };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const items = (d: Doc): Item[] => (d.timelineItems ?? []) as Item[];
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Field-level merge3 over items by id; a field both sides changed differently keeps `ours` and is a card. */
export function merge3(base: Doc, ours: Doc, theirs: Doc): { doc: Doc; cards: { path: string }[] } {
  const cards: { path: string }[] = [];
  const b = new Map(items(base).map((i) => [i.id, i]));
  const o = new Map(items(ours).map((i) => [i.id, i]));
  const t = new Map(items(theirs).map((i) => [i.id, i]));
  const out: Item[] = [];
  const ids = [...new Set([...o.keys(), ...t.keys()])];
  for (const id of ids) {
    const bi = b.get(id),
      oi = o.get(id),
      ti = t.get(id);
    if (!bi) {
      out.push((oi ?? ti)!);
      continue;
    }
    if (!oi || !ti) {
      const kept = oi ?? ti!;
      if (!eq(kept, bi)) {
        out.push(kept);
        cards.push({ path: `timelineItems/${id}` });
      }
      continue;
    }
    const r: Item = { ...oi };
    for (const k of new Set([...Object.keys(bi), ...Object.keys(oi), ...Object.keys(ti)])) {
      const tChanged = !eq(ti[k], bi[k]);
      const oChanged = !eq(oi[k], bi[k]);
      if (tChanged && !oChanged) {
        if (ti[k] === undefined) delete r[k];
        else r[k] = ti[k];
      } else if (tChanged && oChanged && !eq(ti[k], oi[k])) cards.push({ path: `timelineItems/${id}/${k}` });
    }
    out.push(r);
  }
  const doc: Doc = { ...ours, timelineItems: out };
  for (const k of Object.keys(theirs)) if (k !== "timelineItems" && !eq(theirs[k], base[k]) && eq(ours[k], base[k])) doc[k] = theirs[k];
  return { doc, cards };
}

export interface FakeCommit {
  id: string;
  seq: number;
  author: Actor;
  file: string;
  view?: string;
  base: string;
  cards: number;
}

export class FakeEngine implements MaterializerEngine {
  readonly log: { doc: Doc; id: string; causal: string[] }[] = [];
  readonly commits: FakeCommit[] = [];
  readonly notices: { to: string; kind: string; text: string }[] = [];
  readonly pins = new Map<string, { doc: Doc; seq: number; owners: Set<string>; causal: string[] }>();
  readonly meta = new Map<string, unknown>();
  isShared = false;
  private n = 0;
  constructor(doc: Doc) {
    this.log.push({ doc: clone(doc), id: "root", causal: [] });
  }
  get headSeq(): number {
    return this.log.length - 1;
  }
  async head(): Promise<Doc> {
    return clone(this.log.at(-1)!.doc);
  }
  /** A change made elsewhere (the GUI, a remote): applied at head with no merge. */
  external(fn: (d: Doc) => void, id = `ext.${++this.n}`): void {
    const d = clone(this.log.at(-1)!.doc);
    fn(d);
    this.log.push({ doc: d, id, causal: [] });
  }
  async pin({ owner, doc }: { owner: string; doc?: Doc; ttlMs: number }) {
    const d = doc ? clone(doc) : await this.head();
    const h8 = hash8(JSON.stringify(d));
    const ref = `main@${this.headSeq}~${h8}`;
    const p = this.pins.get(ref) ?? { doc: d, seq: this.headSeq, owners: new Set<string>(), causal: this.log.slice(1).map((x) => x.id) };
    p.owners.add(owner);
    this.pins.set(ref, p);
    return { ref, branchId: "b7e1c2d3-0000-4000-8000-000000000000", doc: clone(d) };
  }
  async release(owner: string): Promise<void> {
    for (const [ref, p] of this.pins) {
      p.owners.delete(owner);
      if (!p.owners.size) this.pins.delete(ref);
    }
  }
  async resolve(rev: Rev): Promise<HeldBase> {
    const p = rev.kind === "carton" ? this.pins.get(rev.ref) : undefined;
    if (!p) throw new Error("state unknown: re-print");
    return { baseDoc: clone(p.doc), baseSeq: p.seq, causal: [...p.causal] };
  }
  async commit({ doc, base, author, meta }: { doc: Doc; base: Rev | HeldBase; author: Actor; meta: { file: string; view?: string } }): Promise<SaveResult> {
    const held = "baseDoc" in base ? base : await this.resolve(base);
    const m = merge3(held.baseDoc, await this.head(), doc);
    const id = `fake.${++this.n}`;
    this.log.push({ doc: m.doc, id, causal: [] });
    this.commits.push({ id, seq: this.headSeq, author, file: meta.file, view: meta.view, base: "baseDoc" in base ? "held" : base.kind === "carton" ? base.ref : String(base.rev), cards: m.cards.length });
    return { status: m.cards.length ? "conflicts" : "confirmed", id, seq: this.headSeq, cards: m.cards.map((c) => ({ kind: "field", path: c.path }) as never) };
  }
  async notice(to: Actor, n: { kind: string; text: string }): Promise<void> {
    this.notices.push({ to: to.id, kind: n.kind, text: n.text });
  }
  async getMeta<T>(key: readonly string[]): Promise<T | undefined> {
    const v = this.meta.get(JSON.stringify(key));
    return v === undefined ? undefined : (clone(v) as T);
  }
  async putMeta(key: readonly string[], value: unknown): Promise<void> {
    this.meta.set(JSON.stringify(key), clone(value));
  }
  shared(): boolean {
    return this.isShared;
  }
}

function hash8(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A host whose engine docs are the project's timeline slice itself. */
export const plainHost: MaterializerHost = {
  fromProject: (p: Project) => ({ timelineItems: clone(p.timelineItems ?? []), ...(p.name !== undefined ? { name: p.name } : {}) }),
  toProject: (d: Doc, cur: Project | null) => ({ ...(cur ?? {}), ...clone(d) }),
  merge3: (b, o, t) => merge3(b, o, t).doc,
  diagnose: () => [],
};
