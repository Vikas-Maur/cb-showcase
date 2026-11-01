// The writes a `cb` or MCP process hands to the lease holder (`carton.commit`), and how the holder runs them on its
// Carton handle (§6.2, R2-02). Every write returns the `cb` result contract:
//   {status: "confirmed", seq, ref} | {status: "pending", id, ref} | {status: "conflicts", conflicts, ref}
//   | {status: "rejected", reason}, with the actor's notices (late conflicts) first.
// On a shared cut the holder waits up to 5 s for the server's answer (L14); offline it answers `pending` at once.
//
// A save whose merge raises cards is committed with head's value kept for each card (the rest lands, nothing is lost),
// as `cb source apply` did in the verified prototype; the cards are kept as a notice for the actor, so `cb conflicts`
// lists them and `cb resolve` can pick the other side later. Notices are marked delivered when a result carries them,
// never deleted until resolved or handed to the person (the Stop hook and `cb resolve` still need them). They go out
// once the result exists (a call that fails gives none away), recorded against the request, so a retry of a request
// whose answer was lost with its holder gets them again; the outcome a write is still waiting for is that write's to
// report, never another call's.
import { merge3 } from "@carton/core";
import type { Actor, Carton, CartonEvent, ChangeId, CommitResult, ConfirmedChange, ConflictCard, Doc, Notice, PathKey, StateRef } from "@carton/core";
import type { Store, StoreCondition, StoreWrite } from "@carton/core/plugins";
import { statusPath } from "@carton/cardboard/node";
import { hookDelivered, isFallbackActor } from "./identity.ts";
import type { HookOp } from "./hooks.ts";

/** The JSON a write carries over the control socket. Docs and ops are plain JSON. */
export type WriteOp =
  /** `base`: the version the edit was made on, as Carton gave it: a StateRef, or a printed header (default: head). */
  /**
   * `head` (commit, fold, restore, revert, undo, undoTurn): answer a write that saved (confirmed, pending or conflicts)
   * with the holder's head as well (`head: {ref, doc}`: its optimistic state, with this write in, of the cut the write
   * went to). A caller that writes the project file itself (the Windows app's cb, windows-sync) can't read that state:
   * its own handle has the confirmed rows only. A confirmed answer needs it too: a write that changed nothing confirms
   * at once while the holder's own edits still wait for the server.
   */
  | { kind: "commit"; cut?: string; base?: string | StateRef; doc?: unknown; ops?: unknown[]; intent?: unknown; kinds?: unknown; policy?: "merge" | "lww"; name?: string; head?: boolean }
  | { kind: "fold"; from: string; into?: string; check?: boolean; reject?: PathKey[]; missingBase?: "dialog" | "all-cards"; keep?: "mine" | "theirs"; head?: boolean }
  | { kind: "restore"; ref: string; cut?: string; head?: boolean }
  | { kind: "revert"; changeId: ChangeId; cut?: string; head?: boolean }
  | { kind: "undo"; group?: string; cut?: string; head?: boolean }
  | { kind: "undoTurn"; turn: string; cut?: string; head?: boolean }
  | { kind: "fork"; name: string; from?: string; cutKind?: string }
  | { kind: "switch"; cut: string }
  | { kind: "name"; ref: string; name: string }
  | { kind: "pin"; owner: string; cut?: string; ttlMs?: number }
  /**
   * `cb source print --view <name>`: the materializer prints a per-agent view (§6.4); needs a holder that runs one. A
   * hooked agent's view is named after it whatever it asks; others get the name asked, else `agent-<4 chars>`.
   */
  | { kind: "printView"; name?: string }
  /**
   * An agent's Claude Code hook event (hooks.ts `HookOp`: read, write, stop) for the holder's materializer: the
   * freeze of the shared file, credits for a hooked agent's save, the turn's pins (§6.4, H8). Never starts a helper,
   * never counts as a `cb` call, never delivers notices (no agent reads a hook's answer); applied once per request id
   * by the same materializer. With no materializer to tell: `hook: {event, delivered: false}`.
   */
  | HookOp
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
  /**
   * The person's own action in the app (⌘Z, a menu command; the facade sets it), not a `cb` call: nobody is about to
   * work on the shared timeline.tsx because of it, so it doesn't freeze the file (`tellBusy`), and the file shows the
   * write at once. `cb` never sets it. Only `true` counts.
   */
  gui?: boolean;
}

/**
 * WriteOp `head`'s answer: the holder's head of the cut written to (core's `head(cut)`: the records are History's own,
 * frozen and shared, never copied per answer; only the collection arrays are new).
 */
