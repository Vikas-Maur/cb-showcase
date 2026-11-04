// The person's side of an agent's conflict cards (PLAN §6.2 R3-09, §7), for the History panels the library worker
// serves (carton-node.js, the `ui` service). An agent edits its own view (`.scratch/views/<name>.tsx`) while the person
// edits in the editor. When the agent's save clashes with the person's edit, the adapter's engine keeps head's value
// (the person's) and keeps the agent's side as cards for the agent: a notice row (B5) that `cb conflicts`,
// `cb resolve`, the Stop hook and the view's `.status` sidecar read. The Materializer also hands the cards to the
// worker (`onCards`). This file shows them to the person and keeps both sides in step.
//
// - Where they live: one row per carded save in carton.db's local `notices` table, under `@human` (where
//   `@carton/local` hands over the cards an agent leaves unresolved at its Stop hook, `humanCards()`), keyed
//   `[@human, at, 0, "save:<batch>"]`. A row of its own, not a pointer to the agent's: the Director's in-process Stop
//   hook takes (deletes) the agent's notices at the end of its turn, and the person's card must outlive that.
// - How they read: the engine's card is merge3(base, head, agent), so `ours` is the person's value (at head) and
//   `theirs` the agent's. fromCarton is built for the person's own cards, the other way round (`theirs` is "mine", and
//   "Keep yours" commits it). Reported as they are, the agent's value would be labelled "yours" and "Keep yours" would
//   commit it. So the cards are reported with the agent as the other side (`by`), the facade presents them turned
//   round (`present`), and maps the person's choice back (`resolve`):
//     Keep yours                   head keeps the person's value: no commit.
//     Keep <agent>'s               commits the agent's value, authored by the person who chose it: History says you
//                                  made it, and Ctrl+Z (the person's undo group) takes it back.
// - One card, two sides: a decision on either side closes it on both.
//   - The person decides in History: the same card (path and both values) goes from every `@human` row and from the
//     agent's notices. It would mislead there: `cb resolve --keep mine` would undo the person's explicit choice, and
//     the Stop hook would hold the agent's turn for a question already answered.
//   - The agent decides first (`cb resolve` closes its card): the person's copy is no longer shown, and goes. A panel
//     opened later reads only cards still open on the agent's side. An open panel re-reads them 0.3 s and 2 s after a
//     change lands in this process (`--keep mine` is one); `--keep theirs` commits nothing and leaves head as the card
//     says, so there the card stays true until the next change or read. A pick made before then still holds: "Keep
//     yours" puts the person's value back (no version when it is still there) and "Keep <agent>'s" commits the agent's.
//   - The agent's turn ends: what it left unresolved becomes the person's (R3-09). The facade's `notices` service is
//     how the Director's Stop hook takes its notices; just before, `detach` marks the person's copies of that agent's
//     cards that are still open as handed over, so they no longer depend on the agent's rows. `@carton/local`'s
//     hand-over (host Claude Code's Stop hook) keeps the agent's row and copies it under `@human`: those copies are
//     shown too (identical cards show once).
//   - The view's `.status` sidecar is the record of that save's result (the Materializer's file): it keeps listing the
//     card until the view is saved again. `cb conflicts` is the live list.
// - A card belongs to the cut the save landed on (`cut` on the person's row): History shows it only on that cut, and a
//   pick commits there, whichever cut is current when it is made (review H8 r1 #2: shown on another cut, "Keep the
//   agent's" changed that cut and left the clash on its own).
// - Identical cards from two agents show once; a pick closes the card for every agent that has it (review H8 r1 #4: only
//   the agent named on the shown copy lost it, and the other's Stop hook would still hold its turn for it).
import { apply } from "@carton/core";
import { casUpdate, SKIP, HUMAN_CARDS } from "@carton/local";
import { cardOps } from "@carton/react";

const TABLE = "notices";
// As fromCarton tells cards apart: keys in order, and a missing value is not null.
export const canon = (v) => (v === undefined ? "undefined" : JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x)));
export const sameCard = (a, b) => a.path === b.path && canon(a.ours) === canon(b.ours) && canon(a.theirs) === canon(b.theirs);

// A card shown for an agent carries the agent's notice key: fromCarton keeps a host's fields on a card (cardFor
// returns them), so a pick on it is known for an agent's.
const AGENT = "cartonAgent", CUT = "cartonCut";
const plain = (card) => {
  const { [AGENT]: _k, [CUT]: _c, ...c } = card;
  return c;
};
const handed = (v) => !!(v.handedAt || v.handedToHuman);

