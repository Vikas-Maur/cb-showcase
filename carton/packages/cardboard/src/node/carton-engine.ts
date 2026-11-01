// The materializer's engine over a real `Carton` handle (`@carton/core`) and the Store it was opened on. `@carton/local`
// passes it to `new Materializer(...)` in the lease holder; tests use it on store-memory.
//
// - Pins carry the owner they were made for, and each owner's refs are kept in the local `views` table, one key per
//   ref, so a turn ending (`release(owner)`) releases every pin it took, whichever process made them, and a long-lived
//   owner (the shared file's prints) never rewrites a growing list. Records past their pin's expiry are pruned.
// - A save's cards keep head's value (as the system proof's materializer did): the first commit reports them, then the
//   save is committed with head's side chosen for each card, and the cards go to the materializer (status sidecar,
//   notices, the human's conflict cards).
// - They are also kept for the save's author as a `cb` commit's are (B5): one notices row per save, the key and shape
//   `@carton/local`'s `cardsRow` writes (so whichever writes it, there is one row), already delivered (the sidecar showed
//   them). `cb conflicts` lists them and `cb resolve` picks one; the materializer's text notice for that save is then
//   not stored as well.
// - A 1.4.0 timestamp rev resolves only through the mapping written at migration (`recordLegacyRev`).
// - A record that breaks a hard validator blocks with a card (§4.1): it keeps head's value, the rest of the save lands,
//   and the sidecar's diagnostics name the failure. The sequencer refuses such a change as a whole ("invalid") when
//   nothing concurrent forced a merge, so the record is put back and the save committed again (`@carton/local`'s engine
//   wrapper did this until it moved here, behaviour unchanged).
// - Whether the cut is shared is read from it at each `head()` (its sequencer isn't "local"), unless the caller says.
import { StateUnknown, actorKey } from "@carton/core";
import type { Actor, Carton, Doc, Notice, NoticeKind, StateRef, ConflictCard } from "@carton/core";
import { branchToken, revBody, type CartonRev, type Rev } from "../header.ts";
import type { HeldBase, MaterializerEngine, SaveResult } from "./materializer.ts";

const VIEWS = "views";
/** The ref token core prints (`<cut name>@<seq>~<hash8>`), from a pin's header (`… b:<branch8> p:… by …`). */
const tokenOf = (header: string): string => {
  const m = /^(.+@\d+~[0-9a-f]{8}) b:/.exec(header); // a cut name may hold " b:" itself
  if (m) return m[1]!;
  const i = header.indexOf(" b:");
  return i < 0 ? header : header.slice(0, i);
};
const STATE_TOKEN = /^(.+)@(\d+)~([0-9a-f]{8})$/;
/** The notices row holding a save's cards for its author (`@carton/local` writes.ts `cardsKey`). */
const cardsKey = (author: Actor, change: string) => [actorKey(author), 0, 0, `req:${change}`];
interface PinRecord {
  ref: StateRef;
  expires: number;
}

export interface CartonEngineOptions {
  /** The cut the files show (default: the handle's current cut). */
  cut?: string;
  /**
   * Whether that cut is shared (remote rewrites of the shared file are spaced 30 s apart). Default: read from the cut at
   * each `head()` (its sequencer isn't "local").
   */
  shared?: () => boolean;
  clock?: () => number;
}

/** This engine: every optional method of `MaterializerEngine` is there (the materializer uses one only when it is). */
export type CartonEngine = MaterializerEngine & Required<Pick<MaterializerEngine, "changesSince" | "newChangeId" | "own" | "cut" | "headRef">>;

