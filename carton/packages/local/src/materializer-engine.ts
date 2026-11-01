// The cardboard materializer's engine on the lease holder. cardboard-adapter's `cartonMaterializerEngine` does the
// work (pins, legacy revs, view metadata, notices, cards that keep head's value); this wrapper adds two things the
// holder knows about:
//   - whether the current cut is shared (remote rewrites of the shared file are spaced 30 s apart, R5-05);
//   - a file save's cards (a view or the shared timeline.tsx) are kept for its author as `cb` commits' are, so `cb
//     conflicts` lists them and `cb resolve` picks one (B5); a text-only notice for that save is then not stored twice;
//   - a record that breaks a hard validator blocks with a card (§4.1): it keeps head's value, the rest of the save
//     lands, and the sidecar's diagnostics name the failure. The sequencer refuses such a change as a whole
//     ("invalid") when nothing concurrent forced a merge, so the record is put back and the save committed again.
// (Proposed to cardboard-adapter for their engine; this wrapper goes away once it is there.)
import type { Actor, Carton, ConflictCard, Doc } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { cardsRow } from "./writes.ts";
import { cartonMaterializerEngine } from "@carton/cardboard/node";
import type { MaterializerEngine, SaveResult } from "@carton/cardboard/node";

type Bad = { coll: string; key: string; id: string; error: string };

export class CartonMaterializerEngine implements MaterializerEngine {
  readonly carton: Carton;
  private inner: MaterializerEngine;
  private isShared = false;
  /** Saves whose cards this wrapper kept (their own notice holds them): the materializer's text notice is redundant. */
  private carded = new Set<string>();

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
  notice(...a: Parameters<MaterializerEngine["notice"]>) {
    const [, n] = a;
    if (n.kind === "conflicts" && n.change && this.carded.has(n.change)) return Promise.resolve();
    return this.inner.notice(...a);
  }
  getMeta<T>(key: readonly string[]) { return this.inner.getMeta<T>(key); }
  putMeta(key: readonly string[], value: unknown) { return this.inner.putMeta(key, value); }
  shared(): boolean { return this.isShared; }
  /** The id a save records before committing: its retry commits (and keeps its cards) under the same one. */
  newChangeId(): string { return this.inner.newChangeId?.() ?? this.carton.newChangeId(); }

  async commit(input: Parameters<MaterializerEngine["commit"]>[0]): Promise<SaveResult> {
    const out = await this.commitOnce(input);
    // cards that can be picked later (an invalid record can't be put back as the agent wrote it: its sidecar says why)
    const cards = out.status === "rejected" ? [] : (out.cards ?? []).filter((c) => c.kind !== "invalid");
    // the change's id: the result's, or the one the materializer recorded before committing
    if (cards.length) await this.keepCards(input.author, out.id ?? input.id ?? null, cards);
    return out;
  }

  /** The author's cards notice for a file save, as a `cb` commit's (its sidecar already showed them: delivered). */
  private async keepCards(author: Actor, change: string | null, cards: ConflictCard[]): Promise<void> {
    const store = (this.carton as unknown as { store: Store }).store;
    await store.write([cardsRow(author, change ?? `save-${Date.now()}`, change, cards)]);
    if (!change) return;
    this.carded.add(change);
    if (this.carded.size > 1000) this.carded.delete(this.carded.values().next().value!);
  }

  private async commitOnce(input: Parameters<MaterializerEngine["commit"]>[0]): Promise<SaveResult> {
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
