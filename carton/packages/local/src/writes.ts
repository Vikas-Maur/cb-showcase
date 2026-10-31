// The writes a `cb` or MCP process hands to the lease holder (`carton.commit`), and how the holder runs them on its
// Carton handle (§6.2, R2-02). Every write returns the `cb` result contract:
//   {status: "confirmed", seq, ref} | {status: "pending", id, ref} | {status: "conflicts", conflicts, ref}
//   | {status: "rejected", reason}, with the actor's notices (late conflicts) first.
// On a shared cut the holder waits up to 5 s for the server's answer (L14); offline it answers `pending` at once.
//
// A save whose merge raises cards is committed with head's value kept for each card (the rest lands, nothing is lost),
// as `cb source apply` did in the verified prototype; the cards are kept as a notice for the actor, so `cb conflicts`
// lists them and `cb resolve` can pick the other side later. Notices are marked delivered when a result carries them,
// never deleted until resolved or handed to the person (the Stop hook and `cb resolve` still need them).
import { merge3 } from "@carton/core";
import type { Actor, Carton, CartonEvent, ChangeId, CommitResult, ConfirmedChange, ConflictCard, Doc, Notice, PathKey, StateRef } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { hookDelivered, isFallbackActor } from "./identity.ts";

/** The JSON a write carries over the control socket. Docs and ops are plain JSON. */
export type WriteOp =
  /** `base`: the version the edit was made on, as Carton gave it: a StateRef, or a printed header (default: head). */
  | { kind: "commit"; cut?: string; base?: string | StateRef; doc?: unknown; ops?: unknown[]; intent?: unknown; kinds?: unknown; policy?: "merge" | "lww"; name?: string }
  | { kind: "fold"; from: string; into?: string; check?: boolean; reject?: PathKey[]; missingBase?: "dialog" | "all-cards"; keep?: "mine" | "theirs" }
  | { kind: "restore"; ref: string; cut?: string }
  | { kind: "revert"; changeId: ChangeId; cut?: string }
  | { kind: "undo"; group?: string; cut?: string }
  | { kind: "undoTurn"; turn: string; cut?: string }
  | { kind: "fork"; name: string; from?: string; cutKind?: string }
  | { kind: "switch"; cut: string }
  | { kind: "name"; ref: string; name: string }
  | { kind: "pin"; owner: string; cut?: string; ttlMs?: number }
  /** `cb source print --view [name]`: the materializer prints a per-agent view (§6.4); needs a holder that runs one. */
  | { kind: "printView"; name?: string }
  /** Share a cut (§5.3): the holder hands it from the local sequencer to the server (local → handing off → server). */
  | { kind: "share"; cut?: string }
  /** `cb resolve` closed a card: drop it from the actor's late-conflict notices. */
  | { kind: "closeCard"; change: ChangeId | null; path: PathKey };

export interface WriteRequest {
  /** Stable change id made by the calling process (`<rid>.<n>`): a retried call never makes a second change. */
  id: ChangeId;
  actor: Actor;
  op: WriteOp;
  /** How long to wait for the server's answer on a shared cut (default 5000). */
  waitMs?: number;
}

export type CbResult =
  | { status: "confirmed"; id?: ChangeId; seq: number; ref: string | null; notices: Notice[]; empty?: boolean; [k: string]: unknown }
  | { status: "pending"; id: ChangeId; ref: string | null; notices: Notice[]; online: boolean; [k: string]: unknown }
  | { status: "conflicts"; id?: ChangeId; conflicts: ConflictCard[]; ref: string | null; notices: Notice[]; [k: string]: unknown }
  | { status: "rejected"; id?: ChangeId; reason: string; notices: Notice[]; [k: string]: unknown }
  | { status: "error"; error: string; notices: Notice[]; [k: string]: unknown };

export const WAIT_MS = 5000;

/**
 * Writes that are safe to run twice with the same request: every write is deduplicated by its request id in core (a
 * commit, fold, restore, revert, undo or new cut retried under the same id gets the first answer, never a second
 * change), `undoTurn` commits under it, and the rest change nothing on a second run. So a holder that died after
 * receiving a write is simply asked again. (`submit`'s `idempotent: false` path stays for any future write without an
 * id; none uses it now.)
 */
