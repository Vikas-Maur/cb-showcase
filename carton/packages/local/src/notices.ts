// Late-conflict notices for the Stop/SubagentStop hook, read straight from carton.db's local `notices` table
// (`[actorKey, at, n]` → Notice, core's layout), so host Claude Code's hook, a fresh process per event, remembers that
// it already blocked once for a conflict set (§6.2, R3-09). The state lives on the notice itself:
//   blockedAt      a Stop hook blocked on it (the agent got its one chance);
//   handedToHuman  the agent stopped without resolving it: it is now a card for the person, under `@human`.
// Codex and Gemini have no Stop hook (L1): their notices simply come back at the start of their next `cb` result.
import type { Actor, Notice } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import type { ConflictNotice, NoticeBox } from "./hooks.ts";
import { actorKey, casUpdate, SKIP } from "./writes.ts";
import { parseActorId } from "./identity.ts";

const TABLE = "notices";
/** Where cards for the person live: the app's conflict-card list reads this prefix. */
export const HUMAN_CARDS = "@human";

type Row = Notice & { blockedAt?: number; handedToHuman?: number };
const isConflict = (n: Row) => n.kind === "late-conflict" || n.kind === "rejected";
const idOf = (key: readonly (string | number)[]) => JSON.stringify(key);

/** A NoticeBox over a Store. `actorId` arguments are actor ids as hooks compute them; `keyOf` maps them to core's key. */
export class StoreNoticeBox implements NoticeBox {
  private store: Store;
  private keyOf: (actorId: string) => string;
  private now: () => number;
  onEndTurn?: (actorId: string) => void;

  constructor(store: Store, opts: { keyOf?: (actorId: string) => string; now?: () => number; onEndTurn?: (actorId: string) => void } = {}) {
    this.store = store;
    // hooks know an actor by id; core keys notices by `kind/id[/agentId]`, which the id determines
    this.keyOf = opts.keyOf ?? ((id) => actorKey(parseActorId(id) ?? ({ kind: "agent", id } as Actor)));
    this.now = opts.now ?? Date.now;
    this.onEndTurn = opts.onEndTurn;
  }

  private async rows(actorId: string) {
    return this.store.range<Row>(TABLE, { prefix: [this.keyOf(actorId)] });
  }
  private toNotice = ({ key, value }: { key: readonly (string | number)[]; value: Row }): ConflictNotice =>
    ({ id: idOf(key), changeId: value.change ?? "", text: value.text, cards: value.cards });

  // The NoticeBox interface is synchronous (Cardboard's in-process hook can't await between its steps); these async
  // forms are what the hook CLI uses, and `snapshot` gives the synchronous box for one hook call.
  async freshAsync(actorId: string): Promise<ConflictNotice[]> {
    return (await this.rows(actorId)).filter((r) => isConflict(r.value) && !r.value.blockedAt && !r.value.handedToHuman).map(this.toNotice);
  }
  async blockedAsync(actorId: string): Promise<ConflictNotice[]> {
    return (await this.rows(actorId)).filter((r) => r.value.blockedAt && !r.value.handedToHuman).map(this.toNotice);
  }
  // Each update is conditional on the row as read (casUpdate): a card resolved meanwhile, or a delivery mark, is
  // never written back over.
  async markBlockedAsync(actorId: string, ids: string[]): Promise<void> {
    const at = this.now();
    for (const r of await this.rows(actorId)) {
      if (ids.includes(idOf(r.key))) await casUpdate<Row>(this.store, TABLE, r.key, (cur) => (cur.blockedAt ? SKIP : { ...cur, blockedAt: at }), r.value);
    }
  }
  async handToHumanAsync(actorId: string, ids: string[]): Promise<void> {
    const at = this.now();
    let n = 0;
    for (const r of await this.rows(actorId)) {
      if (!ids.includes(idOf(r.key))) continue;
      let card: Row | null = null;
      const ok = await casUpdate<Row>(this.store, TABLE, r.key, (cur) => (cur.handedToHuman || !cur.cards?.length ? SKIP : ((card = cur), { ...cur, handedToHuman: at })), r.value);
      // the person's copy holds the cards as they were when handed over (after any the agent resolved)
      if (ok && card) await this.store.write([{ table: TABLE, key: [HUMAN_CARDS, at, n++, Math.random().toString(16).slice(2, 10)], value: { ...(card as Row), to: HUMAN_CARDS, handedToHuman: at, from: actorId } }]);
    }
  }

  /** Load one actor's notices, run a synchronous hook decision against them, then write what it changed. */
  async run<T>(actorId: string, fn: (box: NoticeBox) => T): Promise<T> {
    const fresh = await this.freshAsync(actorId), blocked = await this.blockedAsync(actorId);
    const ops: (() => Promise<void>)[] = [];
    const box: NoticeBox = {
      freshConflicts: () => fresh,
      blocked: () => blocked,
      markBlocked: (a, ids) => void ops.push(() => this.markBlockedAsync(a, ids)),
      handToHuman: (a, ids) => void ops.push(() => this.handToHumanAsync(a, ids)),
      endTurn: (a) => this.onEndTurn?.(a),
    };
    const r = fn(box);
    for (const op of ops) await op();
    return r;
  }

  // synchronous NoticeBox methods are only valid inside `run`
  freshConflicts(): ConflictNotice[] { throw new Error("use StoreNoticeBox.run()"); }
  blocked(): ConflictNotice[] { throw new Error("use StoreNoticeBox.run()"); }
  markBlocked(): void { throw new Error("use StoreNoticeBox.run()"); }
  handToHuman(): void { throw new Error("use StoreNoticeBox.run()"); }
}

/** Cards handed to the person (newest last): what the app's conflict-card list shows. */
export async function humanCards(store: Store): Promise<(Notice & { from?: string })[]> {
  return (await store.range<Notice & { from?: string }>(TABLE, { prefix: [HUMAN_CARDS] })).map((r) => r.value);
}