export type WriteHead = { ref: StateRef; doc: unknown };
export type CbResult =
  /** `head` (confirmed, pending, conflicts): when the write asked for it (WriteOp `head`). */
  | { status: "confirmed"; id?: ChangeId; seq: number; ref: string | null; notices: Notice[]; empty?: boolean; head?: WriteHead; [k: string]: unknown }
  | { status: "pending"; id: ChangeId; ref: string | null; notices: Notice[]; online: boolean; head?: WriteHead; [k: string]: unknown }
  | { status: "conflicts"; id?: ChangeId; conflicts: ConflictCard[]; ref: string | null; notices: Notice[]; head?: WriteHead; [k: string]: unknown }
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
export const IDEMPOTENT: ReadonlySet<WriteOp["kind"]> = new Set(["commit", "fold", "restore", "revert", "undo", "undoTurn", "fork", "switch", "name", "pin", "printView", "closeCard", "share", "hook"]);

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
type NoticeRow = Notice & { deliveredAt?: number; deliveredTo?: ChangeId; handedToHuman?: number; blockedAt?: number };

/**
 * Requests running on a handle (the lease holder serves every shared-cut write, so one process sees them all): the
 * outcome one of them is waiting for is its answer, so another call of the same actor leaves that notice alone.
 */
const RUNNING = new WeakMap<Carton, Map<ChangeId, number>>();
const running = (c: Carton) => RUNNING.get(c) ?? RUNNING.set(c, new Map()).get(c)!;

/**
 * The actor's notices not delivered yet, marked delivered to `request` (not deleted: an unresolved card stays for `cb
 * conflicts`, `cb resolve` and the Stop hook), plus those already delivered to `request` (a retry whose first answer
 * was lost). `answered`: the change whose outcome is the result itself, marked delivered but not listed again.
 * Returned at the start of the actor's result (§6.2).
 */
