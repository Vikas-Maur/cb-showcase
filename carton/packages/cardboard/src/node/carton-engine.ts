// The materializer's engine over a real `Carton` handle (`@carton/core`) and the Store it was opened on. `@carton/local`
// passes it to `new Materializer(...)` in the lease holder; tests use it on store-memory.
//
// - Pins carry the owner they were made for, and each owner's refs are kept in the local `views` table, one key per
//   ref, so a turn ending (`release(owner)`) releases every pin it took, whichever process made them, and a long-lived
//   owner (the shared file's prints) never rewrites a growing list. Records past their pin's expiry are pruned.
// - A save's cards keep head's value (as the system proof's materializer did): the first commit reports them, then the
//   save is committed with head's side chosen for each card, and the cards go to the materializer (status sidecar,
//   notices, the human's conflict cards).
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
  let pins = 0;

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
    async pin({ owner, doc, seq, ttlMs }) {
      const p = await carton.pin({ owner, cut: cut(), ttlMs, ...(doc ? { doc } : {}), ...(seq !== undefined ? { seq } : {}) });
      const ref: StateRef = { branchId: p.ref.branchId, seq: p.ref.seq, ...(p.ref.hash8 ? { hash8: p.ref.hash8 } : {}) };
      await store.write([{ table: VIEWS, key: ["pinned", owner, pinKey(ref)], value: { ref, expires: now() + ttlMs } satisfies PinRecord }]);
      if (++pins % 64 === 0) await prune(owner); // now and then: long-lived owners keep printing
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
    async commit({ doc, base, author }) {
      const b = "baseDoc" in base ? base : base.kind === "carton" ? revBody(base) : ((await getMeta<string>(["legacy", String(base.rev)])) ?? String(base.rev));
      let r = await carton.commit({ doc, base: b, author, cut: cut() });
      let cards: ConflictCard[] = [];
      if (r.status === "conflicts") {
        // cards keep head's value; the save's other edits land
        cards = r.cards;
        r = await carton.commit({ doc, base: b, author, cut: cut(), choices: () => "ours" });
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
      const kind: NoticeKind = n.kind === "conflicts" ? "late-conflict" : "rejected";
      const at = now();
      const value: Notice = { to: actorKey(to), kind, text: n.text, at, ...(n.change ? { change: n.change } : {}) };
      await store.write([{ table: "notices", key: [value.to, at, 0, Math.random().toString(16).slice(2, 10)], value }]);
    },
    own: (author: Actor) => carton.own(author),
    getMeta,
    putMeta,
    shared: () => opts.shared?.() ?? false,
  };
}
