// The writes a `cb` or MCP process hands to the lease holder (`carton.commit`), and how the holder runs them on its
// Carton handle (§6.2, R2-02). Every write returns the `cb` result contract:
//   {status: "confirmed", seq, ref} | {status: "pending", id, ref} | {status: "conflicts", conflicts, ref}
//   | {status: "rejected", reason}, with the actor's notices (late conflicts) first.
// On a shared cut the holder waits up to 5 s for the server's answer (L14); offline it answers `pending` at once.
import { merge3 } from "@carton/core";
import type { Actor, Carton, CartonEvent, ChangeId, CommitResult, ConflictCard, Doc, Notice, PathKey, StateRef } from "@carton/core";
import type { Store } from "@carton/core/plugins";
import { hookDelivered, isFallbackActor } from "./identity.ts";

/** The JSON a write carries over the control socket. Docs and ops are plain JSON. */
export type WriteOp =
  | { kind: "commit"; cut?: string; base?: string; doc?: unknown; ops?: unknown[]; intent?: unknown; kinds?: unknown; policy?: "merge" | "lww"; name?: string }
  | { kind: "fold"; from: string; into?: string; check?: boolean; reject?: PathKey[]; missingBase?: "dialog" | "all-cards" }
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

const refText = (r: StateRef | null | undefined): string | null => {
  if (!r) return null;
  return `${r.branchId.slice(0, 8)}@${r.seq}${r.hash8 ? `~${r.hash8}` : ""}`;
};

/** Turn a core CommitResult into the cb result contract. */
export function toCbResult(r: CommitResult | Record<string, any>, notices: Notice[], extra: Record<string, unknown> = {}): CbResult {
  const x = r as any;
  switch (x.status) {
    case "confirmed": return { status: "confirmed", seq: x.seq, ref: refText(x.ref), notices, ...(x.empty ? { empty: true } : {}), ...(x.change?.id ? { id: x.change.id } : {}), ...extra };
    case "pending": return { status: "pending", id: x.id, ref: refText(x.ref), notices, online: false, ...extra };
    case "conflicts": return { status: "conflicts", conflicts: x.cards ?? [], ref: refText(x.ref), notices, ...extra };
    case "rejected": return { status: "rejected", reason: x.reason ?? x.invalid?.error ?? "rejected", notices, ...extra };
    default: return { status: "confirmed", seq: x.seq ?? 0, ref: refText(x.ref), notices, ...x, ...extra } as CbResult;
  }
}

/**
 * Wait for a pending change's outcome: confirmed (the server acked it), a late conflict, or a rejection. Resolves null
 * on timeout (the caller answers `pending`).
 */
export function waitOutcome(carton: Carton, id: ChangeId, ms: number): Promise<{ kind: "confirmed"; seq: number } | { kind: "notice"; notice: Notice } | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: any) => { if (done) return; done = true; off(); clearTimeout(t); resolve(v); };
    const off = carton.on((e: CartonEvent) => {
      if (e.type === "change" && e.change.id === id) finish({ kind: "confirmed", seq: e.seq });
      else if (e.type === "notice" && e.notice.change === id && (e.notice.kind === "late-conflict" || e.notice.kind === "rejected")) finish({ kind: "notice", notice: e.notice });
    });
    const t = setTimeout(() => finish(null), ms);
    t.unref?.();
  });
}

/** What a write needs from the materializer, when the holder runs one (`@carton/cardboard/node`'s `Materializer`). */
export interface ViewPrinter {
  printView(name: string, owner: Actor, opts?: { hooked?: boolean }): Promise<{ name: string; path: string; ref: string }>;
  onCb?(): Promise<void>;
  onHeadChange?(cause: "local" | "gui" | "remote"): void;
}

