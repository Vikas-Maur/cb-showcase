// The cardboard materializer's engine (`MaterializerEngine`, owned by cardboard-adapter) over Carton and carton.db.
// The materializer runs where the lease is held (the app's engine thread, or a helper while the app is closed), so its
// commits are the holder's own: a view save or a foreign save of the shared file goes straight into Carton.
//   - a save whose merge raises cards is committed with head's value kept for each card, and the cards reported
//     (§6.4: "Carton applies each save live"; the status sidecar and the actor's notice carry the cards);
//   - a record that breaks a hard validator blocks with a card (§4.1): it keeps head's value, the rest of the save
//     lands, and the sidecar's diagnostics name the failure. The sequencer refuses such a change as a whole
//     ("invalid") when nothing concurrent forced a merge, so the record is put back and the save committed again;
//   - printed refs are `<cut>@<seq>~<hash8>` plus the cut's id prefix, which Carton resolves exactly or refuses;
//   - view metadata lives in carton.db's local `views` table, shared by every process on this machine.
import type { Actor, Carton, CommitResult, ConflictCard, Doc, PinRow, StateRef } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import type { HeldBase, MaterializerEngine, SaveResult } from "@carton/cardboard/node";
import type { Rev } from "@carton/cardboard";
import { actorKey } from "./writes.ts";

const DAY = 86_400_000;

export class CartonMaterializerEngine implements MaterializerEngine {
  readonly carton: Carton;
  readonly store: Store;
  private isShared = false;

  constructor(carton: Carton, store?: Store) {
    this.carton = carton;
    this.store = store ?? (carton as unknown as { store: Store }).store;
  }

  async head(): Promise<Doc> {
    const cuts = await this.carton.cuts();
    this.isShared = cuts.find((c) => c.id === this.carton.cut)?.sequencer.kind !== "local";
    return (await this.carton.head()).doc;
  }

  async pin(opts: { owner: string; doc?: Doc; ttlMs: number }): Promise<{ ref: string; branchId: string; doc: Doc }> {
    const p = await this.carton.pin({ owner: opts.owner, ttlMs: opts.ttlMs ?? 7 * DAY, ...(opts.doc ? { doc: opts.doc } : {}) });
    const cut = (await this.carton.cuts()).find((c) => c.id === p.ref.branchId);
    const doc = opts.doc ?? (await this.carton.checkout(p.ref));
    return { ref: `${cut?.name ?? "cut"}@${p.ref.seq}~${p.ref.hash8}`, branchId: p.ref.branchId, doc };
  }

  /** Release every pin `owner` holds (its turn ended). */
  async release(owner: string): Promise<void> {
    const rows = await this.store.range<PinRow>("pins");
    for (const { value } of rows) {
      if (!value.owners?.some((o) => o.owner === owner)) continue;
      const ref: StateRef = { branchId: value.branchId, seq: value.seq, hash8: value.hash8 };
      await this.carton.release(ref, owner);
    }
  }

  async resolve(rev: Rev): Promise<HeldBase> {
    if (rev.kind !== "carton") throw Object.assign(new Error("state unknown: re-print (a 1.4.0 timestamp rev has no Carton state)"), { code: "STATE_UNKNOWN" });
    const r = await this.carton.resolve(this.refOf(rev));
    return { baseDoc: r.doc, baseSeq: r.seq, causal: r.causal };
  }

  private refOf(rev: Extract<Rev, { kind: "carton" }>): string {
    return rev.branch8 ? `${rev.ref} b:${rev.branch8}` : rev.ref;
  }

  async commit(input: { doc: Doc; base: Rev | HeldBase; author: Actor; meta: { file: string; view?: string } }): Promise<SaveResult> {
    const base = "baseDoc" in input.base ? input.base : this.refOf(input.base as Extract<Rev, { kind: "carton" }>);
    let doc = input.doc;
    const cards: ConflictCard[] = [];
    let r: CommitResult = await this.carton.commit({ doc, base, author: input.author });
    for (let round = 0; round < 32; round++) {
      if (r.status === "conflicts") {
        // keep head's value for every card, commit the rest, and report the cards
        cards.push(...r.cards);
        r = await this.carton.commit({ doc, base, author: input.author, choices: r.cards.map(() => "ours" as const) });
        continue;
      }
      // putting the invalid records back can leave nothing to commit; the sequencer calls that "no ops"
      if (r.status === "rejected" && r.reason === "no ops" && cards.length) { const h = await this.carton.head(); r = { status: "confirmed", seq: h.ref.seq, ref: h.ref, change: null, rebased: 0, notices: [], empty: true }; break; }
      if (r.status !== "rejected" || !r.invalid?.path) break;
      const segs = r.invalid.path.split("/").map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~"));
      if (segs.length < 2) break;
      const [coll, id] = segs;
      const key = this.carton.schema.collections[coll]?.key ?? "id";
      const head = (await this.carton.head()).doc;
      const was = ((head[coll] as Record<string, unknown>[] | undefined) ?? []).find((x) => String(x[key]) === id);
      const recs = (doc[coll] as Record<string, unknown>[] | undefined) ?? [];
      const mine = recs.find((x) => String(x[key]) === id);
      cards.push({ kind: "invalid", path: `${segs[0]}/${segs[1]}`, base: was, ours: was, theirs: mine, reason: r.invalid.error });
      doc = { ...doc, [coll]: was ? recs.map((x) => (String(x[key]) === id ? was : x)) : recs.filter((x) => String(x[key]) !== id) };
      r = await this.carton.commit({ doc, base, author: input.author });
    }
    switch (r.status) {
      case "confirmed": return { status: cards.length ? "conflicts" : "confirmed", id: r.change?.id, seq: r.seq, cards };
      case "pending": return { status: cards.length ? "conflicts" : "pending", id: r.id, cards };
      case "rejected": return { status: "rejected", reason: r.reason };
      default: return { status: "conflicts", cards: r.cards };
    }
  }

  async notice(to: Actor, n: { kind: "error" | "conflicts"; text: string; change?: string }): Promise<void> {
    const key = actorKey(to);
    const at = Date.now();
    await this.store.write([{ table: "notices", key: [key, at, 0, Math.random().toString(16).slice(2, 10)], value: { to: key, kind: n.kind === "conflicts" ? "late-conflict" : "rejected", text: n.text, ...(n.change ? { change: n.change } : {}), at } }]);
  }

  getMeta<T>(key: readonly string[]): Promise<T | undefined> {
    return this.store.get<T>("views", key);
  }
  async putMeta(key: readonly string[], value: unknown): Promise<void> {
    await this.store.write([{ table: "views", key, value }]);
  }
  shared(): boolean {
    return this.isShared;
  }
}
