// The cardboard materializer's engine on the lease holder. cardboard-adapter's `cartonMaterializerEngine` does the
// work (pins, legacy revs, view metadata, notices, cards that keep head's value, and a file save's cards kept for its
// author as `cb` commits' are: B5, `fd9541a`); this wrapper adds two things the holder knows about:
//   - whether the current cut is shared (remote rewrites of the shared file are spaced 30 s apart, R5-05);
//   - a record that breaks a hard validator blocks with a card (§4.1): it keeps head's value, the rest of the save
//     lands, and the sidecar's diagnostics name the failure. The sequencer refuses such a change as a whole
//     ("invalid") when nothing concurrent forced a merge, so the record is put back and the save committed again.
// Everything else is the inner engine's, passed through: the current cut and head key (the freeze follows a cut
// switch, B6; `onExternalHeadChange`, B11), and an author's own inserts (M4).
// (Proposed to cardboard-adapter for their engine; this wrapper goes away once it is there.)
import type { Carton, ConflictCard, Doc } from "@carton/core";
import { cartonMaterializerEngine } from "@carton/cardboard/node";
import type { MaterializerEngine, SaveResult } from "@carton/cardboard/node";

type Bad = { coll: string; key: string; id: string; error: string };

export class CartonMaterializerEngine implements MaterializerEngine {
  readonly carton: Carton;
  private inner: MaterializerEngine;
  private isShared = false;

  constructor(carton: Carton, opts: { cut?: string } = {}) {
    this.carton = carton;
    this.inner = cartonMaterializerEngine(carton, { cut: opts.cut, shared: () => this.isShared });
  }

  async head(): Promise<Doc> {
    const cuts = await this.carton.cuts();
    this.isShared = cuts.find((c) => c.id === this.carton.cut)?.sequencer.kind !== "local";
    return this.inner.head();
  }
  pin(o: Parameters<MaterializerEngine["pin"]>[0]) { return this.inner.pin(o); }
  release(owner: string) { return this.inner.release(owner); }
  resolve(rev: Parameters<MaterializerEngine["resolve"]>[0]) { return this.inner.resolve(rev); }
  notice(...a: Parameters<MaterializerEngine["notice"]>) { return this.inner.notice(...a); }
  getMeta<T>(key: readonly string[]) { return this.inner.getMeta<T>(key); }
  putMeta(key: readonly string[], value: unknown) { return this.inner.putMeta(key, value); }
  shared(): boolean { return this.isShared; }
  /** The id a save records before committing: its retry commits (and keeps its cards) under the same one. */
  newChangeId(): string { return this.inner.newChangeId?.() ?? this.carton.newChangeId(); }
  /** The cut pins and commits go to: the freeze restarts when it is another one (B6). */
  cut(): string { return this.inner.cut?.() ?? this.carton.cut; }
  /** The current cut's head as a key, read fresh (B11: another process may have moved it). */
  headRef(): Promise<string> {
    if (this.inner.headRef) return this.inner.headRef();
    return this.carton.head(this.cut()).then((h) => JSON.stringify([this.cut(), h.ref.branchId, h.ref.seq, h.ref.pending ?? []]));
  }
  own(author: Parameters<NonNullable<MaterializerEngine["own"]>>[0]) { return this.inner.own?.(author) ?? this.carton.own(author); }

  /**
   * The inner engine keeps a save's merge cards for its author (written before the choosing commit, so a retry never
   * brings back a card resolved meanwhile); the invalid-record cards added here stay out (they can't be put back as the
   * agent wrote them: the sidecar says why).
   */
  async commit(input: Parameters<MaterializerEngine["commit"]>[0]): Promise<SaveResult> {
    let doc = input.doc;
    const invalid: ConflictCard[] = [];
    for (let round = 0; round < 32; round++) {
      const r = await this.inner.commit({ ...input, doc });
      const refusedInvalid = r.status === "rejected" && /^invalid\b/.test(r.reason ?? "");
      // putting the invalid records back can leave nothing to commit; the sequencer calls that "no ops"
      if (r.status === "rejected" && r.reason === "no ops" && invalid.length) return { status: "conflicts", cards: invalid, seq: (await this.carton.head()).ref.seq };
      if (!refusedInvalid) return invalid.length ? { ...r, status: r.status === "rejected" ? r.status : "conflicts", cards: [...invalid, ...(r.cards ?? [])] } : r;
      const bad = this.invalidRecords(doc);
      if (!bad.length) return r;
      const head = (await this.carton.head()).doc;
      for (const { coll, key, id, error } of bad) {
        const was = ((head[coll] as Record<string, unknown>[] | undefined) ?? []).find((x) => String(x[key]) === id);
        const recs = (doc[coll] as Record<string, unknown>[] | undefined) ?? [];
        invalid.push({ kind: "invalid", path: `${coll}/${id}`, base: was, ours: was, theirs: recs.find((x) => String(x[key]) === id), reason: error });
        doc = { ...doc, [coll]: was ? recs.map((x) => (String(x[key]) === id ? was : x)) : recs.filter((x) => String(x[key]) !== id) };
      }
    }
    return { status: "rejected", reason: "invalid" };
  }

  /** Records of `doc` that fail the schema's hard validators. */
  private invalidRecords(doc: Doc): Bad[] {
    const hard = this.carton.schema.hard;
    if (!hard) return [];
    const out: Bad[] = [];
    for (const [coll, spec] of Object.entries(this.carton.schema.collections)) {
      for (const r of (doc[coll] as Record<string, unknown>[] | undefined) ?? []) {
        const errs = hard(coll, r, doc);
        if (errs.length) out.push({ coll, key: spec.key, id: String(r[spec.key]), error: errs.join("; ") });
      }
    }
    return out;
  }
}