export const IDEMPOTENT: ReadonlySet<WriteOp["kind"]> = new Set(["commit", "fold", "restore", "revert", "undo", "undoTurn", "fork", "switch", "name", "pin", "printView", "closeCard", "share"]);

/**
 * Run an idempotent write again when Carton lost its append race too many times in a row (many writers on one
 * carton.db: core retries 5 times, then gives up). Safe because the write is deduplicated by its id; a jittered backoff
 * lets the other writers through. Non-idempotent writes are never retried here.
 */
export async function withRaceRetry<T>(idempotent: boolean, fn: () => Promise<T>, tries = 8): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (!idempotent || i >= tries || !/store changed under this write/.test(String(e?.message))) throw e;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * i));
    }
  }
}

/** The cut a write changes (undefined: the current cut, or none). Routing needs it: a shared cut needs the pusher. */
export function destCut(op: WriteOp): string | undefined {
  switch (op.kind) {
    case "fold": return op.into;
    case "commit": case "restore": case "revert": case "undo": case "undoTurn": case "pin": case "share": return op.cut;
    default: return undefined;
  }
}

const refText = (r: StateRef | null | undefined): string | null => {
  if (!r) return null;
  return `${r.branchId.slice(0, 8)}@${r.seq}${r.hash8 ? `~${r.hash8}` : ""}`;
};

export const ALREADY_IN_PLACE = "already in place: an identical edit was already there, so this one changed nothing of its own";
export const TOO_LARGE = "this edit is larger than the server accepts (its maximum message size), so it wasn't saved; the edits after it still went through. Split it into smaller edits.";

/** A rejection as the cb result: "too large" (refused by the client before sending) explained for the one edit. */
export function rejectedResult(id: ChangeId | undefined, reason: string, notices: Notice[]): CbResult {
  return { status: "rejected", ...(id ? { id } : {}), reason, notices, ...(reason === "too large" ? { note: TOO_LARGE } : {}) };
}

/** Turn a core CommitResult into the cb result contract. */
export function toCbResult(r: CommitResult | Record<string, any>, notices: Notice[], extra: Record<string, unknown> = {}): CbResult {
  const x = r as any;
  switch (x.status) {
    case "confirmed": return { status: "confirmed", seq: x.seq, ref: refText(x.ref), notices, ...(x.empty ? { empty: true } : {}), ...(x.change?.id ? { id: x.change.id } : {}), ...extra };
    case "pending": return { status: "pending", id: x.id, ref: refText(x.ref), notices, online: false, ...extra };
    case "conflicts": return { status: "conflicts", conflicts: x.cards ?? [], ref: refText(x.ref), notices, ...extra };
    case "rejected": return { ...rejectedResult(undefined, x.reason ?? x.invalid?.error ?? "rejected", notices), ...extra } as CbResult;
    default: return { status: "confirmed", seq: x.seq ?? 0, ref: refText(x.ref), notices, ...x, ...extra } as CbResult;
  }
}

type Outcome = { kind: "confirmed"; seq: number } | { kind: "notice"; notice: Notice };

/**
 * Collects pending changes' outcomes from the moment it is created (confirmed by the server, a late conflict, a
 * rejection), so an answer that arrives while the commit itself is still running isn't missed.
 */
export function watchOutcomes(carton: Carton): { wait(id: ChangeId, ms: number): Promise<Outcome | null>; close(): void } {
  const seen = new Map<ChangeId, Outcome>();
  const waiting = new Map<ChangeId, (o: Outcome) => void>();
  const off = carton.on((e: CartonEvent) => {
    let id: ChangeId | undefined, o: Outcome | undefined;
    if (e.type === "change" && e.change.id) { id = e.change.id; o = { kind: "confirmed", seq: e.seq }; }
    else if (e.type === "notice" && e.notice.change && (e.notice.kind === "late-conflict" || e.notice.kind === "rejected")) { id = e.notice.change; o = { kind: "notice", notice: e.notice }; }
    if (!id || !o) return;
    const w = waiting.get(id);
    if (w) { waiting.delete(id); w(o); } else if (!seen.has(id)) seen.set(id, o);
  });
  return {
    wait(id, ms) {
      const hit = seen.get(id);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const t = setTimeout(() => { waiting.delete(id); resolve(null); }, ms);
        t.unref?.();
        waiting.set(id, (o) => { clearTimeout(t); resolve(o); });
      });
    },
    close: off,
  };
}