export async function deliverNotices(carton: Carton, actor: Actor, opts: { request?: ChangeId; answered?: ChangeId | null } = {}): Promise<Notice[]> {
  const store = storeOf(carton);
  if (!store) return carton.notices(actor, { take: false });
  const busy = running(carton);
  // one batch, conditional on every row as read: all of them are marked or none (a failed write gives nothing away),
  // and a card resolved, a hook's mark, or another copy of this request getting there first means read again
  for (let attempt = 0; attempt < 16; attempt++) {
    const at = Date.now();
    const out: Notice[] = [];
    const writes: StoreWrite[] = [];
    const conds: StoreCondition[] = [];
    for (const { key, value } of await store.range<NoticeRow>("notices", { prefix: [actorKey(actor)] })) {
      if (value.handedToHuman) continue;
      if (value.deliveredAt) {
        if (opts.request && value.deliveredTo === opts.request && value.change !== opts.answered) out.push(value);
        continue;
      }
      // the outcome another running request waits for: it reports it
      if (value.change && value.change !== opts.request && busy.has(value.change)) continue;
      const delivered: NoticeRow = { ...value, deliveredAt: at, ...(opts.request ? { deliveredTo: opts.request } : {}) };
      writes.push({ table: "notices", key, value: delivered });
      conds.push({ table: "notices", key, expect: { equals: value } });
      if (value.change !== opts.answered) out.push(delivered);
    }
    if (!writes.length || (await store.write(writes, conds))) return out;
    // other writers (hook marks, resolves) kept changing these rows: let them through before reading again
    if (attempt >= 2) await new Promise((r) => setTimeout(r, 2 + Math.random() * 8 * attempt));
  }
  // never answer without them: a retry's replay or this call's own outcome would be lost. The write is run again
  // (deduplicated by its id), delivery with it
  throw new Error("Carton: the store changed under this write (its notices kept changing while being delivered)");
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
export function cardsRow(actor: Actor, requestId: ChangeId, change: ChangeId | null, cards: readonly ConflictCard[]) {
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
/**
 * `shared`: written with a shared cut's pending row; it holds the cards, and core says whether the change landed.
 * `cut`: the cut the request went to, so a retry's WriteOp `head` is of that cut even after a switch (older receipts
 * have none: the op's cut, else the current one). runWrite fixes it once per request and commits there.
 */
interface Receipt { seq: number; change: ChangeId | null; cards: ConflictCard[]; at: number; shared?: boolean; cut?: string }

/** What a write needs from the materializer, when the holder runs one (`@carton/cardboard/node`'s `Materializer`). */
export interface ViewPrinter {
  /** `status`: the view's status file (project-relative); default `.scratch/views/<name>.status` (cardboard's). */
  printView(name: string, owner: Actor, opts?: { hooked?: boolean }): Promise<{ name: string; path: string; ref: string; status?: string }>;
  /**
   * Hook events (WriteOp `hook`): a hooked agent read the shared file, is about to write `rel`, ended its turn. A
   * hooked agent's own `cb` call is `hookRead` too (`tellBusy`).
   */
  hookRead?(actor: Actor): Promise<void>;
  hookWrite?(actor: Actor, rel: string): Promise<void>;
  hookStop?(actor: Actor): Promise<void>;
  /** A `cb` call by someone whose stop nobody reports (`tellBusy`): the shared file stays frozen a while after it. */
  onCb?(): Promise<void>;
  onHeadChange?(cause: "local" | "gui" | "remote"): void;
  /**
   * The current cut changed (`cb cut switch`): the files must show the new cut now, and a freeze started on the old
   * cut (its view, its base seq) doesn't apply to the new one. Without it, `onHeadChange("local")` (project.json
   * follows; a frozen timeline.tsx doesn't).
   */
  onCutSwitch?(cut: string): void | Promise<void>;
  /**
   * carton.db may have moved under the holder (another process wrote it, B11): the materializer reads head and brings
   * the files up to it, or does nothing when it already shows that head (cardboard-adapter `e352fea`). The holder's
   * follower calls it on every write another connection made; without it, `onHeadChange("local")` for another
   * process's change on the current cut.
   */
  onExternalHeadChange?(): Promise<unknown>;
  /** A view's change settled after its save returned (a shared cut): its `.status` sidecar says so (R5-04). */
  onChangeUpdate?(view: string, changeId: string, s: { status: "confirmed" | "conflicts" | "rejected"; seq?: number; conflicts?: ConflictCard[]; reason?: string }): Promise<void>;
}

/**
 * `cb` calls by `authors` reached the holder (its own runWrite, or another process's changes its follower found): tell
 * the materializer an agent is working (§6.4 freeze triggers). A hooked agent (its hook events reach the holder, its
 * Stop too) is `hookRead`: the shared timeline.tsx stays frozen until its Stop, which ends the freeze at once. Anyone
 * else (a windowless agent, the person's own `cb`, a change with no author) is `onCb`: nothing reports their stop, so
 * the file stays frozen for a while after the call. A materializer without hookRead/hookStop gets `onCb` for all.
 * Without this, a hooked agent's `cb` call kept timeline.tsx frozen a minute after its turn ended (windows-sync H8).
 */
export async function tellBusy(mz: ViewPrinter | null | undefined, authors: readonly (Actor | null | undefined)[]): Promise<void> {
  if (!mz) return;
  const hooks = !!(mz.hookRead && mz.hookStop);
  let windowless = authors.length === 0;
  const told = new Set<string>();
  for (const a of authors) {
    if (!(a && hooks && hookDelivered(a))) windowless = true;
    else if (!told.has(a.id)) {
      told.add(a.id);
      await mz.hookRead!(a);
    }
  }
  if (windowless) await mz.onCb?.();
}

const HOOK_EVENTS: ReadonlySet<string> = new Set(["read", "write", "stop"]);
/** Hook requests a materializer was told, by request id: the call, and when it settled. */
interface Told { call: Promise<void>; settled?: number }
const hooksTold = new WeakMap<ViewPrinter, Map<ChangeId, Told>>();
/** A settled request is remembered this long (a retry comes within seconds), and at most this many. */
const HOOKS_KEEP_MS = 10 * 60_000;
const HOOKS_KEPT = 10_000;
/** Forget settled requests past HOOKS_KEEP_MS, then the oldest settled past HOOKS_KEPT; a call in flight never. */
function forgetTold(told: Map<ChangeId, Told>, now: number): void {
  for (const [id, t] of told) if (t.settled !== undefined && now - t.settled >= HOOKS_KEEP_MS) told.delete(id);
  for (const [id, t] of told) {
    if (told.size <= HOOKS_KEPT) break;
    if (t.settled !== undefined) told.delete(id);
  }
}

/**
 * WriteOp `hook`: tell the materializer, once per request id. A retry of a request it was told (an answer lost on the
 * socket) waits for that call instead of making it again: `hookWrite` queues one credit per call, so a second would
 * credit the agent with someone else's next save. A call that failed isn't made again either: it may have taken
 * effect before it failed (cardboard's hookWrite queues the credit, then updates the freeze), so its retry gets its
 * failure (review H8 #3). A call in flight is never forgotten (#4). A new holder has a new materializer that was never
 * told: the retry tells it.
 */
async function hookEvent(op: HookOp, actor: Actor, id: ChangeId, mz: ViewPrinter | null, notices: Notice[]): Promise<CbResult> {
  if (!HOOK_EVENTS.has(op.event)) return { status: "error", error: `unknown hook event ${JSON.stringify(op.event)}`, notices };
  const file = op.event === "write" ? hookFile(op.file) : null;
  if (op.event === "write" && !file) return { status: "error", error: `a write hook event names a file inside the project, not ${JSON.stringify(op.file ?? null)}`, notices };
  const call = !mz ? null : op.event === "read" ? mz.hookRead && (() => mz.hookRead!(actor)) : op.event === "write" ? mz.hookWrite && (() => mz.hookWrite!(actor, file!)) : mz.hookStop && (() => mz.hookStop!(actor));
  if (!mz || !call) return { status: "confirmed", seq: 0, ref: null, notices, hook: { event: op.event, delivered: false } };
  let told = hooksTold.get(mz);
  if (!told) hooksTold.set(mz, (told = new Map()));
  let t = told.get(id);
  const again = !!t;
  if (!t) {
    if (told.size >= 256) forgetTold(told, Date.now());
    const entry: Told = (t = { call: Promise.resolve().then(call) }); // a materializer that throws at once is a failed call too
    const settle = () => { entry.settled = Date.now(); };
    entry.call.then(settle, settle);
    told.set(id, entry);
  }
  await t.call;
  return { status: "confirmed", seq: 0, ref: null, notices, hook: { event: op.event, delivered: true, ...(again ? { again: true } : {}) } };
}
/** A hook's file: project-relative with `/`, no `..`, not absolute; null when it isn't one. */
function hookFile(f: unknown): string | null {
  if (typeof f !== "string" || !f) return null;
  const rel = f.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!rel || rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.split("/").some((s) => s === ".." || s === "")) return null;
  return rel;
}

/** Run one write on a Carton handle and answer with the cb result contract. */
export async function runWrite(carton: Carton, req: WriteRequest, opts: { online?: (cut?: string) => boolean; materializer?: ViewPrinter | null; viewName?: (actor: Actor, wanted?: string) => Promise<string> } = {}): Promise<CbResult> {
  // filled once the result exists (every result below holds this array): a call that fails gives no notice away
  const notices: Notice[] = [];
  const op = req.op;
  const author = req.actor;
  // the change whose outcome this result reports (its notice is marked delivered, not listed again)
  let answered: ChangeId | null = null;
  // the cut the write went to (core's answer names it), for WriteOp `head`
  let into: string | undefined;
  const busy = running(carton);
  busy.set(req.id, (busy.get(req.id) ?? 0) + 1);
  // listen before writing: on a shared cut the ack can arrive before commit() returns
  const outcomes = watchOutcomes(carton);
  try {
    // a `cb` call keeps the shared timeline.tsx frozen against non-agent changes: a hooked agent's until its Stop, anyone
    // else's for a while (§6.4 freeze triggers; tellBusy); a hook event isn't one (a Stop would freeze the file again
    // just as the turn ends), nor is the person's own action in the app (`gui`: an undo would hide itself for a minute)
    if (op.kind !== "hook" && req.gui !== true) await tellBusy(opts.materializer, [author]);
    let result = await run();
    // WriteOp `head`: the holder's head of the cut the write went to, never of whichever cut is current now
    if ("head" in op && op.head && (result.status === "confirmed" || result.status === "pending" || result.status === "conflicts")) {
      result = { ...result, head: await carton.head(into ?? destCut(op)) } as CbResult;
    }
    // a hook's answer goes to the hook process, never to the agent: its notices stay for its next `cb` call
    if (op.kind !== "hook") notices.push(...(await deliverNotices(carton, req.actor, { request: req.id, answered })));
    return result;
  } finally {
    outcomes.close();
    const n = (busy.get(req.id) ?? 1) - 1;
    if (n) busy.set(req.id, n);
    else busy.delete(req.id);
  }
  async function run(): Promise<CbResult> {
  let r: any;
  let kept: ConflictCard[] = [];
  let extra: Record<string, unknown> = {};
  switch (op.kind) {
    case "printView": {
      if (!opts.materializer) return { status: "error", error: "views need the app open (or a helper that materializes)", notices };
      const name = opts.viewName ? await opts.viewName(author, op.name) : op.name ?? author.id.replace(/[^A-Za-z0-9._-]/g, "_");
      // saves of the view are credited to its owner: a hooked or self-declared agent is itself; an unnamed terminal
      // caller is the view file (two terminal agents on one machine look alike; their views don't, §6.4)
      const owner: Actor = isFallbackActor(author) ? { kind: "external", id: `external:.scratch/views/${name}.tsx`, name: `${author.name ?? "Terminal"} (view ${name})`, group: author.group } : author;
      const v = await opts.materializer.printView(name, owner, { hooked: hookDelivered(author) });
      return { status: "confirmed", seq: 0, ref: v.ref, notices, view: { ...v, status: v.status ?? statusPath(v.name) } };
    }
    case "hook": return hookEvent(op, author, req.id, opts.materializer ?? null, notices);
    case "commit": {
      // A save whose merge raises cards: the rest lands, and each card keeps head's value until someone picks (nothing
      // is lost). Core's own rebase loop decides every card "ours" (keeping its intents, inferred remaps and policy as
      // it would for any rebase) and reports the cards it decided; they are written as a notice for `cb conflicts` /
      // `cb resolve` in the same atomic batch as the append, so no crash or concurrent writer can separate them.
      // The cut and base are fixed once per request (default: the current cut, its head now): a retry after core lost
      // its append race must merge from the same base, never re-apply the proposal on a newer head. The cut is read
      // once and given to core: a switch served while this write waits moves nothing, so the cut core commits on is
      // the one its base, its shared check and its receipt name (review H8 #1: one read here and core's own later one
      // could differ, even for a save whose every edit was carded, which has no change to name its cut).
      if (op.cut === undefined) op.cut = carton.cut;
      if (op.base === undefined) op.base = (await carton.head(op.cut)).ref;
      const store = storeOf(carton);
      const receipt = store ? await store.get<Receipt>("notices", receiptKey(req.id)) : undefined;
      if (receipt && !receipt.shared) {
        // this request already landed (its cards may have been resolved since): answer as it did, write nothing
        kept = receipt.cards;
        if (receipt.cut) into = receipt.cut;
        r = { status: "confirmed", seq: receipt.seq, ref: null, change: receipt.change ? { id: receipt.change } : null, rebased: 0, notices: [], ...(receipt.change ? {} : { empty: true }) };
        break;
      }
      // on a shared cut core deduplicates a retried id itself (pending, confirmed, or recorded as a no-op) and says
      // where it is now; the receipt, written with its pending row, keeps the cards it answered with
      const cutId = op.cut;
      const sharedCut = (await carton.cuts()).find((c) => c.id === cutId)?.sequencer.kind !== "local";
      r = await carton.commit({
        id: req.id, author, cut: op.cut, base: op.base, doc: op.doc as any, ops: op.ops as any, intent: op.intent as any, kinds: op.kinds as any, policy: op.policy, name: op.name,
        choices: () => "ours" as const,
        ...(store
          ? {
              cardsWrite: (cards: ConflictCard[], change: ConfirmedChange | null) => [
                cardsRow(author, req.id, change?.id ?? null, cards),
                { table: "notices", key: receiptKey(req.id), value: { seq: change?.seq ?? 0, change: change?.id ?? null, cards, at: Date.now(), cut: cutId, ...(sharedCut ? { shared: true } : {}) } satisfies Receipt },
              ],
            }
          : {}),
      });
      if ((r.status === "confirmed" || r.status === "pending") && r.resolved?.length) kept = r.resolved;
      else if ((r.status === "confirmed" || r.status === "pending") && store) {
        // a retry, or another copy of this request won the race (we got its duplicate): answer with its cards
        const won = receipt ?? (await store.get<Receipt>("notices", receiptKey(req.id)));
        if (won?.cards.length) kept = won.cards;
      }
      break;
    }
    case "fold": {
      // --keep mine|theirs decides every card one way; without it a fold with cards saves nothing and lists them
      const choices = op.keep ? () => (op.keep === "mine" ? "ours" : "theirs") as "ours" | "theirs" : undefined;
      // what "the rest" would be for this request is decided (and recorded) before the fold: core records a fold that
      // finds nothing new as a no-op under the request's id, so a decision made after it could be interrupted, and a
      // retry would then pick a partial fold made after the request was answered
      const restAsked = !op.check && !op.reject?.length;
      const rest = restAsked ? await restOf(carton, req.id, op.from, op.into) : null;
      r = op.reject?.length
        ? await carton.foldSome(op.from, { into: op.into, author, reject: op.reject, check: op.check, missingBase: op.missingBase, choices, id: req.id })
        : await carton.fold(op.from, { into: op.into, author, check: op.check, missingBase: op.missingBase, choices, id: req.id });
      // nothing new to fold in, but a partial fold of this cut kept some of it out: folding again folds in the rest
      // (§5.3 R2-14: accepting the rest reverts that partial fold's inverse change), under the request's id (B4).
      // A retry finds the first try's answer recorded as a no-op (confirmed, empty) and carries on from there
      const nothingNew = r?.status === "up-to-date" || (r?.status === "confirmed" && r.empty);
      if (nothingNew && restAsked) {
        const inverse = rest;
        if (inverse) {
          // its own id (the fold above recorded the request's id as a no-op); a retry gets this revert's answer again
          r = await carton.revert(inverse, { author, cut: op.into, id: `${req.id}.rest` });
          extra = { rest: true, inverse };
        }
      }
      break;
    }
    // each runs under the request's id: a retried call (its holder died after receiving it) gets the first answer
    case "restore": r = await carton.restore(op.ref, { author, cut: op.cut, id: req.id }); break;
    case "revert": r = await carton.revert(op.changeId, { author, cut: op.cut, id: req.id }); break;
    case "undo": r = await carton.undo(op.group ?? author.group, { cut: op.cut, author, id: req.id }); break;
    case "undoTurn": {
      // what the turn changed that was changed again since stays at its newer value, as a card; the rest is undone
      const u = await undoTurn(carton, req.id, op.turn, author, op.cut);
      r = u.r;
      kept = u.cards;
      break;
    }
    case "fork": { const cut = await carton.fork(op.name, { from: op.from, kind: op.cutKind as any, author, id: req.id }); return { status: "confirmed", seq: 0, ref: null, notices, cut }; }
    case "switch": {
      await carton.switchTo(op.cut);
      // the files follow the current cut (B6): project.json and the shared timeline.tsx show the new one
      const mz = opts.materializer;
      if (mz?.onCutSwitch) await mz.onCutSwitch(op.cut);
      else mz?.onHeadChange?.("local");
      return { status: "confirmed", seq: 0, ref: null, notices, cut: op.cut };
    }
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
  into ??= (r as { ref?: StateRef | null } | undefined)?.ref?.branchId ?? destCut(op);
  if (r?.status === "confirmed" && !r.empty) opts.materializer?.onHeadChange?.("local");
  if (r?.status === "up-to-date") return { status: "confirmed", seq: 0, ref: null, notices, upToDate: true };
  if (r?.status === "missing-base" || r?.status === "compare") return { status: "conflicts", conflicts: r.cards ?? [], ref: null, notices, dialog: r.dialog };
  const asConflicts = (x: CbResult): CbResult => (kept.length && (x.status === "confirmed" || x.status === "pending") ? { ...x, status: "conflicts", conflicts: kept, ref: x.ref ?? null, landed: x.status } as CbResult : x);
  if (r?.status !== "pending") return asConflicts(toCbResult(r, notices, { ...extra, ...(r?.entry ? { undid: r.entry } : {}) }));
  // a shared cut: wait for the server (L14); offline answers pending at once, and conflicts arrive later as notices
  // the cut written to, not the current one: a write to another cut waits on that cut's connection
  const st = () => carton.sync?.state(destCut(op)).status;
  const online = opts.online ? opts.online(destCut(op)) : st() === "up-to-date" || st() === "syncing";
  if (!online) return asConflicts({ ...toCbResult(r, notices), online: false } as CbResult);
  const ms = req.waitMs ?? WAIT_MS;
  if (carton.sync?.waitFor) {
    // the shared cut's own answer: confirmed by the server, a late conflict, a rejection, or still pending
    const o = await carton.sync.waitFor(r.id, ms, destCut(op));
    if (o.status === "confirmed") return asConflicts({ status: "confirmed", id: r.id, seq: o.seq, ref: null, notices });
    // spent with no effect of its own: an identical edit was already there. Saved, in effect: never an error
    if (o.status === "absorbed") return asConflicts({ status: "confirmed", id: r.id, seq: o.seq, ref: null, notices, absorbed: true, note: ALREADY_IN_PLACE });
    if (o.status === "pending") return asConflicts({ ...toCbResult(r, notices), online: true } as CbResult);
    // its notice (core stored it before the wait returned) is this result: marked delivered, not listed again
    answered = r.id;
    return o.status === "rejected" ? rejectedResult(r.id, o.reason, notices) : { status: "conflicts", id: r.id, conflicts: [...kept, ...o.cards], ref: null, notices, ...(o.absorbed ? { absorbed: true } : {}) };
  }
  const out = await outcomes.wait(r.id, ms);
  if (!out) return asConflicts({ ...toCbResult(r, notices), online: true } as CbResult);
  if (out.kind === "confirmed") return asConflicts({ status: "confirmed", id: r.id, seq: out.seq, ref: null, notices });
  // the change came back with a late conflict while we waited: it is this call's answer
  const n = out.notice;
  answered = r.id;
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
/**
 * Undo an agent turn (§8): every change of the turn not undone yet, inverted onto head. What a later change changed
 * again keeps that newer value and becomes a card (base: the turn's value, ours: head's, theirs: the value before the
 * turn), stored for the author as a stale save's are, so `cb conflicts` lists them and `cb resolve` picks; the rest is
 * undone. The cards are written (under the request's id) before the undo commits, so a retry finds them with it.
 */
async function undoTurn(carton: Carton, id: ChangeId, turn: string, author: Actor, cut?: string): Promise<{ r: CommitResult; cards: ConflictCard[] }> {
  const head = await carton.head(cut);
  const store = storeOf(carton);
  // a retry: answer as the first time (an undo, or nothing to undo), before looking at what the turn holds now, on the
  // cut that answer is on (the current cut may have changed since the first try), with the cards it raised
  const replay = async (on: string) => {
    const h = on === (cut ?? carton.cut) ? head : await carton.head(on);
    const cards = (store ? await store.get<ConflictCard[]>("notices", undoCardsKey(id)) : undefined) ?? [];
    return { r: await carton.commit({ id, doc: h.doc, base: h.ref, author, cut: on }), cards };
  };
  const answeredOn = await answeredBefore(carton, id);
  if (answeredOn) return replay(answeredOn);
  const versions = await carton.log({ cut, limit: 5000 });
  const undone = new Set<string>();
  for (const v of versions) if (v.kind === "undo" && v.change) for (const x of (await revertsOf(carton, v.change))) undone.add(x);
  const mine = versions.filter((v) => v.author?.turn === turn && v.change && v.kind !== "undo" && !undone.has(v.change));
  // nothing (left) to undo: head itself, under the request's id. A retry of an undo that landed gets its answer back;
  // a first one changes nothing and is recorded as a no-op, so its retry never undoes work that reached the turn since
  if (!mine.length) {
    // a copy of this request that finished meanwhile is why nothing is left: its answer, with its cards
    const on = await answeredBefore(carton, id);
    if (on) return replay(on);
    return { r: await carton.commit({ id, doc: head.doc, base: head.ref, author, cut }), cards: [] };
  }
  let doc: Doc = head.doc;
  // one card per path: the turn changed a field several times, and a later edit changed it again. Newest first, so the
  // first card's base is the turn's last value and ours is head's; each older change's card only moves theirs back to
  // the value before it, so picking the undo restores the value from before the turn, not one of the turn's own
  const byPath = new Map<string, ConflictCard>();
  for (const v of mine) {
    const [before, after] = await Promise.all([carton.checkout({ branchId: v.ref.branchId, seq: v.ref.seq - 1 }), carton.checkout(v.ref)]);
    // base: the turn's change; ours: head (a clash keeps head's newer value); theirs: before the change
    const m = merge3(after, doc, before, carton.schema, { infer: false });
    doc = m.doc;
    for (const c of m.conflicts) {
      const prev = byPath.get(c.path);
      if (!prev) { byPath.set(c.path, c); continue; }
      const { hunks: _h, ops: _o, ...kept } = prev; // a text card's hunks described the newer pair only
      byPath.set(c.path, { ...kept, theirs: c.theirs });
    }
  }
  const cards = [...byPath.values()];
  if (store) {
    // the cards go in only while this request has no answer yet: a copy of it that finished meanwhile (and whose cards
    // its author may have resolved since) is answered as it was, its cards never written again. A first try that
    // stopped before committing left cards for an undo that never landed: these replace them
    const target = cut ?? carton.cut;
    const shared = (await carton.cuts()).find((c) => c.id === target)?.sequencer.kind !== "local";
    const unanswered = [
      { table: "ids", key: [id], expect: "absent" as const },
      { table: "meta", key: ["noop", id], expect: "absent" as const },
      ...(shared ? [{ table: "pending", key: [target, id], expect: "absent" as const }] : []),
    ];
    const earlier = await store.get<ConflictCard[]>("notices", undoCardsKey(id));
    if (cards.length || earlier?.length) {
      const row = cards.length ? cardsRow(author, id, id, cards) : { table: "notices", key: cardsKey(author, id), value: undefined };
      if (!(await store.write([row, { table: "notices", key: undoCardsKey(id), value: cards }], unanswered))) {
        const on = await answeredBefore(carton, id);
        if (on) return replay(on);
        throw new Error("undo --turn: the store changed under this write; try again");
      }
    }
  }
  return { r: await carton.commit({ id, doc, base: head.ref, author, cut, name: `Undo turn ${turn}`, undoOf: mine.map((v) => v.change!) }), cards };
}
/** The cards an `undo --turn` request raised (local `notices` table, no actor reads it): its retry answers with them. */
const undoCardsKey = (id: ChangeId) => ["@undo-cards", id];

/**
 * The cut on which core already holds an answer for this id: a confirmed change (`ids`), a no-op (`meta ["noop"]`),
 * or a pending edit on a shared cut, whichever cut it went to; null when there is none.
 */
async function answeredBefore(carton: Carton, id: ChangeId): Promise<string | null> {
  const store = storeOf(carton);
  if (!store) return null;
  const at = (await store.get<[string, number]>("ids", [id])) ?? (await store.get<[string, number]>("meta", ["noop", id]));
  if (at) return at[0];
  for (const c of await carton.cuts()) if (c.sequencer.kind !== "local" && (await store.get("pending", [c.id, id])) !== undefined) return c.id;
  return null;
}

/**
 * The newest partial fold of `from` into the cut whose kept-out part isn't folded in yet: its inverse change (a
 * `partial-revert` whose `reverts` is a merge of `from`, and that no later change reverts). `from` is a cut (any of its
 * versions' partial folds, newest first) or one version of it, `cut@seq` (that version's only). From the Store's
 * confirmed log; only read when a fold finds nothing new.
 */
async function keptOut(carton: Carton, from: string, into?: string): Promise<ChangeId | null> {
  const at = /^(.+)@(\d+)(?:~[0-9a-f]+)?$/.exec(from);
  const fromCut = at ? at[1]! : from;
  const fromSeq = at ? Number(at[2]) : null;
  const store = storeOf(carton);
  if (!store) return null;
  type Row = { id: ChangeId; kind?: string; reverts?: ChangeId | ChangeId[]; mergeOf?: { branchId: string; seq: number } };
  const rows = (await store.range<Row>("changes", { prefix: [into ?? carton.cut] })).map((r) => r.value);
  const reverted = new Set<ChangeId>();
  for (const c of rows) if (c.kind !== "partial-revert") for (const x of [c.reverts ?? []].flat()) reverted.add(x);
  const byId = new Map(rows.map((c) => [c.id, c]));
  for (let i = rows.length - 1; i >= 0; i--) {
    const c = rows[i]!;
    if (c.kind !== "partial-revert" || reverted.has(c.id)) continue;
    const merge = byId.get([c.reverts ?? []].flat()[0] ?? "");
    // a partial fold whose merge was undone since has nothing left to complete
    if (merge && !reverted.has(merge.id) && merge.mergeOf?.branchId === fromCut && (fromSeq === null || merge.mergeOf.seq === fromSeq)) return c.id;
  }
  return null;
}

/**
 * What a fold request folds in as "the rest": decided once per request and recorded before the fold itself runs
 * (local `notices` table, `["@fold-rest", id]`, which no actor reads), so a retry, or a second copy of the request,
 * replays that decision: the same inverse, or nothing, never a partial fold made after the request was first made.
 */
async function restOf(carton: Carton, requestId: ChangeId, from: string, into?: string): Promise<ChangeId | null> {
  const store = storeOf(carton);
  const key = ["@fold-rest", requestId];
  type Decision = { inverse: ChangeId | null };
  const done = await revertedBy(carton, `${requestId}.rest`);
  if (done || !store) return done ?? (await keptOut(carton, from, into));
  const prior = await store.get<Decision>("notices", key);
  if (prior) return prior.inverse;
  // core already holds an answer for this request but no decision was recorded with it (a request from before
  // decisions were recorded first): nothing more, never a partial fold made since
  if (await answeredBefore(carton, requestId)) return null;
  const inverse = await keptOut(carton, from, into);
  if (await store.write([{ table: "notices", key, value: { inverse } satisfies Decision }], [{ table: "notices", key, expect: "absent" }])) return inverse;
  return (await store.get<Decision>("notices", key))?.inverse ?? null; // another copy decided first
}

/** The change a confirmed revert with this id reverted (a retried "fold in the rest"), or null. */
async function revertedBy(carton: Carton, id: ChangeId): Promise<ChangeId | null> {
  const [first] = await revertsOf(carton, id);
  return first ?? null;
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
