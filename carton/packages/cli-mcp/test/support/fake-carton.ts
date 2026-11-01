// A small in-memory stand-in for core's `Carton` handle, for the command-layer tests until `Carton.open` lands. It
// keeps one log per cut with whole states (no merge3: a fold copies the other cut's changed records), which is enough
// to check parsing, routing, the result contract and the text output. Engine-backed tests replace it later.
import { defineSchema } from "@carton/core";
import type { Actor, Carton, CommitInput, CommitResult, CutRecord, Doc, Notice, StateRef, Version } from "@carton/core";

interface Entry { seq: number; doc: Doc; change: string | null; author: Actor | null; at: number; kind: string; touched: string[]; name?: string }

const clone = <T>(x: T): T => structuredClone(x);
const KEYS = ["tracks", "timelineItems"] as const;

function setPath(doc: any, path: readonly (string | number)[], value: unknown, op: string) {
  const [coll, id, ...rest] = path as string[];
  const arr: any[] = doc[coll] ?? (doc[coll] = []);
  const i = arr.findIndex((r) => r.id === id);
  if (rest.length === 0) {
    if (op === "remove") { if (i >= 0) arr.splice(i, 1); }
    else if (i < 0) arr.push(clone(value));
    return;
  }
  if (i < 0) return;
  const rec = (arr[i] = { ...arr[i] });
  if (op === "unset") delete rec[rest[0]]; else rec[rest[0]] = value;
}