export function cartonMaterializerEngine(carton: Carton, opts: CartonEngineOptions = {}): CartonEngine {
  const store = carton.store;
  const cut = () => opts.cut ?? carton.cut;
  const now = opts.clock ?? Date.now;
  const getMeta = async <T>(key: readonly string[]): Promise<T | undefined> => store.get<T>(VIEWS, key);
  const putMeta = async (key: readonly string[], value: unknown): Promise<void> => {
    await store.write([{ table: VIEWS, key, value }]);
  };
  const toHeld = (r: { doc: Doc; seq: number; causal: string[] }): HeldBase => ({ baseDoc: r.doc, baseSeq: r.seq, causal: r.causal });
  /**
   * A printed header's state. Core matches `b:` to the cut whose `branchToken` it is (core's one definition, which this
   * package re-exports), so the header goes to core as text, except when several cuts share the token: core ranks the
   * header's cut name above "has the printed state", so a print on a cut renamed since, with a same-token cut now under
   * that name, would be refused "state unknown: re-print" (review 14 #5). Then the cut that has the state is taken here.
   */
  const refOf = async (rev: CartonRev): Promise<StateRef | string> => {
    const m = STATE_TOKEN.exec(rev.ref);
    if (!m || !rev.branch8) return revBody(rev);
    const same = (await carton.cuts()).filter((c) => branchToken(c.id) === rev.branch8);
    if (same.length <= 1) return revBody(rev);
    const on = (id: string): StateRef => ({ branchId: id, seq: Number(m[2]), hash8: m[3]! });
    // two cuts with one token (a hash collision, or ids sharing their first 8 characters): the one that has this state
    // (review 14 #5: a name can be shared or renamed since the print); of several (the same state), the current cut's,
    // then the one with the printed name
    const holding: typeof same = [];
    for (const c of same) {
      try {
        await carton.resolve(on(c.id));
        holding.push(c);
      } catch (e) {
        // not this cut's state; a store failure (busy, locked) is no answer: thrown, so the save is retried, not taken
        // to another cut (round 15 #5)
        if ((e as { code?: string })?.code !== "STATE_UNKNOWN") throw e;
      }
    }
    const pool = holding.length ? holding : same;
    const pick = pool.find((c) => c.id === cut()) ?? pool.find((c) => c.name === m[1]) ?? pool[0]!;
    return on(pick.id);
  };
  /** The records of `doc` that fail the schema's hard validators. */
  const invalidRecords = (doc: Doc): { coll: string; key: string; id: string; error: string }[] => {
    const hard = carton.schema.hard;
    if (!hard) return [];
    const out: { coll: string; key: string; id: string; error: string }[] = [];
    for (const [coll, spec] of Object.entries(carton.schema.collections)) {
      for (const r of (doc[coll] as Record<string, unknown>[] | undefined) ?? []) {
        const errs = hard(coll, r, doc);
        if (errs.length) out.push({ coll, key: spec.key, id: String(r[spec.key]), error: errs.join("; ") });
      }
    }
    return out;
  };
  let isShared = false;
  const pinKey = (r: StateRef) => `${r.branchId}|${r.seq}|${r.hash8 ?? r.hash?.slice(0, 8) ?? ""}`;
  const pinsByOwner = new Map<string, number>();
  /** The author's cards row for a save (`@carton/local`'s `cardsRow`). */
  const cardsRow = (author: Actor, change: string, cards: readonly ConflictCard[]) => {
    const at = now();
    const text = `${cards.length} conflict card${cards.length === 1 ? "" : "s"} on your change ${change}: the other side's value was kept; pick with \`cb resolve\``;
    const value: Notice & { deliveredAt: number } = { to: actorKey(author), kind: "late-conflict", text, change, cards: [...cards], at, deliveredAt: at };
    return { table: "notices", key: cardsKey(author, change), value };
  };

  /** Drops this owner's records whose pin has expired (core has released those pins itself). */
  const prune = async (owner: string): Promise<void> => {
    const t = now();
    const old = (await store.range<PinRecord>(VIEWS, { prefix: ["pinned", owner] })).filter((r) => r.value.expires <= t);
    if (old.length) await store.write(old.map((r) => ({ table: VIEWS, key: r.key, value: undefined })));
  };

  /** One commit of a save: the first with its cards, then with head's side chosen for each. */
  const commitOnce = async ({ doc, base, author, id }: Parameters<MaterializerEngine["commit"]>[0]): Promise<SaveResult> => {
    const b = "baseDoc" in base ? base : base.kind === "carton" ? await refOf(base) : ((await getMeta<string>(["legacy", String(base.rev)])) ?? String(base.rev));
    const withId = id ? { id } : {};
    // the cut is read once, for both commits and the result: a state built on the save belongs to it (round 15 #4)
    const on = cut();
    let r = await carton.commit({ doc, base: b, author, cut: on, ...withId });
    let cards: ConflictCard[] = [];
    let kept = false;
    if (r.status === "conflicts") {
      // cards keep head's value; the save's other edits land. With an id, the cards are recorded first (and kept
      // for the author, B5): a retry that gets the confirmation back by id (no merge, so no cards) still reports
      // them, and never brings back a card resolved meanwhile
      cards = r.cards;
      if (id) {
        await store.write([{ table: VIEWS, key: ["attempt-cards", id], value: cards }, cardsRow(author, id, cards)]);
        kept = true;
      }
      r = await carton.commit({ doc, base: b, author, cut: on, choices: () => "ours", ...withId });
    } else if (id && (r.status === "confirmed" || r.status === "pending")) {
      // a retry answered by id (confirmed, or still pending on a shared cut offline): the cards recorded on the
      // first attempt are still this save's
      cards = (await getMeta<ConflictCard[]>(["attempt-cards", id])) ?? [];
    }
    if (cards.length && !kept && !id && (r.status === "confirmed" || r.status === "pending")) {
      await store.write([cardsRow(author, r.status === "confirmed" ? (r.change?.id ?? `save-${now()}`) : r.id, cards)]);
    } else if (kept && (r.status === "conflicts" || r.status === "rejected")) {
      await store.write([{ table: "notices", key: cardsKey(author, id!), value: undefined }]); // the save didn't land
    }
    // the cut the change is on, as core answers it: a retry answered by id (dedup spans every cut) gets the original
    // confirmation, on the cut the first attempt went to, even if the current cut has changed since (round 16 #1). An
    // answer without a ref (an engine that leaves it out) is on the cut asked for
    const at = (r.status === "confirmed" || r.status === "pending" ? r.ref?.branchId : undefined) ?? on;
    const out = (s: SaveResult): SaveResult => (cards.length ? { ...s, status: "conflicts", cards, cut: at } : { ...s, cut: at });
    switch (r.status) {
      case "confirmed":
        return out({ status: "confirmed", seq: r.seq, ...(r.change ? { id: r.change.id } : {}) });
      case "pending":
        return out({ status: "pending", id: r.id });
      case "conflicts":
        return { status: "rejected", reason: `unresolved cards: ${r.cards.map((c) => c.path).join(", ")}`, cards: r.cards };
      case "rejected":
        return { status: "rejected", reason: r.reason };
    }
  };

  return {
    async head() {
      if (!opts.shared) isShared = (await carton.cuts()).find((c) => c.id === cut())?.sequencer.kind !== "local";
      return (await carton.head(cut())).doc;
    },
    async pin({ owner, cut: at, doc, seq, causal, ttlMs }) {
      // the cut is read once: the pin's store refresh may find a cut another process switched to (review 11 #1)
      const on = at ?? cut();
      const p = await carton.pin({ owner, cut: on, ttlMs, ...(doc ? { doc } : {}), ...(seq !== undefined ? { seq } : {}), ...(causal?.length ? { causal } : {}) });
      const ref: StateRef = { branchId: p.ref.branchId, seq: p.ref.seq, ...(p.ref.hash8 ? { hash8: p.ref.hash8 } : {}) };
      await store.write([{ table: VIEWS, key: ["pinned", owner, pinKey(ref)], value: { ref, expires: now() + ttlMs } satisfies PinRecord }]);
      // now and then, per owner: long-lived owners (the shared file's prints) keep pinning new states
      const n = (pinsByOwner.get(owner) ?? 0) + 1;
      pinsByOwner.set(owner, n);
      if (n % 64 === 0) await prune(owner);
      return { ref: tokenOf(p.header), branchId: p.ref.branchId, seq: p.ref.seq, doc: doc ?? (await carton.checkout(p.ref)), cut: on };
    },
    async release(owner) {
      const rows = await store.range<PinRecord>(VIEWS, { prefix: ["pinned", owner] });
      for (const r of rows) await carton.release(r.value.ref, owner);
      if (rows.length) await store.write(rows.map((r) => ({ table: VIEWS, key: r.key, value: undefined })));
    },
    async resolve(rev: Rev) {
      if (rev.kind === "legacy") {
        const ref = await getMeta<string>(["legacy", String(rev.rev)]);
        if (!ref) throw new StateUnknown(String(rev.rev), "a 1.4.0 timestamp rev from before Carton, of another state");
        return toHeld(await carton.resolve(ref));
      }
      return toHeld(await carton.resolve(await refOf(rev)));
    },
    /**
     * `commitOnce`'s merge cards are kept for the save's author (written before the choosing commit, so a retry never
     * brings back a card resolved meanwhile); the invalid-record cards added here stay out (they can't be put back as the
     * agent wrote them: the sidecar says why).
     */
    async commit(input) {
      let doc = input.doc;
      const invalid: ConflictCard[] = [];
      for (let round = 0; round < 32; round++) {
        const r = await commitOnce({ ...input, doc });
        const refusedInvalid = r.status === "rejected" && /^invalid\b/.test(r.reason ?? "");
        // putting the invalid records back can leave nothing to commit; the sequencer calls that "no ops". The answer
        // names the engine's cut, as `commitOnce`'s do: a state built on this save belongs to it
        if (r.status === "rejected" && r.reason === "no ops" && invalid.length) {
          const c = cut();
          return { status: "conflicts", cards: invalid, seq: (await carton.head(c)).ref.seq, cut: c };
        }
        if (!refusedInvalid) return invalid.length ? { ...r, status: r.status === "rejected" ? r.status : "conflicts", cards: [...invalid, ...(r.cards ?? [])] } : r;
        const bad = invalidRecords(doc);
        if (!bad.length) return r;
        const head = (await carton.head(cut())).doc;
        for (const { coll, key, id, error } of bad) {
          const was = ((head[coll] as Record<string, unknown>[] | undefined) ?? []).find((x) => String(x[key]) === id);
          const recs = (doc[coll] as Record<string, unknown>[] | undefined) ?? [];
          invalid.push({ kind: "invalid", path: `${coll}/${id}`, base: was, ours: was, theirs: recs.find((x) => String(x[key]) === id), reason: error });
          doc = { ...doc, [coll]: was ? recs.map((x) => (String(x[key]) === id ? was : x)) : recs.filter((x) => String(x[key]) !== id) };
        }
      }
      return { status: "rejected", reason: "invalid" };
    },
    async notice(to: Actor, n) {
      // a save's cards are already the author's, with their own notice (B5)
      if (n.kind === "conflicts" && n.change && (await store.get("notices", cardsKey(to, n.change)))) return;
      const kind: NoticeKind = n.kind === "conflicts" ? "late-conflict" : "rejected";
      const at = now();
      const value: Notice = { to: actorKey(to), kind, text: n.text, at, ...(n.change ? { change: n.change } : {}) };
      await store.write([{ table: "notices", key: [value.to, at, 0, Math.random().toString(16).slice(2, 10)], value }]);
    },
    own: (author: Actor) => carton.own(author),
    cut,
    async headRef() {
      // the optimistic head: on a shared cut offline, a commit queues a pending change without moving the seq
      const c = cut();
      const h = await carton.head(c);
      return JSON.stringify([c, h.ref.branchId, h.ref.seq, h.ref.pending ?? []]);
    },
    newChangeId: () => carton.newChangeId(),
    async *changesSince(seq: number, o: { cut?: string; until?: number; skip?: ReadonlySet<string> } = {}) {
      // the whole log back to `seq`, a page at a time (round 15 #1: no window), newest first; only the changes asked for
      // are checked out, and a change right below the last one reuses its state
      const c = o.cut ?? cut();
      const PAGE = 64;
      let page = await carton.log({ cut: c, limit: PAGE });
      let below: { seq: number; doc: Doc } | null = null;
      for (;;) {
        for (const v of page) {
          if (v.ref.seq <= seq) return;
          if (!v.change || (o.until !== undefined && v.ref.seq >= o.until) || o.skip?.has(v.change)) continue;
          const after = below?.seq === v.ref.seq ? below.doc : await carton.checkout({ branchId: c, seq: v.ref.seq });
          const before = await carton.checkout({ branchId: c, seq: v.ref.seq - 1 });
          below = { seq: v.ref.seq - 1, doc: before };
          yield { id: v.change, seq: v.ref.seq, before, after, author: v.author };
        }
        if (page.length < PAGE) return;
        page = await carton.log({ cut: c, limit: PAGE, before: page[page.length - 1]!.ref.seq });
      }
    },
    getMeta,
    putMeta,
    shared: () => opts.shared?.() ?? isShared,
  };
}
