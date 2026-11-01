// fromCarton(): the view model over a real Carton handle (@carton/core). Use it where the handle lives in the same
// process (the web client, Node, tests). In Cardboard the handle lives in the library worker: serve this view model
// from there with serveUi() and read it in the renderer with remoteUi() (remote.ts).
//
// What it does beyond renaming fields:
// - History is loaded once, kept oldest-first, and grows from the handle's events. Summaries are describe()'s first
//   line, computed lazily for the rows someone looks at (a 10k History never describes 10k versions).
// - A Director turn's versions become one checkpoint row with its edit count (§0.1: chat checkpoints are versions).
// - Pending commits show as provisional versions until confirmed (L5); the row keeps its id, so it doesn't remount.
// - Presence from sync events: peers per actor, idle after 30 s (§12), ghosts from drags.
// - Late conflicts addressed to you arrive as notices and become conflict cards.

import { actorKey, deepEqual, describe, getIn, groupOf, lcs, pathKey, PERSON, shots as engineShots } from "@carton/core";
import type {
  Actor as CoreActor,
  Carton,
  CartonEvent,
  Choice,
  ConflictCard,
  CutRecord,
  Doc,
  Op,
  Rec,
  Schema,
  Shot as CoreShot,
  UndoEntry,
  Version as CoreVersion,
} from "@carton/core";
import { TopicHub } from "./hub.ts";
import type {
  Actor,
  CartonUi,
  Comparison,
  Conflict,
  ConflictChoice,
  Credits,
  Cut,
  FoldChange,
  FoldPlan,
  FoldResult,
  Ghost,
  HistoryFilter,
  HistorySource,
  Peer,
  Preview,
  Published,
  Shot,
  ShotDiff,
  SyncStatus,
  Topic,
  UndoTurn,
  Version,
  VersionKind,
} from "./model.ts";
import { diffSummary } from "./shots.ts";

export interface FromCartonOptions {
  /** The local person. The handle doesn't expose its actor, and "you" needs it. */
  me: CoreActor;
  /** Your undo group (§8). Default: `me.group`, else your actor key. */
  group?: string;
  /** Engine functions (default: @carton/core's). Tests may pass lighter ones. */
  engine?: { shots: typeof engineShots; lcs: typeof lcs; describe: typeof describe };
  /** Clip count and length of a state (Compare card). Default: the schema's timeline collection and end field. */
  measure?: (doc: Doc, schema: Schema) => { clips: number; length: number };
  /** The parts of a clip Credits lists, as record paths. Default: the whole clip, "Last change". */
  creditParts?: (itemId: string, schema: Schema) => { what: string; path: readonly string[] }[];
  /** A clip's display name for Credits. Default: the item id. */
  clipName?: (itemId: string) => string;
  /** Plain words for a card. Default: a generic description from the card's path and values. */
  describeCard?: (card: ConflictCard, schema: Schema) => { title: string; mine: string; theirs: string; reason?: string };
  /** "Keep both" for a card, as the host expresses it (Cardboard: a new track or `alternatives`); null: not offered. */
  keepBoth?: (card: ConflictCard) => Choice | null;
  /** The side a late conflict shows until picked. H5: head's value stays, so "theirs". */
  provisional?: ConflictChoice;
  /** The share link of a published cut. */
  shareUrl?: (cut: CutRecord) => string | undefined;
  /** Render a preview doc (§9 R2-16): called with the read-only doc, or null when the preview closes. */
  onPreview?: (p: { ref: string; label: string; doc: Readonly<Doc> } | null) => void;
  /** Versions loaded per log() call. */
  pageSize?: number;
  /** Describe at most this many versions at once (the rows on screen ask). */
  describeConcurrency?: number;
  /** Re-read the store every N ms (other processes may append). 0: only on events and refresh(). */
  pollMs?: number;
  clock?: () => number;
}

export interface CartonUiHandle extends CartonUi {
  readonly hub: TopicHub<Topic>;
  /** Re-read cuts, history tail, undo and published state (after another process wrote). */
  refresh(): Promise<void>;
  /**
   * Show conflict cards a commit returned (the GUI's own commits), as late ones are shown. Cards follow core's
   * convention: `ours` is the head on screen, `theirs` is the person's own edit (merge3(base, head, mine)).
   */
  reportConflicts(cards: readonly ConflictCard[], by?: CoreActor): void;
  /**
   * The core card behind a Conflict, exactly as it was reported or raised (fields a host added, such as its own card
   * id, included). `Conflict.id` is opaque: map a resolved card back with this, never by parsing the id.
   */
  cardFor<C extends ConflictCard = ConflictCard>(conflictId: string): C | undefined;
  /** Resolves when the first load finished. */
  readonly ready: Promise<void>;
  /** Resolves when nothing is scheduled or running (refreshes, summaries, checks): for tests and hosts that wait. */
  settled(): Promise<void>;
  dispose(): void;
}

const IDLE_MS = 30_000;
const PENDING_PREFIX = "pending:";

/** Split a path key back into segments (`~1` → `/`, `~0` → `~`), the inverse of core's pathKey(). */
export function splitPathKey(key: string): string[] {
  return key.split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** A UI actor from a core actor. Keys follow core's actorKey(); a subagent's parent is its agent. */
/**
 * The agent a subagent works for. The identity sources (`@carton/cardboard` parseActor, `@carton/local`) give a
 * subagent the agent's id plus `/sub-<type>-<id>` (§10: `director/<chat>/<turn>/sub-Explore-ab12`); an id without
 * that suffix is the agent's own (a subagent told apart by `agentId` only).
 */
const agentIdOf = (a: CoreActor): string => {
  const i = a.id.lastIndexOf("/sub-");
  return i > 0 ? a.id.slice(0, i) : a.id;
};

export function toUiActor(a: CoreActor | null | undefined, me: CoreActor, myGroup: string): Actor {
  if (!a) return { key: "system/carton", kind: "system", name: "Carton" };
  const key = actorKey(a);
  const kind: Actor["kind"] = a.kind === "external" ? "agent" : a.kind;
  const isYou = key === actorKey(me) || (a.kind !== "human" && groupOf(a) === myGroup);
  const name = a.kind === "subagent" ? a.name ?? a.agentType ?? a.id : a.kind === "external" ? `${a.name ?? a.id} (terminal)` : a.name ?? a.id;
  const parent = a.kind === "subagent" ? actorKey({ kind: "agent", id: agentIdOf(a) }) : a.kind !== "human" && isYou ? actorKey(me) : undefined;
  return { key, kind, name, ...(parent ? { parent } : {}), ...(a.agentType ? { subagentType: a.agentType } : {}), ...(isYou ? { isYou } : {}) };
}

/** Ops that apply one side of a card at the head. The provisional side needs none. */
export function cardOps(card: ConflictCard, value: unknown): Op[] {
  if (card.kind === "compare" && card.ops) return [...card.ops];
  const path = splitPathKey(card.path);
  const last = path[path.length - 1] ?? "";
  if (last.startsWith("#") && value && typeof value === "object") {
    // A field group card ({field: value}) sets each field, as core's resolve() does with {value}.
    const parent = path.slice(0, -1);
    return Object.entries(value as Record<string, unknown>).map(([f, v]) => (v === undefined ? { op: "unset" as const, path: [...parent, f] } : { op: "set" as const, path: [...parent, f], value: v }));
  }
  if (path.length === 2) {
    // A whole record (delete vs edit, parent removed): take it, or remove it.
    if (value == null) return [{ op: "remove", path }];
    return [{ op: "remove", path }, { op: "insert", path, value }];
  }
  return [value === undefined ? { op: "unset", path } : { op: "set", path, value }];
}

const short = (v: unknown): string => {
  if (v === undefined || v === null) return "removed";
  if (typeof v === "string") return `“${v.length > 60 ? v.slice(0, 57) + "…" : v}”`;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "object") {
    const e = Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x !== "object");
    return e.length ? e.slice(0, 3).map(([k, x]) => `${k} ${short(x)}`).join(", ") : "changed";
  }
  return String(v);
};