/** Wait for one pending change's outcome (subscribing now: prefer `watchOutcomes` before the commit). */
export function waitOutcome(carton: Carton, id: ChangeId, ms: number): Promise<Outcome | null> {
  const w = watchOutcomes(carton);
  return w.wait(id, ms).finally(() => w.close());
}

const storeOf = (carton: Carton): Store | undefined => (carton as unknown as { store?: Store }).store;
type NoticeRow = Notice & { deliveredAt?: number; handedToHuman?: number; blockedAt?: number };

/**
 * The actor's notices not delivered yet, marked delivered (not deleted: an unresolved card stays for `cb conflicts`,
 * `cb resolve` and the Stop hook). Returned at the start of the actor's next result (§6.2).
 */
export async function deliverNotices(carton: Carton, actor: Actor): Promise<Notice[]> {
  const store = storeOf(carton);
  if (!store) return carton.notices(actor, { take: false });
  const rows = (await store.range<NoticeRow>("notices", { prefix: [actorKey(actor)] })).filter((r) => !r.value.deliveredAt && !r.value.handedToHuman);
  const at = Date.now();
  const out: Notice[] = [];
  for (const r of rows) {
    // conditional on the row as read: a card resolved (or a hook's mark written) meanwhile is never undone
    let delivered: NoticeRow | null = null;
    const ok = await casUpdate(store, "notices", r.key, (cur: NoticeRow) => (cur.deliveredAt || cur.handedToHuman ? SKIP : (delivered = { ...cur, deliveredAt: at })), r.value);
    if (ok && delivered) out.push(delivered);
  }
  return out;
}

export const SKIP = Symbol("skip");
/**
 * Read-modify-write of one Store row, conditional on the value it was computed from; refetches and recomputes when
 * another writer got there first. `mutate` returns the new value, `undefined` to delete, or `SKIP` to leave it.
 */
export async function casUpdate<T>(store: Store, table: string, key: readonly (string | number)[], mutate: (cur: T) => T | undefined | typeof SKIP, first?: T): Promise<boolean> {
  let cur = first !== undefined ? first : await store.get<T>(table, key);
  for (let i = 0; i < 16; i++) {
    if (cur === undefined) return false;
    const next = mutate(cur);
    if (next === SKIP) return false;
    if (await store.write([{ table, key, value: next }], [{ table, key, expect: { equals: cur } }])) return true;
    cur = await store.get<T>(table, key);
  }
  return false;
}

/** The notice row a commit's cards live in: keyed by the request id, so a retried request finds the same row. */
const cardsKey = (actor: Actor, requestId: ChangeId) => [actorKey(actor), 0, 0, `req:${requestId}`];

/** The notice row holding a save's cards, written in the same batch as the save's append (`cardsWrite`). */
function cardsRow(actor: Actor, requestId: ChangeId, change: ChangeId | null, cards: readonly ConflictCard[]) {
  const to = actorKey(actor), at = Date.now();
  const text = `${cards.length} conflict card${cards.length === 1 ? "" : "s"} on your change ${change ?? requestId}: the other side's value was kept; pick with \`cb resolve\``;
  return { table: "notices", key: cardsKey(actor, requestId), value: { to, kind: "late-conflict", text, change: change ?? requestId, cards: [...cards], at, deliveredAt: at } };
}

/**
 * A request's receipt, written with its cards: what it answered. A save whose every edit was carded confirms without a
 * change, so the change id can't deduplicate a retry; the receipt does (local `notices` table, `@request` prefix, which
 * no actor reads). It stays after the cards are resolved, so a retry never brings them back.
 */
const receiptKey = (requestId: ChangeId) => ["@request", requestId];
interface Receipt { seq: number; change: ChangeId | null; cards: ConflictCard[]; at: number }

/** What a write needs from the materializer, when the holder runs one (`@carton/cardboard/node`'s `Materializer`). */
export interface ViewPrinter {
  printView(name: string, owner: Actor, opts?: { hooked?: boolean }): Promise<{ name: string; path: string; ref: string }>;
  onCb?(): Promise<void>;
  onHeadChange?(cause: "local" | "gui" | "remote"): void;
}

