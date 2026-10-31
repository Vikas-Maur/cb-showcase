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
import { StateUnknown, actorKey } from "@carton/core";
import type { Actor, Carton, Doc, Notice, NoticeKind, StateRef, ConflictCard } from "@carton/core";
import { revBody, type Rev } from "../header.ts";
import type { HeldBase, MaterializerEngine, SaveResult } from "./materializer.ts";

const VIEWS = "views";
/** The ref token core prints (`<cut name>@<seq>~<hash8>`), from a pin's header (`… b:<branch8> p:… by …`). */
const tokenOf = (header: string): string => {
  const i = header.indexOf(" b:");
  return i < 0 ? header : header.slice(0, i);
};
/** The notices row holding a save's cards for its author (`@carton/local` writes.ts `cardsKey`). */
const cardsKey = (author: Actor, change: string) => [actorKey(author), 0, 0, `req:${change}`];
interface PinRecord {
  ref: StateRef;
  expires: number;
}

export interface CartonEngineOptions {
  /** The cut the files show (default: the handle's current cut). */
  cut?: string;
  /** Whether that cut is shared (remote rewrites of the shared file are spaced 30 s apart). */
  shared?: () => boolean;
  clock?: () => number;
}

export function cartonMaterializerEngine(carton: Carton, opts: CartonEngineOptions = {}): MaterializerEngine {
  const store = carton.store;
  const cut = () => opts.cut ?? carton.cut;
  const now = opts.clock ?? Date.now;
  const getMeta = async <T>(key: readonly string[]): Promise<T | undefined> => store.get<T>(VIEWS, key);
  const putMeta = async (key: readonly string[], value: unknown): Promise<void> => {
    await store.write([{ table: VIEWS, key, value }]);
  };
  const toHeld = (r: { doc: Doc; seq: number; causal: string[] }): HeldBase => ({ baseDoc: r.doc, baseSeq: r.seq, causal: r.causal });
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

  return {
    async head() {
      return (await carton.head(cut())).doc;
    },
    async pin({ owner, doc, seq, causal, ttlMs }) {
      const p = await carton.pin({ owner, cut: cut(), ttlMs, ...(doc ? { doc } : {}), ...(seq !== undefined ? { seq } : {}), ...(causal?.length ? { causal } : {}) });
      const ref: StateRef = { branchId: p.ref.branchId, seq: p.ref.seq, ...(p.ref.hash8 ? { hash8: p.ref.hash8 } : {}) };
      await store.write([{ table: VIEWS, key: ["pinned", owner, pinKey(ref)], value: { ref, expires: now() + ttlMs } satisfies PinRecord }]);
      // now and then, per owner: long-lived owners (the shared file's prints) keep pinning new states
      const n = (pinsByOwner.get(owner) ?? 0) + 1;
      pinsByOwner.set(owner, n);
      if (n % 64 === 0) await prune(owner);
      return { ref: tokenOf(p.header), branchId: p.ref.branchId, seq: p.ref.seq, doc: doc ?? (await carton.checkout(p.ref)) };
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
      return toHeld(await carton.resolve(revBody(rev)));
    },
    async commit({ doc, base, author, id }) {
      const b = "baseDoc" in base ? base : base.kind === "carton" ? revBody(base) : ((await getMeta<string>(["legacy", String(base.rev)])) ?? String(base.rev));
      const withId = id ? { id } : {};
      let r = await carton.commit({ doc, base: b, author, cut: cut(), ...withId });
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
        r = await carton.commit({ doc, base: b, author, cut: cut(), choices: () => "ours", ...withId });
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
      const out = (s: SaveResult): SaveResult => (cards.length ? { ...s, status: "conflicts", cards } : s);
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
      const c = cut();
      const h = await carton.head(c);
      return JSON.stringify([c, h.ref.branchId, h.ref.seq]);
    },
    newChangeId: () => carton.newChangeId(),
    getMeta,
    putMeta,
    shared: () => opts.shared?.() ?? false,
  };
}