/** Generic plain words for a card: the record's label and each side's value. */
export function defaultDescribeCard(card: ConflictCard, schema: Schema): { title: string; mine: string; theirs: string; reason?: string } {
  const path = splitPathKey(card.path);
  const coll = schema.collections[path[0] ?? ""];
  const rec = (card.ours ?? card.theirs ?? card.base) as Rec | undefined;
  const label = coll ? (schema.label?.(path[0]!, path.length === 2 ? rec : undefined) ?? String(path[1])) : path[0] ?? card.path;
  const field = path.slice(2).join(" ").replace(/^#/, "");
  const title = coll ? `'${label}'${field ? ` ${field}` : ""}` : field || label;
  return { title, mine: short(card.ours), theirs: short(card.theirs), ...(card.reason ? { reason: card.reason } : {}) };
}

function defaultMeasure(doc: Doc, schema: Schema) {
  const tl = schema.timeline;
  if (!tl) return { clips: 0, length: 0 };
  const items = (doc[tl.collection] as Rec[] | undefined) ?? [];
  let end = 0;
  for (const it of items) end = Math.max(end, Number(it[tl.end]) || 0);
  return { clips: items.length, length: end };
}

const KIND: Record<string, VersionKind> = { edit: "edit", merge: "fold", revert: "undo", undo: "undo", "partial-revert": "fold", restore: "restore", rebalance: "edit", import: "import", external: "edit", root: "edit", fork: "edit" };

interface Row {
  core: CoreVersion | null;
  v: Version;
  /** The turn this version belongs to, for checkpoint grouping. */
  turnKey: string | null;
}

/** A conflict card the person has to pick on, with where it applies and which of core's sides is theirs. */
interface CardEntry {
  card: ConflictCard;
  /** The cut it applies to: resolving commits there, whatever cut is current then. */
  cut: string;
  /** Core's side holding the person's own edit. Commits, rebases and undo put head in `ours` (merge3(base, head, mine)). */
  mineSide: "ours" | "theirs";
  conflict: Conflict;
}

const sameCore = (a: CoreVersion, b: CoreVersion) =>
  a.ref.branchId === b.ref.branchId && a.ref.seq === b.ref.seq && a.change === b.change && a.name === b.name && a.kind === b.kind && a.at === b.at && actorKey(a.author) === actorKey(b.author);

export function fromCarton(carton: Carton, opts: FromCartonOptions): CartonUiHandle {
  const hub = new TopicHub<Topic>();
  const clock = opts.clock ?? Date.now;
  const engine = opts.engine ?? { shots: engineShots, lcs, describe };
  const myGroup = opts.group ?? groupOf(opts.me);
  const meKey = actorKey(opts.me);
  // Core records Cardboard's GUI saves as the generic person (human/person) and addresses their conflict and rejection
  // notices to that actor, even when the app has resolved who the person is (setIdentity) and passes them as `me`.
  // Notices never cross machines, so one addressed to the generic person is always this person's own.
  const personKey = opts.me.kind === "human" && opts.me.id !== PERSON ? actorKey({ kind: "human", id: PERSON }) : null;
  const schema = carton.schema;
  const describeCard = opts.describeCard ?? defaultDescribeCard;
  const actors = new Map<string, Actor>();
  const ui = (a: CoreActor | null | undefined): Actor => {
    const x = toUiActor(a, opts.me, myGroup);
    const known = actors.get(x.key);
    if (known && known.name === x.name && known.parent === x.parent) return known;
    actors.set(x.key, x);
    // A subagent's agent may never act itself: register it, so "Director › Explore" can be named.
    if (a?.kind === "subagent" && x.parent && !actors.has(x.parent)) {
      const agent = agentIdOf(a);
      actors.set(x.parent, { key: x.parent, kind: "agent", name: agent === "director" || agent.startsWith("director/") ? "Director" : agent, parent: actorKey(opts.me), isYou: x.isYou });
    }
    return x;
  };
  const me = ui(opts.me);
  const someone: Actor = { key: "system/someone", kind: "human", name: "Someone" };
  // Work started on its own (refreshes after events, summaries, checks), so settled() can wait for it.
  const inflight = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    const done = () => void inflight.delete(p);
    p.then(done, done);
    return p;
  };

  // ------------------------------------------------------------ history
  let cutId = carton.cut;
  // Oldest first, changed in place. The indexes are kept incrementally, so an append costs O(rows after it), not
  // O(History): a burst of confirmations on a 100k History stays cheap.
  const rows: Row[] = [];
  const named: number[] = [], turns: number[] = [];
  const pos = new Map<string, number>();
  let revision = 0;
  let disposed = false;
  let loadGen = 0;
  // Where rows changed at recent revisions, so the bridge re-reads only from there (firstChangedSince).
  const changeLog: { rev: number; from: number }[] = [];
  const changed = (from: number) => {
    revision++;
    changeLog.push({ rev: revision, from });
    if (changeLog.length > 128) changeLog.shift();
  };
  /** Re-index rows[start..] after they changed (removed rows' ids must already be out of `pos`). */
  const reindexFrom = (start: number, changedFrom = start) => {
    start = Math.max(0, Math.min(start, rows.length));
    while (named.length && named[named.length - 1]! >= start) named.pop();
    while (turns.length && turns[turns.length - 1]! >= start) turns.pop();
    for (let i = start; i < rows.length; i++) {
      const v = rows[i]!.v;
      pos.set(v.id, i);
      if (v.name) named.push(i);
      if (v.kind === "turn") turns.push(i);
    }
    changed(Math.min(changedFrom, rows.length));
  };

  const turnKeyOf = (a: CoreActor | null | undefined) => (a && a.kind !== "human" && a.turn ? `${a.chat ?? ""}/${a.turn}` : null);
  // Summaries survive object replacement (a turn row growing, a rename).
  const byId = new Map<string, { summary: string; details?: readonly string[] }>();
  // "Fold in the rest" (R2-9, R3-5, R4-2, R5-1..3). Per partial fold (its inverse change id):
  // - restInfo: what it set back, read once from history (immutable);
  // - restDecision: whether the head still holds those values (left out), valid until a change on its cut touches
  //   those records; found through restIndex (cut → record → partial folds), so a confirmation looks up only its own
  //   paths, never every decision;
  // - restGen: bumped on every invalidation; a read that started before it is discarded, so a slow read can't put back
  //   a decision a newer change made obsolete;
  // - seenSeq: the newest seq per cut whose change this view model saw; a head beyond it (another handle wrote, no
  //   event) invalidates that cut's decisions on the next refresh.
  const restDone = new Set<string>();
  const restInfo = new Map<string, { ops: Op[]; values: unknown[]; keys: string[] }>();
  const restDecision = new Map<string, boolean>();
  const restGen = new Map<string, number>();
  const restIndex = new Map<string, Map<string, Set<string>>>();
  const restCut = new Map<string, string>();
  const seenSeq = new Map<string, number>();
  // Only the current cut's own partial folds offer the rest: an inherited one (History shows the cut a fork came
  // from) would fold into that other cut (R3-2).
  const offersRest = (c: CoreVersion) => c.kind === "partial-revert" && !!c.change && c.ref.branchId === cutId && restDecision.get(c.change) === true && !restDone.has(c.change);

  const toVersion = (c: CoreVersion, kindOverride?: VersionKind, turnEdits?: number): Version => {
    const id = c.change ?? `${c.ref.branchId}@${c.ref.seq}`;
    const prev = byId.get(id);
    const kind = kindOverride ?? KIND[c.kind] ?? "edit";
    // A partial fold's inverse offers "Fold in the rest" once checkRest() found its left-out changes still left out.
    const rest = offersRest(c);
    return {
      id,
      seq: c.ref.seq,
      ref: `${c.ref.branchId}@${c.ref.seq}`,
      at: c.at,
      author: ui(c.author),
      kind,
      summary: prev?.summary ?? (c.kind === "root" ? "Started the cut" : c.kind === "fork" ? "Made this cut" : ""),
      ...(prev?.details ? { details: prev.details } : {}),
      ...(c.name ? { name: c.name } : {}),
      ...(kind === "turn" ? { turn: { label: c.name ?? "", edits: turnEdits ?? 1 } } : {}),
      ...(rest ? { foldRest: true } : {}),
    };
  };
  const sameShape = (v: Version, kind: VersionKind, edits: number) => v.kind === kind && (kind !== "turn" || v.turn?.edits === edits);

  /**
   * Group the confirmed rows of the newest turn after an append. Returns the lowest index it changed. Only the newest
   * group can change: an earlier turn's checkpoint and its edit count stay as they are (R2-7).
   */
  const regroupTail = (): number => {
    let i = rows.length - 1;
    while (i >= 0 && rows[i]!.v.provisional) i--;
    if (i < 0) return rows.length;
    const key = rows[i]!.turnKey;
    let j = i;
    if (key) while (j > 0 && rows[j - 1]!.turnKey === key) j--;
    let low = rows.length;
    for (let k = j; k <= i; k++) {
      const r = rows[k]!;
      if (!r.core) continue;
      const want: VersionKind = key && k === i ? "turn" : KIND[r.core.kind] ?? "edit";
      const edits = i - j + 1;
      if (!sameShape(r.v, want, edits)) {
        r.v = toVersion(r.core, want, edits);
        low = Math.min(low, k);
      }
    }
    return low;
  };

  const group = (all: readonly CoreVersion[], reuse: Map<string, Row>): Row[] => {
    const next: Row[] = [];
    let i = 0;
    while (i < all.length) {
      const key = turnKeyOf(all[i]!.author);
      let j = i;
      if (key) while (j + 1 < all.length && turnKeyOf(all[j + 1]!.author) === key) j++;
      for (let k = i; k <= j; k++) {
        const c = all[k]!;
        const kind: VersionKind = key && k === j ? "turn" : KIND[c.kind] ?? "edit";
        const old = reuse.get(c.change ?? `${c.ref.branchId}@${c.ref.seq}`);
        // An unchanged version keeps its object, so a refresh re-renders nothing and the bridge sends nothing.
        if (old?.core && sameCore(old.core, c) && sameShape(old.v, kind, j - i + 1) && !!old.v.foldRest === offersRest(c)) next.push(old);
        else next.push({ core: c, turnKey: key, v: toVersion(c, kind, j - i + 1) });
      }
      i = j + 1;
    }
    return next;
  };

  const loadHistory = async () => {
    const gen = ++loadGen;
    const cut = cutId;
    const page = opts.pageSize ?? 2000;
    const all: CoreVersion[] = [];
    let before: number | undefined;
    for (;;) {
      const got = await carton.log({ cut, limit: page, ...(before !== undefined ? { before } : {}) });
      all.push(...got);
      if (got.length < page) break;
      before = got[got.length - 1]!.ref.seq;
      if (before <= 0) break;
    }
    // A cut's History includes how it got there (as git log does): the versions of the cut it was made from, up to
    // the fork, and so on up the chain.
    let recs: CutRecord[] = [];
    try {
      recs = await carton.cuts();
    } catch {
      recs = [];
    }
    let fork = recs.find((c) => c.id === cut)?.forkOf ?? null;
    for (let depth = 0; fork && depth < 8; depth++) {
      const at = fork.lastIndexOf("@");
      const parent = fork.slice(0, at), seq = Number(fork.slice(at + 1));
      if (!recs.some((c) => c.id === parent)) break;
      all.push(...(await carton.log({ cut: parent, before: seq + 1 })));
      fork = recs.find((c) => c.id === parent)?.forkOf ?? null;
    }
    // A newer load, a cut switch or dispose happened while this one waited: its result is stale.
    if (gen !== loadGen || cut !== cutId || disposed) return;
    all.reverse();
    // Versions that arrived by event while this load waited are newer than what it read: keep them.
    const top = all.length ? all[all.length - 1]!.ref.seq : -1;
    for (const r of rows) if (r.core && r.core.ref.branchId === cut && r.core.ref.seq > top) all.push(r.core);
    const reuse = new Map<string, Row>();
    for (const r of rows) reuse.set(r.v.id, r);
    const next = group(all, reuse);
    // Provisional rows still waiting stay at the end.
    const confirmed = new Set(next.map((r) => r.v.id));
    for (const r of rows) if (r.v.provisional && !confirmed.has(r.v.id)) next.push(r);
    let first = 0;
    while (first < next.length && first < rows.length && next[first] === rows[first]) first++;
    if (first === next.length && next.length === rows.length) return; // nothing changed
    rows.length = 0;
    rows.push(...next);
    pos.clear();
    named.length = 0;
    turns.length = 0;
    reindexFrom(0, first);
    hub.notify("history");
  };

  const appendConfirmed = (c: CoreVersion) => {
    const id = c.change ?? `${c.ref.branchId}@${c.ref.seq}`;
    const at0 = pos.get(id);
    if (at0 !== undefined && rows[at0]!.core && rows[at0]!.core!.ref.seq === c.ref.seq && rows[at0]!.core!.ref.branchId === c.ref.branchId) return;
    let from = rows.length;
    // A provisional row with this id becomes the confirmed one, in its confirmed place; the id (row key) stays.
    if (at0 !== undefined && rows[at0]!.v.provisional) {
      rows.splice(at0, 1);
      pos.delete(id);
      from = at0;
    }
    let at = rows.length;
    while (at > 0 && rows[at - 1]!.v.provisional) at--;
    rows.splice(at, 0, { core: c, turnKey: turnKeyOf(c.author), v: toVersion(c) });
    from = Math.min(from, at, regroupTail());
    reindexFrom(from);
    hub.notify("history");
  };

  const dropProvisional = (id: string) => {
    const i = pos.get(id);
    if (i === undefined || !rows[i]!.v.provisional) return;
    rows.splice(i, 1);
    pos.delete(id);
    reindexFrom(i);
    hub.notify("history");
  };

  // Lazy summaries: describe() only the versions a list shows, a few at a time.
  const queue: string[] = [];
  const queued = new Set<string>();
  let running = 0;
  const wantSummary = (v: Version) => {
    if (v.summary || v.provisional || queued.has(v.id) || byId.has(v.id)) return;
    queued.add(v.id);
    queue.push(v.id);
    pump();
  };
  const pump = () => {
    while (running < (opts.describeConcurrency ?? 2) && queue.length) {
      const id = queue.pop()!; // newest asks first: the top of the list is what people read
      running++;
      void track(summarize(id)).finally(() => {
        running--;
        queued.delete(id);
        pump();
      });
    }
  };
  const summarize = async (id: string) => {
    const i = pos.get(id);
    const r = i === undefined ? undefined : rows[i];
    if (!r?.core || disposed) return;
    const seq = r.core.ref.seq;
    // Core describes the change against the state just before it (log({summary})): no whole-doc diff here.
    let line: string | undefined;
    try {
      if (seq > 0) line = (await carton.log({ cut: r.core.ref.branchId, before: seq + 1, limit: 1, summary: true }))[0]?.summary;
    } catch {
      line = undefined;
    }
    const summary = line ?? (r.v.kind === "fold" ? "Folded in" : r.v.kind === "undo" ? "Undid a change" : r.v.kind === "restore" ? "Restored a version" : "No visible change");
    byId.set(id, { summary });
    const j = pos.get(id);
    if (j === undefined || disposed) return;
    const row = rows[j]!;
    row.v = { ...row.v, summary };
    changed(j);
    hub.notify("history");
  };

  const view = (f: HistoryFilter) => (f === "named" ? named : f === "turns" ? turns : null);
  const history: HistorySource = {
    all: () => rows.map((r) => r.v),
    // The bridge reads only the rows from the first change on (R2-8): an append copies the tail, not History.
    slice: (from) => {
      const out: Version[] = [];
      for (let i = Math.max(0, from); i < rows.length; i++) out.push(rows[i]!.v);
      return out;
    },
    want: (ids) => {
      for (const id of ids) {
        const i = pos.get(id);
        if (i !== undefined) wantSummary(rows[i]!.v);
      }
    },
    firstChangedSince: (rev) => {
      if (rev >= revision) return rows.length;
      if (!changeLog.length || changeLog[0]!.rev > rev + 1) return 0;
      let m = rows.length;
      for (const c of changeLog) if (c.rev > rev) m = Math.min(m, c.from);
      return m;
    },
    revision: () => revision,
    count: (f) => (f === "all" ? rows.length : view(f)!.length),
    at: (f, i) => {
      const vw = view(f);
      const len = vw ? vw.length : rows.length;
      if (i < 0 || i >= len) return undefined;
      const r = rows[vw ? vw[len - 1 - i]! : len - 1 - i];
      if (r) wantSummary(r.v);
      return r?.v;
    },
    indexOf: (f, id) => {
      const p = pos.get(id);
      if (p === undefined) return -1;
      const vw = view(f);
      if (!vw) return rows.length - 1 - p;
      let lo = 0, hi = vw.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (vw[mid] === p) return vw.length - 1 - mid;
        if (vw[mid]! < p) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    },
  };

  // ------------------------------------------------------------ cuts, published, undo
  let cuts: readonly Cut[] = [];
  let records: CutRecord[] = [];
  let published: Published | null = null;
  let undo: UndoTurn | null = null;
  const heads = new Map<string, number>();

  const ownerName = (owner: string) => actors.get(owner)?.name ?? owner;
  const refreshCuts = async () => {
    records = await carton.cuts();
    const visible = records.filter((c) => c.kind !== "published");
    const nameCount = new Map<string, number>();
    for (const c of visible) nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1);
    const mine = new Set([opts.me.id, opts.me.name, actorKey(opts.me)].filter(Boolean) as string[]);
    const out: Cut[] = [];
    for (const c of visible) {
      const head = (await carton.log({ cut: c.id, limit: 1 }))[0];
      heads.set(c.id, head?.ref.seq ?? 0);
      const shared = (nameCount.get(c.name) ?? 0) > 1;
      const label = shared && !mine.has(c.owner) ? `${ownerName(c.owner)}'s ${c.name}` : c.name;
      const prev = cuts.find((x) => x.id === c.id);
      const next: Cut = {
        id: c.id,
        name: c.name,
        label,
        current: c.id === carton.cut,
        readOnly: !!c.tracking,
        kind: c.kind === "variant" ? "cut" : c.kind === "published" ? "cut" : c.kind,
        head: head ? `${c.id}@${head.ref.seq}` : `${c.id}@0`,
        updatedAt: head?.at ?? c.at ?? 0,
        shared: c.sequencer.kind !== "local",
      };
      out.push(prev && sameCut(prev, next) ? prev : next);
    }
    if (out.length !== cuts.length || out.some((c, i) => c !== cuts[i])) {
      cuts = out;
      hub.notify("cuts");
    }
    // The published cut: the newest publication; "newer edits" comes from core (and counts them when the source's
    // head is known).
    const pubs = (await carton.publications()).sort((a, b) => (b.cut.at ?? 0) - (a.cut.at ?? 0));
    const p = pubs[0];
    let next: Published | null = null;
    if (p) {
      const seq = Number(p.from.slice(p.from.lastIndexOf("@") + 1));
      const srcCut = records.find((c) => c.id === p.source);
      const i = pos.get(rows.find((r) => r.core?.ref.branchId === p.source && r.core.ref.seq === seq)?.v.id ?? "");
      const versionName = i === undefined ? undefined : rows[i]!.v.name;
      const url = opts.shareUrl?.(p.cut);
      const newerEdits = !p.newer ? 0 : Math.max(1, (heads.get(p.source) ?? seq) - seq);
      next = { cutId: p.source, cutName: srcCut?.name ?? p.cut.name, ref: p.from, at: p.cut.at ?? 0, newerEdits, ...(versionName ? { versionName } : {}), ...(url ? { url } : {}) };
    }
    if (!samePublished(published, next)) {
      published = next;
      hub.notify("published");
    }
  };

  const refreshUndo = async () => {
    let stack: UndoEntry[] = [];
    try {
      stack = await carton.undoStack(myGroup);
    } catch {
      stack = [];
    }
    const top = stack[0];
    let next: UndoTurn | null = null;
    if (top) {
      // An agent turn is undone as one (History.undo): count its entries.
      let edits = 1;
      if (top.author.turn) for (edits = 0; edits < stack.length && stack[edits]!.author.turn === top.author.turn; edits++);
      const label = top.label.replace(/^Undo\s+(?:[^:]+:\s*)?/, "");
      // a turn is the agent's, even when its newest edit was a subagent's: "Undo Director: tighter intro"
      const who = ui(top.author);
      const author = who.kind === "subagent" && top.author.turn && who.parent ? (actors.get(who.parent) ?? who) : who;
      next = { id: top.changeId, author, label, at: top.at, edits };
    }
    if (next?.id !== undo?.id || next?.edits !== undo?.edits || next?.label !== undo?.label) {
      undo = next;
      hub.notify("undo");
    }
  };

  // ------------------------------------------------------------ sync, presence, conflicts, preview
  let sync: SyncStatus = carton.sync ? mapSync(carton.sync.status, 0) : { kind: "local" };
  const peerMap = new Map<string, { peer: Peer; seen: number; ghosts: Ghost[]; on: string }>();
  let peers: readonly Peer[] = [];
  let ghosts: readonly Ghost[] = [];
  // Cards of every cut; the topic shows the current cut's. Each resolves on its own cut.
  const cardEntries = new Map<string, CardEntry>();
  let conflicts: readonly Conflict[] = [];
  let cardSeq = 0;
  const publishConflicts = () => {
    const next = [...cardEntries.values()].filter((e) => e.cut === cutId).map((e) => e.conflict).reverse();
    if (next.length !== conflicts.length || next.some((c, i) => c !== conflicts[i])) {
      conflicts = next;
      hub.notify("conflicts");
    }
  };
  let preview: Preview | null = null;

  const publishPeers = () => {
    const next = [...peerMap.values()].map((x) => x.peer);
    if (next.length !== peers.length || next.some((p, i) => p !== peers[i])) {
      peers = next;
      hub.notify("peers");
    }
  };
  // A peer's drags are ghosts only over the cut they are on; switching cuts recomputes them (R3-4).
  const publishGhosts = () => {
    const next = [...peerMap.values()].flatMap((x) => (x.on === cutId ? x.ghosts : []));
    if (!next.length && !ghosts.length) return;
    ghosts = next;
    hub.notify("ghosts");
  };
  const idleTimer = setInterval(() => {
    const now = clock();
    let any = false;
    for (const x of peerMap.values()) {
      const idle = now - x.seen > IDLE_MS;
      if (idle !== x.peer.idle) {
        x.peer = { ...x.peer, idle };
        any = true;
      }
    }
    if (any) publishPeers();
  }, 5_000);
  (idleTimer as { unref?: () => void }).unref?.();

  /**
   * Cards from commits, rebases (late conflicts) and undo: core merges `merge3(base, head, mine)`, so `ours` is the head
   * on screen and `theirs` is the person's own edit. Identical cards (same cut, path and values) are shown once;
   * a second conflict on the same field with other values is its own card.
   */
  const addCards = (list: readonly ConflictCard[], by: CoreActor | undefined, cut = cutId) => {
    const key = (onCut: string, c: ConflictCard) => `${onCut}|${c.path}|${canonicalish(c.ours)}|${canonicalish(c.theirs)}`;
    const seen = new Set([...cardEntries.values()].map((e) => key(e.cut, e.card)));
    for (const card of list) {
      if (seen.has(key(cut, card))) continue;
      seen.add(key(cut, card));
      const w = describeCard(card, schema);
      const id = `${cut}|${card.path}|${++cardSeq}`;
      cardEntries.set(id, {
        card,
        cut,
        mineSide: "theirs",
        conflict: {
          id,
          path: card.path,
          title: w.title,
          // describeCard words ours/theirs from core's point of view; here the person's edit is core's theirs.
          mine: { author: me, summary: w.theirs },
          theirs: { author: by ? ui(by) : someone, summary: w.mine },
          canKeepBoth: !!opts.keepBoth?.(card),
          ...(w.reason ? { reason: w.reason } : {}),
          provisional: "theirs",
          sig: cardSig(card),
        },
      });
      // A rebase's cards (an edit made offline meeting a teammate's) don't say whose edit is at head: Credits does
      if (!by) void nameOtherSide(id, card, cut);
    }
    publishConflicts();
  };
  const nameOtherSide = async (id: string, card: ConflictCard, cut: string) => {
    const segs = splitPathKey(card.path);
    const record = schema.collections[segs[0] ?? ""] ? segs.slice(0, 2) : segs.slice(0, 1);
    const who = await carton.credits(record, { cut }).catch(() => null);
    const e = cardEntries.get(id);
    if (!who || !e || disposed) return;
    e.conflict = { ...e.conflict, theirs: { ...e.conflict.theirs, author: ui(who) } };
    publishConflicts();
  };

  const onEvent = (e: CartonEvent) => {
    if (disposed) return;
    switch (e.type) {
      case "absorbed": {
        // A pending change a rebase emptied (head already had its effect, or cards took its place): no confirmation
        // will come, so its provisional row goes, and its cards are shown.
        if (e.branchId === cutId) dropProvisional(e.id);
        if (e.cards.length) addCards(e.cards, undefined, e.branchId);
        break;
      }
      case "change": {
        const c = e.change;
        // Partial-fold decisions follow every cut's changes, not only the current cut's (R5-1).
        const rev = Array.isArray(c.reverts) ? c.reverts : c.reverts ? [c.reverts] : [];
        for (const id of rev) markRestDone(id); // folding in the rest reverts the inverse: no longer offered
        touchRest(e.branchId, c.paths ?? [], !!c.intent?.maps || c.ops.some((op) => op.op === "remap"), e.seq);
        if (e.branchId !== cutId) {
          void track(refreshCuts()); // tracked: settled() waits for it too
          break;
        }
        appendConfirmed({ ref: { branchId: e.branchId, seq: e.seq, pending: [] }, hash: "", change: c.id, author: c.author, at: c.at, kind: c.kind ?? (c.mergeOf ? "merge" : "edit"), ...(c.name ? { name: c.name } : {}) });
        heads.set(e.branchId, e.seq);
        scheduleRefresh();
        break;
      }
      case "pending": {
        if (e.branchId !== cutId || pos.has(e.id)) break;
        rows.push({ core: null, turnKey: null, v: { id: e.id, seq: null, ref: `${PENDING_PREFIX}${e.id}`, at: clock(), author: me, kind: "edit", summary: "Your edit", provisional: true } });
        reindexFrom(rows.length - 1);
        hub.notify("history");
        break;
      }
      case "sync": {
        const next = mapSync(e.status, e.waiting);
        if (next.kind !== sync.kind || ("waiting" in next && "waiting" in sync && next.waiting !== sync.waiting)) {
          sync = next;
          hub.notify("sync");
        }
        break;
      }
      case "presence": {
        const key = actorKey(e.actor);
        if (key === actorKey(opts.me)) break;
        const state = e.state as { ghosts?: { item: string; track: string; start: number; end: number; label?: string }[]; activity?: string } | null;
        if (!state) {
          if (peerMap.delete(key)) {
            publishPeers();
            publishGhosts();
          }
          break;
        }
        const prev = peerMap.get(key);
        const actor = ui(e.actor);
        const activity = typeof state.activity === "string" ? state.activity : undefined;
        // Presence says which cut the peer is on; their drags are ghosts only over that cut's timeline.
        const on = e.branchId;
        const peer = prev && prev.peer.actor === actor && !prev.peer.idle && prev.peer.activity === activity && prev.peer.cutId === on ? prev.peer : { actor, cutId: on, idle: false, ...(activity ? { activity } : {}) };
        const g = (state.ghosts ?? []).map((x) => ({ actorKey: key, itemId: x.item, trackId: x.track, start: x.start, end: x.end, ...(x.label ? { label: x.label } : {}) }));
        peerMap.set(key, { peer, seen: clock(), ghosts: g, on });
        if (peer !== prev?.peer) publishPeers();
        if ((on === cutId && g.length) || (prev?.on === cutId && prev.ghosts.length)) publishGhosts();
        break;
      }
      case "notice": {
        const n = e.notice;
        if (n.cards?.length && (n.to === meKey || n.to === myGroup || n.to === personKey)) addCards(n.cards, n.by);
        break;
      }
      default:
        break;
    }
  };
  const off = carton.on(onEvent);

  const markRestDone = (changeId: string) => {
    if (restDone.has(changeId)) return;
    restDone.add(changeId);
    const i = pos.get(changeId);
    if (i === undefined || !rows[i]!.core) return;
    const r = rows[i]!;
    const { foldRest: _f, ...rest } = r.v;
    r.v = rest;
    changed(i);
    hub.notify("history");
  };

  /**
   * Is a partial fold's left-out part still left out? Its inverse set the rejected records back; if the head still
   * holds the inverse's values for any of them, the rest can be folded in. Derived from state, so it holds after a
   * restart, and foldRest() checks it again right before acting.
   */
  /** The record a path key belongs to (`items/a` for `items/a/#time`), or its root field. */
  const recordOf = (key: string) => {
    const segs = key.split("/");
    return schema.collections[segs[0]!] ? segs.slice(0, 2).join("/") : segs[0]!;
  };
  const infoFor = async (c: CoreVersion) => {
    let info = restInfo.get(c.change!);
    if (info) return info;
    const cut = c.ref.branchId, seq = c.ref.seq;
    const [inv, d] = await Promise.all([carton.checkout(`${cut}@${seq}`), carton.diff(`${cut}@${seq - 1}`, `${cut}@${seq}`)]);
    const ops = d.ops.filter((op) => op.op !== "remap");
    info = { ops, values: ops.map((op) => getIn(inv, op.path, schema)), keys: [...new Set(ops.map((op) => recordOf(pathKey(op.path))))] };
    restInfo.set(c.change!, info);
    restCut.set(c.change!, cut);
    let byRecord = restIndex.get(cut);
    if (!byRecord) restIndex.set(cut, (byRecord = new Map()));
    for (const k of info.keys) {
      let ids = byRecord.get(k);
      if (!ids) byRecord.set(k, (ids = new Set()));
      ids.add(c.change!);
    }
    return info;
  };
  /** Does the head still hold what the partial fold set back, for any of its records? */
  const leftOut = async (c: CoreVersion): Promise<boolean> => {
    const info = await infoFor(c);
    const head = (await carton.head(c.ref.branchId)).doc;
    return info.ops.some((op, k) => deepEqual(getIn(head, op.path, schema), info.values[k]));
  };
  const showRest = (change: string) => {
    const i = pos.get(change);
    if (i === undefined) return;
    const r = rows[i]!;
    const show = !!r.core && offersRest(r.core);
    if (!!r.v.foldRest === show) return;
    if (show) r.v = { ...r.v, foldRest: true };
    else {
      const { foldRest: _f, ...rest } = r.v;
      r.v = rest;
    }
    changed(i);
    hub.notify("history");
  };
  const invalidateRest = (id: string) => {
    restGen.set(id, (restGen.get(id) ?? 0) + 1);
    if (!restDecision.delete(id)) return;
    showRest(id);
  };
  const checkRest = async () => {
    // Only this cut's partial folds with no valid decision: usually none, so a refresh costs nothing here.
    const todo: CoreVersion[] = [];
    for (const r of rows) {
      const c = r.core;
      if (c?.change && c.kind === "partial-revert" && c.ref.branchId === cutId && !restDone.has(c.change) && !restDecision.has(c.change)) todo.push(c);
    }
    for (const c of todo) {
      const id = c.change!;
      const gen = restGen.get(id) ?? 0;
      const headAt = heads.get(c.ref.branchId);
      let left: boolean;
      try {
        left = await leftOut(c);
      } catch {
        continue; // a failed read is retried on the next refresh, never cached
      }
      if (disposed) return;
      if ((restGen.get(id) ?? 0) !== gen || restDone.has(id)) continue; // a change landed meanwhile: re-read later
      restDecision.set(id, left);
      // The read saw the head up to here: a later refresh re-checks only if the head moved past it unseen.
      if (headAt !== undefined) seenSeq.set(c.ref.branchId, Math.max(seenSeq.get(c.ref.branchId) ?? -1, headAt));
      showRest(id);
    }
  };
  /** A confirmed change on `cut`: invalidate the decisions of the partial folds whose records it touched. */
  const touchRest = (cut: string, paths: readonly string[], remap: boolean, seq: number) => {
    const before = seenSeq.get(cut);
    seenSeq.set(cut, Math.max(before ?? -1, seq));
    const byRecord = restIndex.get(cut);
    if (!byRecord) return;
    // A gap (changes this handle never got an event for, written by another handle) can have touched anything: every
    // decision on the cut is checked again. Only a contiguous run of seen changes may keep them.
    if (remap || (before !== undefined && seq > before + 1)) {
      // A ripple moves many records at once: every decision on the cut is checked again.
      for (const ids of byRecord.values()) for (const id of ids) invalidateRest(id);
      return;
    }
    for (const p of paths) {
      const ids = byRecord.get(recordOf(p));
      if (ids) for (const id of ids) invalidateRest(id);
    }
  };
  /** After a refresh: a cut whose head moved past what this view model saw (another handle wrote) is checked again. */
  const sweepRest = () => {
    for (const [cut, byRecord] of restIndex) {
      const head = heads.get(cut);
      if (head === undefined) continue;
      if (head > (seenSeq.get(cut) ?? -1)) for (const ids of byRecord.values()) for (const id of ids) invalidateRest(id);
      seenSeq.set(cut, head);
    }
  };

  // Refreshing cuts and undo after a burst of changes: once, after it settles.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Resolves the pending debounce's tracked promise; dispose() calls it too, so a settled() waiter never hangs.
  let refreshDone: (() => void) | null = null;
  const scheduleRefresh = () => {
    if (refreshTimer) return;
    // The debounce itself is tracked, so settled() waits through it rather than for a guessed time.
    void track(
      new Promise<void>((done) => {
        refreshDone = done;
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          refreshDone = null;
          Promise.allSettled([refreshCuts(), refreshUndo(), checkRest()]).then(() => done());
        }, 50);
      }),
    );
  };

  const refresh = async () => {
    if (carton.cut !== cutId) {
      cutId = carton.cut;
      publishConflicts();
      publishGhosts();
    }
    await loadHistory();
    await refreshCuts();
    await refreshUndo();
    sweepRest();
    await checkRest();
  };
  const ready = track(refresh());
  const poll = opts.pollMs ? setInterval(() => void track(refresh()), opts.pollMs) : null;
  (poll as { unref?: () => void } | null)?.unref?.();

  // ------------------------------------------------------------ reads
  const versionAt = (ref: string) => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.v.ref === ref) return rows[i]!.v;
    return undefined;
  };
  const diffCache = new Map<string, Promise<ShotDiff>>();
  const shotDiff = (a: string, b: string): Promise<ShotDiff> => {
    const key = `${a}|${b}`;
    let p = diffCache.get(key);
    if (!p) {
      p = (async () => {
        const [da, db] = await Promise.all([carton.checkout(a), carton.checkout(b)]);
        const intern = new Map<string, number>();
        const A = engine.shots(da, schema, intern), B = engine.shots(db, schema, intern);
        const matches = engine.lcs(A.map((s) => s.sig), B.map((s) => s.sig));
        const la = shotLabels(da, A, schema), lb = shotLabels(db, B, schema);
        const shot = (labels: (string | undefined)[]) => (s: CoreShot, i: number): Shot => ({ start: s.start, end: s.end, sig: s.sig, ...(labels[i] ? { label: labels[i]! } : {}) });
        return {
          a: A.map(shot(la)),
          b: B.map(shot(lb)),
          matches,
          aLabel: versionAt(a)?.name ?? a,
          bLabel: versionAt(b)?.name ?? (cuts.find((c) => c.head === b) ? "Current" : b),
        };
      })();
      diffCache.set(key, p);
      // Keep a few: Compare and Watch the changes ask for the same pair.
      if (diffCache.size > 4) diffCache.delete(diffCache.keys().next().value!);
      p.catch(() => diffCache.delete(key));
    }
    return p;
  };

  // Cards of the last fold plan, by path: the fold's choices and "Keep both" read the real cards, not placeholders.
  const planCards = new Map<string, ConflictCard>();
  const planKey = (from: string, into: string) => `${from}>${into}`;
  let planFor = "";

  // A fold card: yours is the cut you fold into, theirs the cut you fold in; each side says which.
  const toFoldConflict = (card: ConflictCard, theirs: Actor, intoCut?: string, fromCut?: string): Conflict => {
    const w = describeCard(card, schema);
    const where = (id?: string) => (id ? cuts.find((c) => c.id === id)?.label : undefined);
    const mineWhere = where(intoCut), theirWhere = where(fromCut);
    return {
      id: card.path,
      path: card.path,
      title: w.title,
      mine: { author: me, summary: w.mine, ...(mineWhere ? { where: mineWhere } : {}) },
      theirs: { author: theirs, summary: w.theirs, ...(theirWhere ? { where: theirWhere } : {}) },
      // Core's compare2 applies a {value} choice too (99db79c), so a §13 compare card can Keep both like any other.
      canKeepBoth: !!opts.keepBoth?.(card),
      ...(w.reason ? { reason: w.reason } : {}),
      provisional: "mine",
      sig: cardSig(card),
    };
  };

  const handle: CartonUiHandle = {
    hub,
    ready,
    subscribe: (topic, fn) => hub.subscribe(topic, fn),
    sync: () => sync,
    cuts: () => cuts,
    history: () => history,
    peers: () => peers,
    ghosts: () => ghosts,
    conflicts: () => conflicts,
    undoTurn: () => undo,
    published: () => published,
    preview: () => preview,
    me: () => me,
    actor: (key) => actors.get(key),

    async compare(a, b) {
      const [d, da, db] = await Promise.all([shotDiff(a, b), carton.checkout(a), carton.checkout(b)]);
      const measure = opts.measure ?? defaultMeasure;
      const side = (ref: string, doc: Doc, label: string) => {
        const v = versionAt(ref);
        const m = measure(doc, schema);
        return { label: v?.name ?? label, ref, at: v?.at ?? clock(), author: v?.author ?? me, clipCount: m.clips, length: m.length };
      };
      const c: Comparison = { a: side(a, da, d.aLabel), b: side(b, db, d.bLabel), diff: diffSummary(d) };
      return c;
    },

    async credits(itemId) {
      const tl = schema.timeline;
      const parts = opts.creditParts?.(itemId, schema) ?? [{ what: "Last change", path: [tl?.collection ?? "items", itemId] }];
      const lines = [];
      for (const p of parts) {
        const d = await carton.credits(p.path, { detail: true });
        if (d) lines.push({ what: p.what, author: ui(d.actor), ...(d.at != null ? { at: d.at } : {}), ...(d.change ? { versionId: d.change } : {}) });
      }
      const c: Credits = { clip: opts.clipName?.(itemId) ?? itemId, lines };
      return c;
    },

    shotDiff,

    async planFold(fromId, intoId, o) {
      const from = cuts.find((c) => c.id === fromId) ?? fallbackCut(fromId), into = cuts.find((c) => c.id === intoId) ?? fallbackCut(intoId);
      const r = await carton.fold(fromId, { into: intoId, check: true, ...(o?.allCards ? { missingBase: "all-cards" as const } : {}) });
      planCards.clear();
      planFor = planKey(fromId, intoId);
      const base = { from, into, changes: [] as FoldChange[], conflicts: [] as Conflict[], warnings: [] as string[] };
      if (r.status === "up-to-date") return base;
      if (r.status === "missing-base") return { ...base, missingBase: r.dialog.text };
      if (r.status === "rejected") throw new Error(r.reason);
      const cardList: ConflictCard[] = r.status === "conflicts" || r.status === "compare" ? r.cards : [];
      for (const c of cardList) planCards.set(c.path, c);
      const fromHead = (await carton.log({ cut: fromId, limit: 1 }))[0];
      const cardsOut = cardList.map((card) => toFoldConflict(card, ui(fromHead?.author), intoId, fromId));
      // §13 "every difference shown as a card": the cards are the whole plan, there is nothing else to leave out.
      if (r.status === "compare") return { ...base, conflicts: cardsOut, partial: false };
      const preview = r.preview;
      if (!preview) return { ...base, conflicts: cardsOut, partial: false };
      // One row per record the fold touches, so leaving one out (partial accept) is keyed by its record path.
      const intoDoc = (await carton.head(intoId)).doc;
      const groups = new Map<string, Op[]>();
      for (const op of preview.ops) {
        if (op.op === "remap") continue;
        const p = op.path;
        const key = schema.collections[String(p[0])] ? pathKey(p.slice(0, 2)) : pathKey(p.slice(0, 1));
        let g = groups.get(key);
        if (!g) groups.set(key, (g = []));
        g.push(op);
      }
      const changes: FoldChange[] = [];
      for (const [key, ops] of groups) {
        const words = engine.describe(ops, intoDoc, schema);
        const record = !!schema.collections[splitPathKey(key)[0]!];
        const who = record ? await carton.credits(splitPathKey(key), { cut: fromId, detail: true }) : null;
        changes.push({ id: key, summary: words.join("; ") || key, author: ui(who?.actor ?? fromHead?.author), at: who?.at ?? fromHead?.at ?? clock() });
      }
      // A remap (ripple) can't be left out on its own: it moves many records at once.
      const hasRemap = preview.ops.some((op) => op.op === "remap");
      return {
        ...base,
        changes,
        conflicts: cardsOut,
        warnings: preview.warnings.map((w) => String((w as { text?: unknown }).text ?? w.kind)),
        ...(hasRemap ? { partial: false } : {}),
      };
    },

    async switchCut(id) {
      await carton.switchTo(id);
      cutId = id;
      rows.length = 0;
      pos.clear();
      named.length = 0;
      turns.length = 0;
      reindexFrom(0);
      publishConflicts();
      publishGhosts();
      hub.notify("history");
      await refresh();
    },
    async newCut(name, fromRef) {
      const rec = await carton.fork(name, { from: fromRef });
      await handle.switchCut(rec.id);
      return cuts.find((c) => c.id === rec.id) ?? fallbackCut(rec.id);
    },
    async fold(fromId, intoId, o) {
      if (planFor !== planKey(fromId, intoId)) await handle.planFold(fromId, intoId, o.allCards ? { allCards: true } : undefined);
      const choiceFor = (path: string): Choice | undefined => {
        const ch = o.choices[path];
        if (!ch) return undefined;
        if (ch === "mine") return "ours";
        if (ch === "theirs") return "theirs";
        const card = planCards.get(path);
        return (card && opts.keepBoth?.(card)) || undefined;
      };
      // Core never decides a card the person didn't pick on (unseen cards come back as conflicts). A card whose
      // values changed since the plan (someone edited the same field again) is not the card that was reviewed: that
      // too stops the fold, before anything is committed, and comes back to pick on (R2-2).
      const seen = (card: ConflictCard) => {
        const was = planCards.get(card.path);
        return !!was && canonicalish(was.ours) === canonicalish(card.ours) && canonicalish(was.theirs) === canonicalish(card.theirs);
      };
      let stale = false;
      const choices = planCards.size
        ? (card: ConflictCard): Choice => {
            const c = choiceFor(card.path);
            if (c && seen(card)) return c;
            stale = true;
            throw new NewCards();
          }
        : undefined;
      const common = { into: intoId, ...(choices ? { choices } : {}), ...(o.allCards ? { missingBase: "all-cards" as const } : {}) };
      let r;
      try {
        r = o.leaveOut.length ? await carton.foldSome(fromId, { ...common, reject: [...o.leaveOut] }) : await carton.fold(fromId, common);
      } catch (e) {
        if (!(e instanceof NewCards) && !stale) throw e;
        r = null;
      }
      if (!r || r.status === "conflicts" || r.status === "compare") {
        // Show the plan as it is now: the dialog reloads it. The cards to pick on are those nobody picked, and those
        // whose values changed since they were picked (the pick was for another edit).
        const reviewed = new Map(planCards);
        const fresh = r && (r.status === "conflicts" || r.status === "compare") ? r.cards : null;
        await handle.planFold(fromId, intoId, o.allCards ? { allCards: true } : undefined);
        const cardsNow = fresh ?? [...planCards.values()];
        const unpicked = (c: ConflictCard) => {
          const was = reviewed.get(c.path);
          return !o.choices[c.path] || !was || canonicalish(was.ours) !== canonicalish(c.ours) || canonicalish(was.theirs) !== canonicalish(c.theirs);
        };
        return { ok: false, conflicts: cardsNow.filter(unpicked).map((c) => toFoldConflict(c, someone, intoId, fromId)) };
      }
      planFor = "";
      await refresh();
      if (r.status === "confirmed" || r.status === "pending" || r.status === "up-to-date") return { ok: true };
      if (r.status === "rejected") return { ok: false, error: r.reason };
      return { ok: false, error: r.dialog.text };
    },
    async resolve(id, choice) {
      const entry = cardEntries.get(id);
      if (!entry) return;
      // The other side is already on screen (head); only the person's own side needs a commit.
      if (choice !== "theirs") {
        const card = entry.card;
        let value: unknown = choice === "mine" ? card[entry.mineSide] : undefined;
        if (choice === "both") {
          const both = opts.keepBoth?.(card);
          if (!both) throw new Error("Keep both isn't possible for this card");
          value = typeof both === "object" && both && "value" in both ? both.value : card[entry.mineSide];
        }
        const r = await carton.commit({ cut: entry.cut, ops: cardOps(card, value), author: opts.me });
        if (r.status === "rejected") throw new Error(r.reason);
        if (r.status === "conflicts") addCards(r.cards, undefined, entry.cut);
      }
      cardEntries.delete(id);
      publishConflicts();
    },
    async foldRest(versionId) {
      const i = pos.get(versionId);
      const r = i === undefined ? undefined : rows[i];
      if (!r?.core?.change || !r.v.foldRest) return { ok: false, error: "Nothing left to fold in" };
      // Check again right before acting: the records may have changed since the flag was set. Like checkRest(), the
      // answer is kept only if no change landed while it was read.
      const id = r.core.change;
      const gen = restGen.get(id) ?? 0;
      if (!(await leftOut(r.core))) {
        if ((restGen.get(id) ?? 0) === gen) {
          restDecision.set(id, false);
          showRest(id);
        }
        return { ok: false, error: "Nothing left to fold in" };
      }
      if ((restGen.get(id) ?? 0) !== gen) return { ok: false, error: "Something changed. Try again." };
      const res = await carton.revert(r.core.change, { author: opts.me, cut: r.core.ref.branchId });
      if (res.status === "confirmed" || res.status === "pending") {
        markRestDone(r.core.change);
        return { ok: true };
      }
      if (res.status === "conflicts") {
        addCards(res.cards, undefined, r.core.ref.branchId);
        return { ok: false, conflicts };
      }
      return { ok: false, error: res.status === "rejected" ? res.reason : "Couldn't fold in the rest" };
    },
    async restore(ref) {
      if (ref.startsWith(PENDING_PREFIX)) throw new Error("This version is still waiting to sync");
      await carton.restore(ref, { author: opts.me });
    },
    async nameVersion(id, name) {
      const i = pos.get(id);
      const r = i === undefined ? undefined : rows[i];
      if (!r?.core) return;
      await carton.name(r.v.ref, name);
      const j = pos.get(id);
      if (j === undefined) return;
      const row = rows[j]!;
      row.core = { ...row.core!, name };
      row.v = { ...row.v, name, ...(row.v.turn ? { turn: { ...row.v.turn, label: name } } : {}) };
      reindexFrom(j);
      hub.notify("history");
    },
    async undo(turnId) {
      if (undo?.id !== turnId) return { ok: false, error: "Something changed. Try again." };
      const onCut = cutId;
      const r = await carton.undo(myGroup, { cut: onCut });
      await refreshUndo();
      if (r.status === "confirmed" || r.status === "pending") return { ok: true };
      if (r.status === "conflicts") {
        // The cards belong to the cut the undo ran on, even if the person switched cuts meanwhile (R2-1).
        addCards(r.cards, undefined, r.ref.branchId ?? onCut);
        return { ok: false, conflicts };
      }
      return { ok: false, error: r.status === "rejected" ? r.reason : "Couldn't undo" };
    },
    async publish(id) {
      const src = cuts.find((c) => c.id === id);
      await carton.publish({ from: src?.head ?? id, name: `${src?.name ?? "Cut"} (published)` });
      await refreshCuts();
    },
    openPreview(ref, label) {
      // A provisional version has no state to rebuild yet (L5): there is nothing to preview.
      if (ref?.startsWith(PENDING_PREFIX)) return;
      preview = ref ? { ref, label: label ?? ref } : null;
      hub.notify("preview");
      if (!opts.onPreview) return;
      if (!ref) opts.onPreview(null);
      else
        carton.preview(ref).then(
          (p) => preview?.ref === ref && opts.onPreview!({ ref, label: label ?? ref, doc: p.doc }),
          () => {
            // The state can't be rebuilt (expired pin, unknown ref): close the preview rather than show a wrong one.
            if (preview?.ref !== ref) return;
            preview = null;
            hub.notify("preview");
            opts.onPreview!(null);
          },
        );
    },
    blockEdit() {
      if (!preview || preview.blockedEdit) return;
      preview = { ...preview, blockedEdit: true };
      hub.notify("preview");
    },

    refresh: () => track(refresh()),
    reportConflicts: (list, by) => addCards(list, by),
    cardFor: <C extends ConflictCard = ConflictCard>(id: string) => (cardEntries.get(id)?.card ?? planCards.get(id)) as C | undefined,
    async settled() {
      // Work can start more work (a refresh schedules a check): wait until a pass finds nothing in flight.
      for (let i = 0; i < 1000 && inflight.size && !disposed; i++) await Promise.allSettled([...inflight]);
      await Promise.resolve();
    },
    dispose() {
      disposed = true;
      off();
      clearInterval(idleTimer);
      if (poll) clearInterval(poll);
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
      refreshDone?.();
      refreshDone = null;
    },
  };
  handle.renameCut = async (id, name) => {
    await carton.renameCut(id, name);
    await refreshCuts();
  };

  const fallbackCut = (id: string): Cut => ({ id, name: id, label: id, current: id === carton.cut, readOnly: false, kind: "cut", head: `${id}@0`, updatedAt: 0 });
  return handle;
}