export class FakeCarton {
  projectId = "p1";
  cut = "main0000-0000";
  logs = new Map<string, Entry[]>();
  recs = new Map<string, CutRecord>();
  noticeBox = new Map<string, Notice[]>();
  clock = 1_700_000_000_000;
  sync = null;
  media = null;
  schema = defineSchema({
    collections: { tracks: { key: "id" }, timelineItems: { key: "id" } },
    timeline: { collection: "timelineItems", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" } as any,
  });
  calls: string[] = [];

  constructor(doc: Doc) {
    this.recs.set(this.cut, { id: this.cut, name: "main", forkOf: null, owner: "me", kind: "main", sequencer: { kind: "local" } });
    this.logs.set(this.cut, [{ seq: 0, doc: clone(doc), change: null, author: null, at: this.clock, kind: "root", touched: [] }]);
  }
  private L(cut = this.cut) { const l = this.logs.get(cut); if (!l) throw new Error(`no cut ${cut}`); return l; }
  private at(ref: StateRef | string): Entry {
    const r = typeof ref === "string" ? ((): StateRef => { const [b, s] = ref.split("@"); return { branchId: b, seq: Number(s) }; })() : ref;
    const e = this.L(r.branchId)[r.seq];
    if (!e) throw Object.assign(new Error(`state unknown: re-print (${r.branchId}@${r.seq})`), { code: "STATE_UNKNOWN" });
    return e;
  }
  async head(cut = this.cut) { const l = this.L(cut); const e = l.at(-1)!; return { ref: { branchId: cut, seq: e.seq }, doc: clone(e.doc) }; }
  async checkout(ref: StateRef | string) { return clone(this.at(ref).doc); }
  async cuts() { return [...this.recs.values()]; }
  private append(cut: string, doc: Doc, author: Actor | null, kind: string, id: string | null, touched: string[]): CommitResult {
    const l = this.L(cut);
    const seq = l.length;
    l.push({ seq, doc, change: id, author, at: (this.clock += 60_000), kind, touched });
    return { status: "confirmed", seq, ref: { branchId: cut, seq }, change: null, rebased: 0, notices: [] };
  }
  async commit(i: CommitInput): Promise<CommitResult> {
    this.calls.push(`commit ${i.id}`);
    const cut = i.cut ?? this.cut;
    const l = this.L(cut);
    const known = l.find((e) => e.change === i.id && i.id);
    if (known) return { status: "confirmed", seq: known.seq, ref: { branchId: cut, seq: known.seq }, change: null, rebased: 0, notices: [] };
    const doc = clone(l.at(-1)!.doc);
    const touched: string[] = [];
    for (const op of i.ops ?? []) { setPath(doc, op.path, (op as any).value, op.op); touched.push(`${op.path[0]}/${op.path[1]}`); }
    if (i.doc) { for (const k of KEYS) { const was = JSON.stringify((doc as any)[k]); (doc as any)[k] = clone((i.doc as any)[k]); for (const r of (doc as any)[k] ?? []) if (!was.includes(JSON.stringify(r))) touched.push(`${k}/${r.id}`); } }
    if (!touched.length && !i.doc) return { status: "confirmed", seq: l.length - 1, ref: { branchId: cut, seq: l.length - 1 }, change: null, rebased: 0, notices: [], empty: true };
    return this.append(cut, doc, i.author ?? null, "edit", i.id ?? `fake.${l.length}`, touched);
  }
  async pin() { return { ref: { branchId: this.cut, seq: 0 }, header: "" }; }
  async release() {}
  async fork(name: string, o: { from?: StateRef | string; kind?: any } = {}) {
    const id = `cut${this.recs.size}0000-0000`;
    const from = o.from ? this.at(o.from) : this.L().at(-1)!;
    this.recs.set(id, { id, name, forkOf: `${this.cut}@${from.seq}`, owner: "me", kind: o.kind ?? "variant", sequencer: { kind: "local" } });
    this.logs.set(id, [{ seq: 0, doc: clone(from.doc), change: null, author: null, at: this.clock, kind: "fork", touched: [] }]);
    return this.recs.get(id)!;
  }
  async switchTo(cut: string) { this.cut = cut; }
  async fold(from: string | StateRef, o: any = {}) {
    const into = o.into ?? this.cut;
    const src = typeof from === "string" && this.logs.has(from) ? this.L(from).at(-1)! : this.at(from);
    if (o.check) return { status: "confirmed", seq: 0, ref: { branchId: into, seq: 0 }, change: null, rebased: 0, notices: [], cards: [] } as any;
    const doc = clone(this.L(into).at(-1)!.doc) as any;
    for (const k of KEYS) doc[k] = clone((src.doc as any)[k]);
    for (const p of o.reject ?? []) { const [c, id] = p.split("/"); const before = (this.L(into).at(-1)!.doc as any)[c].find((r: any) => r.id === id); doc[c] = doc[c].filter((r: any) => r.id !== id); if (before) doc[c].push(before); }
    return this.append(into, doc, o.author ?? null, "merge", `fold.${this.clock}`, []);
  }
  async foldSome(from: string | StateRef, o: any) { return this.fold(from, o); }
  async diff(a: StateRef | string, b?: StateRef | string) {
    const da: any = this.at(a).doc, db: any = b ? this.at(b).doc : this.L().at(-1)!.doc;
    const lines: string[] = [];
    for (const k of KEYS) for (const r of db[k] ?? []) { const o = (da[k] ?? []).find((x: any) => x.id === r.id); if (!o) lines.push(`added ${r.id}`); else if (JSON.stringify(o) !== JSON.stringify(r)) lines.push(`changed ${r.id}`); }
    for (const k of KEYS) for (const r of da[k] ?? []) if (!(db[k] ?? []).some((x: any) => x.id === r.id)) lines.push(`removed ${r.id}`);
    return { ops: lines.map(() => ({ op: "set", path: ["x"], value: 1 }) as any), describe: lines };
  }
  async shots() { return { shotsA: 0, shotsB: 0, unchanged: 0, shifted: 0, changed: [] }; }
  async log(o: { cut?: string; limit?: number } = {}): Promise<Version[]> {
    const cut = o.cut ?? this.cut;
    return this.L(cut).filter((e) => e.seq > 0).reverse().slice(0, o.limit ?? 1e9).map((e) => ({ ref: { branchId: cut, seq: e.seq }, hash: "", change: e.change, author: e.author, at: e.at, kind: e.kind as any, name: e.name }));
  }
  async name() {}
  async restore(ref: StateRef | string, o: any = {}) { return this.append(o.cut ?? this.cut, clone(this.at(ref).doc), o.author ?? null, "restore", `restore.${this.clock}`, []); }
  async revert(changeId: string, o: any = {}) {
    const l = this.L(o.cut ?? this.cut);
    const e = l.find((x) => x.change === changeId);
    if (!e) throw new Error(`no change ${changeId}`);
    const doc = clone(l.at(-1)!.doc) as any, before: any = l[e.seq - 1].doc;
    for (const t of e.touched) { const [c, id] = t.split("/"); doc[c] = doc[c].filter((r: any) => r.id !== id); const b = before[c].find((r: any) => r.id === id); if (b) doc[c].push(clone(b)); }
    return this.append(o.cut ?? this.cut, doc, o.author ?? null, "revert", `revert.${changeId}`, e.touched);
  }
  async undo(group?: string, o: any = {}) {
    const l = this.L(o.cut ?? this.cut);
    const undone = new Set(l.filter((e) => e.kind === "revert").map((e) => e.change!.slice("revert.".length)));
    const e = [...l].reverse().find((x) => x.kind === "edit" && x.author?.group === group && !undone.has(x.change!));
    if (!e) return { status: "confirmed", seq: l.length - 1, ref: { branchId: this.cut, seq: l.length - 1 }, change: null, rebased: 0, notices: [], empty: true } as any;
    const r: any = await this.revert(e.change!, o);
    return { ...r, entry: { changeId: e.change, seq: e.seq, branchId: this.cut, label: `Undo ${e.author?.name}`, author: e.author, at: e.at } };
  }
  async undoStack() { return []; }
  async preview(ref: any) { return { ref, doc: await this.checkout(ref), readOnly: true as const }; }
  async credits(record: any, o: any = {}) {
    const key = Array.isArray(record) ? record.join("/") : record;
    const e = [...this.L(o.cut ?? this.cut)].reverse().find((x) => x.touched.includes(key));
    return e?.author ?? null;
  }
  async notices(actor?: Actor, o: { take?: boolean } = {}) {
    const k = actor?.id ?? "?";
    const l = this.noticeBox.get(k) ?? [];
    if (o.take) this.noticeBox.delete(k);
    return l;
  }
  async exportShallow(): Promise<any> { return null; }
  async importShallow(): Promise<any> { return { status: "imported" }; }
  on() { return () => {}; }
  async close() {}
}

export const fakeCarton = (doc: Doc): Carton => new FakeCarton(doc) as unknown as Carton;
