// The writes a `cb` or MCP process hands to the lease holder (`carton.commit`), and how the holder runs them on its
// Carton handle (§6.2, R2-02). Every write returns the `cb` result contract:
//   {status: "confirmed", seq, ref} | {status: "pending", id, ref} | {status: "conflicts", conflicts, ref}
//   | {status: "rejected", reason}, with the actor's notices (late conflicts) first.
// On a shared cut the holder waits up to 5 s for the server's answer (L14); offline it answers `pending` at once.
import type { Actor, Carton, CartonEvent, ChangeId, CommitResult, ConflictCard, Notice, PathKey, StateRef } from "@carton/core";

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
  | { kind: "pin"; owner: string; cut?: string; ttlMs?: number };

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

/** Run one write on a Carton handle and answer with the cb result contract. */
export async function runWrite(carton: Carton, req: WriteRequest, opts: { online?: () => boolean } = {}): Promise<CbResult> {
  const notices = await carton.notices(req.actor, { take: true });
  const op = req.op;
  const author = req.actor;
  let r: any;
  switch (op.kind) {
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
    case "undo": r = await carton.undo(op.group ?? author.group, { cut: op.cut }); break;
    case "undoTurn": r = await undoTurn(carton, op.turn, author, op.cut); break;
    case "fork": { const cut = await carton.fork(op.name, { from: op.from, kind: op.cutKind as any }); return { status: "confirmed", seq: 0, ref: null, notices, cut }; }
    case "switch": await carton.switchTo(op.cut); return { status: "confirmed", seq: 0, ref: null, notices, cut: op.cut };
    case "name": await carton.name(op.ref, op.name); return { status: "confirmed", seq: 0, ref: op.ref, notices };
    case "pin": { const pin = await carton.pin({ owner: op.owner, cut: op.cut, ttlMs: op.ttlMs }); return { status: "confirmed", seq: pin.ref.seq, ref: pin.header, notices, header: pin.header }; }
    default: return { status: "error", error: `unknown write ${(op as any).kind}`, notices };
  }
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
 * Undo a whole agent turn (`cb undo --turn`, §8): every change of the turn, newest first, inverted against the head as
 * one change. Each inverse is a 3-way merge (after → head ← before), so changes others made meanwhile survive, and a
 * path someone has since changed in a way the inverse can't apply cleanly becomes a card.
 */
async function undoTurn(carton: Carton, turn: string, author: Actor, cut?: string): Promise<CommitResult> {
  const versions = await carton.log({ cut });
  const mine = versions.filter((v) => v.author?.turn === turn && v.change);
  if (!mine.length) return { status: "confirmed", seq: (await carton.head(cut)).ref.seq, ref: (await carton.head(cut)).ref, change: null, rebased: 0, notices: [], empty: true };
  // reverts newest first; core's revert is a 3-way merge per change
  let last: CommitResult | null = null;
  for (const v of mine) {
    last = await carton.revert(v.change!, { author: { ...author }, cut });
    if (last.status === "conflicts" || last.status === "rejected") return last;
  }
  return last!;
}