/** Run one write on a Carton handle and answer with the cb result contract. */
export async function runWrite(carton: Carton, req: WriteRequest, opts: { online?: () => boolean; materializer?: ViewPrinter | null; viewName?: (actor: Actor, wanted?: string) => Promise<string> } = {}): Promise<CbResult> {
  const notices = await carton.notices(req.actor, { take: true });
  const op = req.op;
  const author = req.actor;
  // a `cb` call keeps the shared timeline.tsx frozen against non-agent changes for a while (§6.4 freeze triggers)
  await opts.materializer?.onCb?.();
  let r: any;
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
    case "commit":
      r = await carton.commit({ id: req.id, author, cut: op.cut, base: op.base, doc: op.doc as any, ops: op.ops as any, intent: op.intent as any, kinds: op.kinds as any, policy: op.policy, name: op.name });
      break;
    case "fold":
      r = op.reject?.length
        ? await carton.foldSome(op.from, { into: op.into, author, reject: op.reject, check: op.check, missingBase: op.missingBase })
        : await carton.fold(op.from, { into: op.into, author, check: op.check, missingBase: op.missingBase });
      break;
    case "restore": r = await carton.restore(op.ref, { author, cut: op.cut }); break;
    case "revert": r = await carton.revert(op.changeId, { author, cut: op.cut }); break;
    case "undo": r = await carton.undo(op.group ?? author.group, { cut: op.cut, author }); break;
    case "undoTurn": r = await undoTurn(carton, op.turn, author, op.cut); break;
    case "fork": { const cut = await carton.fork(op.name, { from: op.from, kind: op.cutKind as any }); return { status: "confirmed", seq: 0, ref: null, notices, cut }; }
    case "switch": await carton.switchTo(op.cut); return { status: "confirmed", seq: 0, ref: null, notices, cut: op.cut };
    case "name": await carton.name(op.ref, op.name); return { status: "confirmed", seq: 0, ref: op.ref, notices };
    case "pin": { const pin = await carton.pin({ owner: op.owner, cut: op.cut, ttlMs: op.ttlMs }); return { status: "confirmed", seq: pin.ref.seq, ref: pin.header, notices, header: pin.header }; }
    case "closeCard": return { status: "confirmed", seq: 0, ref: null, notices, closed: await closeCard(carton, author, op.change, op.path) };
    default: return { status: "error", error: `unknown write ${(op as any).kind}`, notices };
  }
  if (r?.status === "confirmed" && !r.empty) opts.materializer?.onHeadChange?.("local");
  if (r?.status === "up-to-date") return { status: "confirmed", seq: 0, ref: null, notices, upToDate: true };
  if (r?.status === "missing-base" || r?.status === "compare") return { status: "conflicts", conflicts: r.cards ?? [], ref: null, notices, dialog: r.dialog };
  if (r?.status !== "pending") return toCbResult(r, notices, r?.entry ? { undid: r.entry } : {});
  // a shared cut: wait for the server (L14); offline answers pending at once, and conflicts arrive later as notices
  const online = opts.online?.() ?? carton.sync?.status === "up-to-date";
  if (!online) return { ...toCbResult(r, notices), online: false } as CbResult;
  const out = await waitOutcome(carton, r.id, req.waitMs ?? WAIT_MS);
  if (!out) return { ...toCbResult(r, notices), online: true } as CbResult;
  if (out.kind === "confirmed") return { status: "confirmed", id: r.id, seq: out.seq, ref: null, notices };
  // the change came back with a late conflict while we waited: it is this call's answer, not a later notice
  await carton.notices(req.actor, { take: true });
  const n = out.notice;
  return n.kind === "rejected" ? { status: "rejected", id: r.id, reason: n.text, notices } : { status: "conflicts", id: r.id, conflicts: n.cards ?? [], ref: null, notices };
}

/**
 * Undo a whole agent turn (`cb undo --turn`, §8): every change of the turn (the Director's and its subagents'), newest
 * first, inverted against the head and saved as **one** change. Each inverse is a 3-way merge (after → head ← before),
 * as core's revert does, so changes others made meanwhile survive, and a path someone has since changed in a way the
 * inverse can't apply cleanly becomes a card instead of being overwritten.
 */
async function undoTurn(carton: Carton, turn: string, author: Actor, cut?: string): Promise<CommitResult> {
  const head = await carton.head(cut);
  const versions = await carton.log({ cut, limit: 5000 });
  const mine = versions.filter((v) => v.author?.turn === turn && v.change);
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
  return carton.commit({ doc, base: head.ref, author, cut, name: `Undo turn ${turn}` });
}

/** Core's notice key for an actor (`ActorKey` in core types: `kind/id[/agentId]`). */
export const actorKey = (a: Actor): string => [a.kind, a.id, a.agentId].filter(Boolean).join("/");

/**
 * Drop one card from an actor's late-conflict notices (the card was resolved with `cb resolve`). Notices live in the
 * local `notices` table, `[actorKey, at, n]`; a notice whose last card is closed goes away.
 */
async function closeCard(carton: Carton, actor: Actor, change: ChangeId | null, path: PathKey): Promise<boolean> {
  const store = (carton as unknown as { store?: Store }).store;
  if (!store) return false;
  const rows = await store.range<Notice>("notices", { prefix: [actorKey(actor)] });
  for (const { key, value } of rows) {
    if ((change && value.change !== change) || !value.cards?.some((c) => c.path === path)) continue;
    const cards = value.cards.filter((c) => c.path !== path);
    await store.write([{ table: "notices", key, value: cards.length ? { ...value, cards } : undefined }]);
    return true;
  }
  return false;
}