/** Thrown inside core's fold when a card the person didn't pick on appears: aborts it before anything is committed. */
class NewCards extends Error {
  constructor() {
    super("new conflict cards");
  }
}

const cardSig = (c: ConflictCard) => `${canonicalish(c.ours)}|${canonicalish(c.theirs)}`;

const canonicalish = (v: unknown): string => {
  try {
    return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x)) ?? "undefined";
  } catch {
    return String(v);
  }
};

/**
 * Each shot's name: the topmost clip covering the whole shot (the last in document order), found in one sweep over
 * clips and shots sorted by start, with a heap of the clips that have started (O((clips + shots) log clips)).
 */
export function shotLabels(doc: Doc, shots: readonly { start: number; end: number }[], schema: Schema): (string | undefined)[] {
  const tl = schema.timeline;
  const out: (string | undefined)[] = new Array(shots.length).fill(undefined);
  if (!tl) return out;
  const items = (doc[tl.collection] as Rec[] | undefined) ?? [];
  const order = items.map((it, i) => ({ i, s: Number(it[tl.start]), e: Number(it[tl.end]) })).sort((a, b) => a.s - b.s);
  const shotOrder = shots.map((s, i) => ({ i, s: s.start, e: s.end })).sort((a, b) => a.s - b.s);
  // Max-heap by document index; a clip that ends before a shot's end can't cover any later shot either (shots are
  // contiguous and increasing), so it is dropped for good when it reaches the top.
  const heap: { i: number; e: number }[] = [];
  const up = (k: number) => {
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p]!.i >= heap[k]!.i) break;
      [heap[p], heap[k]] = [heap[k]!, heap[p]!];
      k = p;
    }
  };
  const down = (k: number) => {
    for (;;) {
      const l = 2 * k + 1, r = l + 1;
      let m = k;
      if (l < heap.length && heap[l]!.i > heap[m]!.i) m = l;
      if (r < heap.length && heap[r]!.i > heap[m]!.i) m = r;
      if (m === k) break;
      [heap[m], heap[k]] = [heap[k]!, heap[m]!];
      k = m;
    }
  };
  let c = 0;
  for (const s of shotOrder) {
    while (c < order.length && order[c]!.s <= s.s + 1e-6) {
      heap.push({ i: order[c]!.i, e: order[c]!.e });
      up(heap.length - 1);
      c++;
    }
    while (heap.length && heap[0]!.e < s.e - 1e-6) {
      heap[0] = heap[heap.length - 1]!;
      heap.pop();
      if (heap.length) down(0);
    }
    if (heap.length) {
      const it = items[heap[0]!.i]!;
      out[s.i] = schema.label?.(tl.collection, it) ?? (typeof it.name === "string" ? it.name : undefined);
    }
  }
  return out;
}

function mapSync(status: string, waiting: number): SyncStatus {
  if (status === "offline" || status === "stopped") return { kind: "offline", waiting };
  if (status === "up-to-date" && waiting === 0) return { kind: "upToDate" };
  return { kind: "syncing", waiting };
}

function sameCut(a: Cut, b: Cut): boolean {
  return a.name === b.name && a.label === b.label && a.current === b.current && a.readOnly === b.readOnly && a.kind === b.kind && a.head === b.head && a.updatedAt === b.updatedAt && a.shared === b.shared;
}

function samePublished(a: Published | null, b: Published | null): boolean {
  if (!a || !b) return a === b;
  return a.cutId === b.cutId && a.ref === b.ref && a.newerEdits === b.newerEdits && a.versionName === b.versionName && a.at === b.at && a.url === b.url;
}