/**
 * The person's side of agents' cards. `actorOf(id)` and `keyOf(actor)` as the facade has them (`keyOf`: core's notice
 * key, `kind/id[/agentId]`); `me`: the person.
 */
/**
 * The cut a change is on, by its id: confirmed (core's `ids` table: `[cut, seq]`), an id spent without a change (a
 * save whose every edit was carded: `meta` `["noop", id]` → `[cut, seq]`), or still waiting to sync (`pending`, keyed
 * by its cut). null when the store has none of them (a save that didn't land).
 */
export async function cutOfChange(store, id) {
  if (!id) return null;
  try {
    for (const at of [await store.get("ids", [id]), await store.get("meta", ["noop", id])])
      if (Array.isArray(at) && typeof at[0] === "string") return at[0];
    for (const r of await store.range("pending")) if (r.value?.id === id) return String(r.key[0]);
  } catch {}
  return null;
}

export function viewCards({ actorOf, keyOf, me, now = Date.now }) {
  // The cards still open on an agent's side: its notice rows (the engine's B5 row, cb's), resolved ones already gone.
  const openFor = async (store, key) => (await store.range(TABLE, { prefix: [key] })).flatMap((r) => r.value?.cards ?? []);
  const rows = async (store) => (await store.range(TABLE, { prefix: [HUMAN_CARDS] })).filter((r) => r.value?.cards?.length);
  // A row's agent: ours keep the Actor; a hand-over copy from @carton/local has its actor id in `from` (its `by`, if
  // any, is core's: the other side's author).
  const agentOf = (v) => v.agent ?? actorOf(v.from);
  const isAgent = (card) => typeof card?.[AGENT] === "string";

  /**
   * The cards the person's panel shows now: [{by, cards}], each card marked as an agent's. A card the agent decided
   * (closed on its side while the person's copy wasn't handed over) goes from the person's row here, for good. The
   * person's rows are read before the agent's: a save's agent row is written before its person's row, so a new card is
   * never taken for a decided one.
   */
  async function shown(lc) {
    const out = [], open = new Map(), here = lc.carton.cut;
    for (const { key: rowKey, value: v } of await rows(lc.store)) {
      // another cut's card waits there (a row without a cut: @carton/local's hand-over copy, or one kept before cuts
      // were recorded, shows as before)
      if (v.cut && v.cut !== here) continue;
      const by = agentOf(v), key = v.agentKey ?? keyOf(by);
      let cards = v.cards;
      if (!handed(v)) {
        if (!open.has(key)) open.set(key, await openFor(lc.store, key));
        const isOpen = (c) => open.get(key).some((o) => sameCard(o, c));
        cards = cards.filter(isOpen);
        if (cards.length < v.cards.length)
          await casUpdate(lc.store, TABLE, rowKey, (cur) => {
            if (!cur || handed(cur)) return SKIP;
            const left = (cur.cards ?? []).filter(isOpen);
            return left.length === cur.cards?.length ? SKIP : left.length ? { ...cur, cards: left } : undefined;
          }, v);
      }
      if (cards.length) out.push({ by, cards: cards.map((c) => ({ ...c, [AGENT]: key, [CUT]: v.cut ?? here })) });
    }
    return out;
  }

  /**
   * The card is gone on both sides: from the person's rows on its cut, and from the notices of every agent behind them
   * (identical cards from two agents show as one).
   */
  async function close(lc, card, agentKey, cut = null) {
    const has = (v) => v?.cards?.some((c) => sameCard(c, card));
    const onCut = (v) => !cut || !v.cut || v.cut === cut;
    const drop = (cur) => {
      if (!has(cur)) return SKIP;
      const cards = cur.cards.filter((c) => !sameCard(c, card));
      return cards.length ? { ...cur, cards } : undefined;
    };
    const all = (await rows(lc.store)).filter((r) => has(r.value));
    const people = all.filter((r) => onCut(r.value));
    const agents = new Set([agentKey, ...people.map((r) => r.value.agentKey ?? keyOf(agentOf(r.value)))]);
    // An agent's notice holds the card for the save it came from (keyed by its change): one known to be on another cut
    // stays open there (review H8 r2 #4: the same agent's identical card on another cut). A notice behind one of these
    // person rows is on this cut; any other by its change's cut; one whose cut can't be told closes, as before.
    const saves = (list) => new Set(list.flatMap((r) => [r.value.change, r.value.batch, r.value.request].filter(Boolean)));
    const behind = saves(people), elsewhere = saves(all.filter((r) => cut && r.value.cut && r.value.cut !== cut));
    const onThisCut = async (v) => {
      if (!cut) return true;
      if (v.cut) return v.cut === cut;
      if (!v.change || behind.has(v.change)) return true;
      if (elsewhere.has(v.change)) return false; // behind the person's copy on another cut (review H8 r3 #4)
      const at = await cutOfChange(lc.store, v.change);
      return at === null || at === cut;
    };
    for (const r of people) await casUpdate(lc.store, TABLE, r.key, drop, r.value);
    for (const key of agents)
      for (const r of await lc.store.range(TABLE, { prefix: [key] })) if (has(r.value) && (await onThisCut(r.value))) await casUpdate(lc.store, TABLE, r.key, drop, r.value);
  }

  // Each panel's own resolve (fromCarton's, before the facade wraps it): it can drop a card without committing.
  const raws = new WeakMap();
  const watching = new WeakSet();

  return {
    isAgent,
    shown,
    close,

    /**
     * An agent's carded save, from the Materializer's `onCards`: kept for the person and returned to show now
     * ({by, cards}). A person's own (a hand edit of a view) are already theirs (the engine kept them for their key, the
     * facade reports those): returned plain, kept nowhere else.
     */
    async keep(lc, c) {
      const actor = c.actor;
      if (!actor || actor.id === me.id) return { by: undefined, cards: c.cards, person: true };
      const agentKey = keyOf(actor), at = typeof c.at === "number" ? c.at : now(), n = c.cards.length;
      const text = `${n} of ${actor.name ?? actor.id}'s edits in ${c.file ?? "a view"} clashed with yours; yours was kept. Choose in History.`;
      const value = { to: HUMAN_CARDS, kind: "late-conflict", text, cards: [...c.cards], at, from: actor.id, agent: actor, agentKey, cut: c.cut ?? lc.carton.cut, file: c.file ?? null, batch: c.batch ?? null, ...(c.change ? { change: c.change } : {}), ...(c.request ? { request: c.request } : {}) };
      await lc.store.write([{ table: TABLE, key: [HUMAN_CARDS, at, 0, "save:" + (c.batch ?? at)], value }]);
      return { by: actor, cards: c.cards.map((x) => ({ ...x, [AGENT]: agentKey, [CUT]: value.cut })) };
    },

    /** The agent's turn ends (its notices are about to be taken): its open cards stay the person's. */
    async detach(lc, actor) {
      const key = keyOf(actor);
      const mine = (await rows(lc.store)).filter((r) => !handed(r.value) && r.value.agentKey === key);
      if (!mine.length) return;
      const open = await openFor(lc.store, key);
      for (const r of mine)
        await casUpdate(lc.store, TABLE, r.key, (cur) => {
          if (!cur || handed(cur)) return SKIP;
          const cards = (cur.cards ?? []).filter((c) => open.some((o) => sameCard(o, c)));
          return cards.length ? { ...cur, cards, handedAt: now() } : undefined;
        }, r.value);
    },

    /**
     * Before the facade wraps a new panel's methods: its conflicts topic shows agents' cards the person's way round
     * (the person's value as "yours", showing now; the agent's as the agent's), and a change landing re-checks them.
     * `panelsNow()`: the project's open panels (fromCarton handles).
     */
    present(ui, handle, lc, panelsNow) {
      raws.set(handle, ui.resolve);
      const base = ui.conflicts, turned = new WeakMap();
      // What a side says (its summary, and its change sentence, verb and noun: docs/carton-ux PLAN 7.1) goes round with
      // its value; the author and time stay where they are (review of feat/ux-7-conflicts #1: only the summary went
      // round, so "Yours" read the agent's sentence and "Keep Claude Code's" kept the value shown under "Yours").
      const said = ({ summary, text, did, what }) => ({ summary, ...(text !== undefined ? { text } : {}), ...(did !== undefined ? { did } : {}), ...(what !== undefined ? { what } : {}) });
      const unsaid = ({ summary: _s, text: _t, did: _d, what: _w, ...rest }) => rest;
      let lastIn = null, lastOut = null;
      // Stable identities: the same list and the same cards give the same objects (hooks compare by identity).
      ui.conflicts = () => {
        const list = base.call(ui);
        if (list === lastIn) return lastOut;
        lastIn = list;
        lastOut = list.map((c) => {
          if (!isAgent(handle.cardFor(c.id))) return c;
          let t = turned.get(c);
          if (!t) turned.set(c, (t = { ...c, mine: { ...unsaid(c.mine), ...said(c.theirs) }, theirs: { ...unsaid(c.theirs), ...said(c.mine) }, provisional: "mine" }));
          return t;
        });
        return lastOut;
      };
      // "Preview" of a side (UI audit P1-6): fromCarton's conflictRef reads its own sides, which are turned round here.
      // Its "theirs" is head (the person's value, shown now) and its "mine" the card's `theirs` (the agent's), so
      // Preview of the agent's side showed the person's timeline and yours the agent's. A side asked for here is
      // mapped back, as `resolve` maps a pick.
      const baseRef = ui.conflictRef;
      if (typeof baseRef === "function")
        ui.conflictRef = (id, side) => baseRef.call(ui, id, isAgent(handle.cardFor(id)) && side !== "both" ? (side === "mine" ? "theirs" : "mine") : side);
      if (watching.has(lc)) return;
      watching.add(lc);
      // An agent's `cb resolve --keep mine` is a commit: once its card is closed too (a moment later, cb's next call),
      // the person's copy goes. Read only while a panel shows an agent's card.
      const timers = new Map();
      const recheck = async () => {
        const live = [...panelsNow()].map((h) => [h, h.conflicts().filter((c) => isAgent(h.cardFor(c.id)))]).filter(([, l]) => l.length);
        if (!live.length) return;
        const still = (await shown(lc)).flatMap((x) => x.cards);
        for (const [h, list] of live)
          for (const c of list) {
            const card = h.cardFor(c.id);
            if (card && !still.some((s) => sameCard(s, card))) await raws.get(h)?.(c.id, "theirs");
          }
      };
      const later = (ms) => {
        clearTimeout(timers.get(ms));
        const t = setTimeout(() => recheck().catch((e) => console.warn("[carton] couldn't re-check an agent's conflict cards: " + ((e && e.message) || e))), ms);
        t.unref?.();
        timers.set(ms, t);
      };
      lc.carton.on((e) => {
        if (e.type === "change") later(300), later(2000);
      });
    },

    /**
     * The person picked on an agent's card ("mine": keep the person's value, "theirs": take the agent's). Returns false
     * when the card isn't an agent's (the facade's own path then), else `{ answer }`: the panel's answer to the pick, with
     * the version it made (`made`, UX redesign PLAN 5.3: its toast's Undo takes back exactly that), or none when the
     * value was there already.
     */
    async resolve(lc, handle, id, choice) {
      const card = handle.cardFor(id);
      if (!isAgent(card)) return false;
      if (choice === "both") throw new Error("Keep both isn't offered for this card");
      const raw = raws.get(handle), agentKey = card[AGENT], cut = card[CUT] ?? lc.carton.cut, c = plain(card);
      if (!raw) throw new Error("This card's panel isn't set up for agents' cards");
      // A side's value, committed by the person who chose it, as a document: when it is there already core finds nothing
      // to change and History gets no version (ops setting a field to the value it has would make one). A clash with a
      // change made since (a moment's window) comes back as the person's own card.
      let made = null;
      const take = async (value) => {
        const head = await lc.carton.head(cut);
        const r = await lc.carton.commit({ cut, doc: apply(structuredClone(head.doc), cardOps(c, value), lc.carton.schema), base: head.ref, author: me });
        if (r.status === "rejected") throw new Error(r.reason);
        if (r.status === "conflicts") handle.reportConflicts(r.cards);
        const changeId = r.status === "confirmed" ? (!r.empty && r.change?.id) || null : r.status === "pending" ? r.id : null;
        if (changeId) made = { cut, changes: [changeId] };
      };
      if (choice === "theirs") await take(c.theirs);
      else {
        // Keep yours. While nobody has decided the card (still open on the agent's side, or handed over to the person),
        // head has the person's value: nothing to commit. Once someone has (the agent with cb resolve, or another panel,
        // before this one re-read), this pick is the latest: the person's value is put back. (The person's copy of a
        // card the agent decided may already be gone: `shown` prunes it.)
        const same = (x) => sameCard(x, c);
        const people = (await rows(lc.store)).filter((r) => (!r.value.cut || r.value.cut === cut) && r.value.cards.some(same));
        const agents = new Set([agentKey, ...people.map((r) => r.value.agentKey ?? keyOf(agentOf(r.value)))]);
        let open = people.some((r) => handed(r.value));
        for (const key of agents) open ||= (await openFor(lc.store, key)).some(same);
        if (!open) await take(c.ours);
      }
      // fromCarton's own resolve with its "theirs" (the side on screen) drops the card from this panel and commits nothing
      await raw(id, "theirs");
      await close(lc, c, agentKey, cut);
      return { answer: made ? { made } : {} };
    },
  };
}