/** Run one write on a Carton handle and answer with the cb result contract. */
export async function runWrite(carton: Carton, req: WriteRequest, opts: { online?: () => boolean; materializer?: ViewPrinter | null; viewName?: (actor: Actor, wanted?: string) => Promise<string> } = {}): Promise<CbResult> {
  const notices = await deliverNotices(carton, req.actor);
  const op = req.op;
  const author = req.actor;
  // a `cb` call keeps the shared timeline.tsx frozen against non-agent changes for a while (§6.4 freeze triggers)
  await opts.materializer?.onCb?.();
  // listen before writing: on a shared cut the ack can arrive before commit() returns
  const outcomes = watchOutcomes(carton);
  try {
    return await run();
  } finally {
    outcomes.close();
  }
  async function run(): Promise<CbResult> {
  let r: any;
  let kept: ConflictCard[] = [];
  switch (op.kind) {
    case "printView": {
      if (!opts.materializer) return { status: "error", error: "views need the app open (or a helper that materializes)", notices };
      const name = opts.viewName ? await opts.viewName(author, op.name) : op.name ?? author.id.replace(/[^A-Za-z0-9._-]/g, "_");
      // saves of the view are credited to its owner: a hooked or self-declared agent is itself; an unnamed terminal
      // caller is the view file (two terminal agents on one machine look alike; their views don't, §6.4)
      const owner: Actor = isFallbackActor(author) ? { kind: "external", id: `external:.scratch/views/${name}.tsx`, name: `${author.name ?? "Terminal"} (view ${name})`, group: author.group } : author;
      const v = await opts.materializer.printView(name, owner, { hooked: hookDelivered(author) });
      return { status: "confirmed", seq: 0, ref: v.ref, notices, view: v };
    }
    case "commit": {
      // A save whose merge raises cards: the rest lands, and each card keeps head's value until someone picks (nothing
      // is lost). Core's own rebase loop decides every card "ours" (keeping its intents, inferred remaps and policy as
      // it would for any rebase) and reports the cards it decided; they are written as a notice for `cb conflicts` /
      // `cb resolve` in the same atomic batch as the append, so no crash or concurrent writer can separate them.
      // The base is fixed once per request (default: head now): a retry after core lost its append race must merge
      // from the same base, never re-apply the proposal on a newer head.
      if (op.base === undefined) op.base = (await carton.head(op.cut)).ref;
      const store = storeOf(carton);
      const receipt = store ? await store.get<Receipt>("notices", receiptKey(req.id)) : undefined;
      if (receipt) {
        // this request already landed (its cards may have been resolved since): answer as it did, write nothing
        kept = receipt.cards;
        r = { status: "confirmed", seq: receipt.seq, ref: null, change: receipt.change ? { id: receipt.change } : null, rebased: 0, notices: [], ...(receipt.change ? {} : { empty: true }) };
        break;
      }
      // on a shared cut core deduplicates a retried id itself (pending or confirmed): no receipt there, only the cards
      const sharedCut = (await carton.cuts()).find((c) => c.id === (op.cut ?? carton.cut))?.sequencer.kind !== "local";
      r = await carton.commit({
        id: req.id, author, cut: op.cut, base: op.base, doc: op.doc as any, ops: op.ops as any, intent: op.intent as any, kinds: op.kinds as any, policy: op.policy, name: op.name,
        choices: () => "ours" as const,
        ...(store
          ? {
              cardsWrite: (cards: ConflictCard[], change: ConfirmedChange | null) => [
                cardsRow(author, req.id, change?.id ?? null, cards),
                ...(sharedCut ? [] : [{ table: "notices", key: receiptKey(req.id), value: { seq: change?.seq ?? 0, change: change?.id ?? null, cards, at: Date.now() } satisfies Receipt }]),
              ],
            }
          : {}),
      });
      if ((r.status === "confirmed" || r.status === "pending") && r.resolved?.length) kept = r.resolved;
      else if (r.status === "confirmed" && store) {
        // another copy of this request won the race (we got its duplicate): answer with that copy's cards
        const won = await store.get<Receipt>("notices", receiptKey(req.id));
        if (won?.cards.length) kept = won.cards;
      }
      break;
    }
    case "fold": {
      // --keep mine|theirs decides every card one way; without it a fold with cards saves nothing and lists them
      const choices = op.keep ? () => (op.keep === "mine" ? "ours" : "theirs") as "ours" | "theirs" : undefined;
      r = op.reject?.length
        ? await carton.foldSome(op.from, { into: op.into, author, reject: op.reject, check: op.check, missingBase: op.missingBase, choices, id: req.id })
        : await carton.fold(op.from, { into: op.into, author, check: op.check, missingBase: op.missingBase, choices, id: req.id });
      break;
    }
    // each runs under the request's id: a retried call (its holder died after receiving it) gets the first answer
    case "restore": r = await carton.restore(op.ref, { author, cut: op.cut, id: req.id }); break;
    case "revert": r = await carton.revert(op.changeId, { author, cut: op.cut, id: req.id }); break;
    case "undo": r = await carton.undo(op.group ?? author.group, { cut: op.cut, author, id: req.id }); break;
    case "undoTurn": r = await undoTurn(carton, req.id, op.turn, author, op.cut); break;
    case "fork": { const cut = await carton.fork(op.name, { from: op.from, kind: op.cutKind as any, author, id: req.id }); return { status: "confirmed", seq: 0, ref: null, notices, cut }; }
    case "switch": await carton.switchTo(op.cut); return { status: "confirmed", seq: 0, ref: null, notices, cut: op.cut };
    case "name": await carton.name(op.ref, op.name); return { status: "confirmed", seq: 0, ref: op.ref, notices };
    case "pin": { const pin = await carton.pin({ owner: op.owner, cut: op.cut, ttlMs: op.ttlMs }); return { status: "confirmed", seq: pin.ref.seq, ref: pin.header, notices, header: pin.header }; }
    case "closeCard": return { status: "confirmed", seq: 0, ref: null, notices, closed: await closeCard(carton, author, op.change, op.path) };
    case "share": {
      // local → handing off → server (§5.3); the pusher this holder runs picks the cut up, and commits made during the
      // upload stay pending until the server has adopted the cut
      const rec = await carton.share(op.cut);
      return { status: "confirmed", seq: 0, ref: null, notices, cut: rec };
    }
    default: return { status: "error", error: `unknown write ${(op as any).kind}`, notices };
  }
  if (r?.status === "confirmed" && !r.empty) opts.materializer?.onHeadChange?.("local");
  if (r?.status === "up-to-date") return { status: "confirmed", seq: 0, ref: null, notices, upToDate: true };
  if (r?.status === "missing-base" || r?.status === "compare") return { status: "conflicts", conflicts: r.cards ?? [], ref: null, notices, dialog: r.dialog };
  const asConflicts = (x: CbResult): CbResult => (kept.length && (x.status === "confirmed" || x.status === "pending") ? { ...x, status: "conflicts", conflicts: kept, ref: x.ref ?? null, landed: x.status } as CbResult : x);
  if (r?.status !== "pending") return asConflicts(toCbResult(r, notices, r?.entry ? { undid: r.entry } : {}));
  // a shared cut: wait for the server (L14); offline answers pending at once, and conflicts arrive later as notices
  const online = opts.online?.() ?? (carton.sync?.status === "up-to-date" || carton.sync?.status === "syncing");
  if (!online) return asConflicts({ ...toCbResult(r, notices), online: false } as CbResult);
  const ms = req.waitMs ?? WAIT_MS;
  if (carton.sync?.waitFor) {
    // the shared cut's own answer: confirmed by the server, a late conflict, a rejection, or still pending
    const o = await carton.sync.waitFor(r.id, ms, destCut(op));
    if (o.status === "confirmed") return asConflicts({ status: "confirmed", id: r.id, seq: o.seq, ref: null, notices });
    // spent with no effect of its own: an identical edit was already there. Saved, in effect: never an error
    if (o.status === "absorbed") return asConflicts({ status: "confirmed", id: r.id, seq: o.seq, ref: null, notices, absorbed: true, note: ALREADY_IN_PLACE });
    if (o.status === "pending") return asConflicts({ ...toCbResult(r, notices), online: true } as CbResult);
    for (const x of await deliverNotices(carton, req.actor)) if (x.change !== r.id) notices.push(x);
    return o.status === "rejected" ? rejectedResult(r.id, o.reason, notices) : { status: "conflicts", id: r.id, conflicts: [...kept, ...o.cards], ref: null, notices, ...(o.absorbed ? { absorbed: true } : {}) };
  }
  const out = await outcomes.wait(r.id, ms);
  if (!out) return asConflicts({ ...toCbResult(r, notices), online: true } as CbResult);
  if (out.kind === "confirmed") return asConflicts({ status: "confirmed", id: r.id, seq: out.seq, ref: null, notices });
  // the change came back with a late conflict while we waited: it is this call's answer; other notices that arrived
  // meanwhile go out with it rather than being marked delivered and dropped
  const n = out.notice;
  for (const x of await deliverNotices(carton, req.actor)) if (!(x.change === n.change && x.kind === n.kind)) notices.push(x);
  return n.kind === "rejected" ? { status: "rejected", id: r.id, reason: n.text, notices } : { status: "conflicts", id: r.id, conflicts: [...kept, ...(n.cards ?? [])], ref: null, notices };
  }
}

/**
 * Undo a whole agent turn (`cb undo --turn`, §8): every change of the turn (the Director's and its subagents'), newest
 * first, inverted against the head and saved as **one** undo change that names them all (`undoOf`), so the actor
 * group's undo stack treats them as undone. Each inverse is a 3-way merge (after → head ← before), as core's revert
 * does, so changes others made meanwhile survive, and a path someone has since changed in a way the inverse can't
 * apply cleanly becomes a card instead of being overwritten. It commits under the request's id: a retried call is
 * deduplicated, never a second undo. Changes this turn already undid (and undo changes themselves) are skipped.
 */
async function undoTurn(carton: Carton, id: ChangeId, turn: string, author: Actor, cut?: string): Promise<CommitResult> {
  const head = await carton.head(cut);
  const versions = await carton.log({ cut, limit: 5000 });
  const undone = new Set<string>();
  for (const v of versions) if (v.kind === "undo" && v.change) for (const x of (await revertsOf(carton, v.change))) undone.add(x);
  const mine = versions.filter((v) => v.author?.turn === turn && v.change && v.kind !== "undo" && !undone.has(v.change));
  if (!mine.length) return { status: "confirmed", seq: head.ref.seq, ref: head.ref, change: null, rebased: 0, notices: [], empty: true };
  let doc: Doc = head.doc;
  const cards: ConflictCard[] = [];
  for (const v of mine) {
    const [before, after] = await Promise.all([carton.checkout({ branchId: v.ref.branchId, seq: v.ref.seq - 1 }), carton.checkout(v.ref)]);
    const m = merge3(after, doc, before, carton.schema, { infer: false });
    doc = m.doc;
    cards.push(...m.conflicts);
  }
  if (cards.length) return { status: "conflicts", cards, ref: head.ref };
  return carton.commit({ id, doc, base: head.ref, author, cut, name: `Undo turn ${turn}`, undoOf: mine.map((v) => v.change!) });
}

/** The change ids an undo change reverts (from the confirmed log in the Store; [] when unknown). */
async function revertsOf(carton: Carton, changeId: ChangeId): Promise<string[]> {
  const store = storeOf(carton);
  if (!store) return [];
  const at = await store.get<[string, number]>("ids", [changeId]);
  if (!at) return [];
  const c = await store.get<{ reverts?: string | string[] }>("changes", at);
  return Array.isArray(c?.reverts) ? c.reverts : c?.reverts ? [c.reverts] : [];
}

/** Core's notice key for an actor (`ActorKey` in core types: `kind/id[/agentId]`). */
export const actorKey = (a: Actor): string => [a.kind, a.id, a.agentId].filter(Boolean).join("/");

/**
 * Drop one card from an actor's late-conflict notices (the card was resolved with `cb resolve`). Notices live in the
 * local `notices` table, `[actorKey, at, n]`; a notice whose last card is closed goes away.
 */
async function closeCard(carton: Carton, actor: Actor, change: ChangeId | null, path: PathKey): Promise<boolean> {
  const store = storeOf(carton);
  if (!store) return false;
  const rows = await store.range<Notice>("notices", { prefix: [actorKey(actor)] });
  for (const { key, value } of rows) {
    if ((change && value.change !== change) || !value.cards?.some((c) => c.path === path)) continue;
    return casUpdate<Notice>(store, "notices", key, (cur) => {
      if (!cur.cards?.some((c) => c.path === path)) return SKIP;
      const cards = cur.cards.filter((c) => c.path !== path);
      return cards.length ? { ...cur, cards } : undefined;
    }, value);
  }
  return false;
}
