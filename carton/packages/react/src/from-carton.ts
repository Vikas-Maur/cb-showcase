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

import { actorKey, apply, betweenCuts, changeList, changeSummary, countChanges, deepEqual, describe, describeCard as coreDescribeCard, diff as docDiff, fork, getIn, groupOf, heldBy, lcs, merge3, namingDoc, pathKey, PERSON, shots as engineShots, splits } from "@carton/core";
import type {
  Actor as CoreActor,
  BroughtPlace as CoreBroughtPlace,
  BroughtRipple as CoreBroughtRipple,
  Carton,
  CartonEvent,
  ChangeRow,
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
import { cutColors } from "./cuts.ts";
import { TopicHub } from "./hub.ts";
import { itemFilter } from "./item-filter.ts";
import { cardSentences, conflictWords, type SideSentence } from "./conflict-words.ts";
import { clock as clockWords, versionLabel, versionShort } from "./format.ts";
import { actorLabel, firstName } from "./actors.ts";
import type {
  Actor,
  AlignEntry,
  BringBackChoice,
  BringBackPlace,
  BringBackRipple,
  CartonUi,
  Change,
  ClipKind,
  ClipVersions,
  Comparison,
  Conflict,
  ConflictChoice,
  Credits,
  Cut,
  FoldChange,
  FoldPlan,
  FoldResult,
  Ghost,
  FindHit,
  HistoryFilter,
  HistorySource,
  Landmark,
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
  Viewing,
  ViewTarget,
  Working,
} from "./model.ts";
import { diffSummary } from "./shots.ts";

export interface FromCartonOptions {
  /**
   * The local person. The handle doesn't expose its actor, and "you" needs it. A host whose GUI saves are recorded as
   * the generic person (`human/person`) may pass the resolved person here (`setIdentity`); give it the GUI saves' group
   * then (`me.group` or `group`), so Undo finds them. Every write the handle makes for the person (fold, fold some and
   * the rest, a new cut, naming a version, restore, undo, publish, a card's pick) is recorded as `me`, never as the
   * Carton's own actor: a host may open its Carton as another actor (Cardboard's worker opens it with the process's).
   */
  me: CoreActor;
  /** Your undo group (§8). Default: `me.group`, else your actor key. */
  group?: string;
  /** Engine functions (default: @carton/core's). Tests may pass lighter ones. */
  engine?: { shots: typeof engineShots; lcs: typeof lcs; describe: typeof describe };
  /** Clip count and length of a state (Compare card). Default: the schema's timeline collection and end field. */
  measure?: (doc: Doc, schema: Schema) => { clips: number; length: number; kinds?: { noun: string; n: number }[] };
  /** The parts of a clip Credits lists, as record paths. Default: the whole clip, "Last change". */
  creditParts?: (itemId: string, schema: Schema) => { what: string; path: readonly string[] }[];
  /** A clip's display name for Credits. Default: the item id. */
  clipName?: (itemId: string) => string;
  /**
   * Plain words for a card: `mine` words core's `ours` side, `theirs` core's `theirs`. `doc` is the cut's head, when
   * read (cards are worded at once without it, then again with it: it names the clip, its media and its track).
   * Default: core's describeCard (what each side did differently, with the schema's labels, never ids). Cardboard:
   * `@carton/cardboard`'s describeCardboardCard.
   */
  describeCard?: (card: ConflictCard, schema: Schema, doc?: Doc) => { title: string; mine: string; theirs: string; reason?: string; name?: string };
  /**
   * A field's value in the host's words for the change sentences (PLAN 0.2), as describeCard's `value` (Cardboard's
   * `cardboardValue`: volume "80%", speed "2×", a media by its file name). Default: core's words.
   */
  valueWords?: (key: string, value: unknown, doc: Doc | undefined) => string | undefined;
  /** What kind of clip a change is about (the change row's colour). Default: from the schema's `nounOf` and the record's `type`. */
  clipKind?: (row: ChangeRow, schema: Schema) => ClipKind;
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
  /**
   * Where landmark pictures are kept (Carton UX v2): the app stores a small JPEG per version (`Landmark.picture`, a key
   * per version). Without it the panel shows no pictures. `put` takes a `data:image/jpeg` URL (at most 64 KB).
   */
  pictures?: { get(key: string): Promise<string | null>; put(key: string, jpeg: string): Promise<void> };
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
  /**
   * An agent turn holding the timeline started (PLAN 0.7), or ended (null): the host knows (Cardboard's main process
   * sees an in-app turn start and end). `actors` are the ids its edits are recorded by (a Director turn's
   * `director/<chat>/<turn>`), so its versions count as its edits; `label` is its prompt.
   */
  setWorking(turn: { actor: CoreActor; label: string; since?: number; cut?: string; actors?: readonly string[] } | null): void;
  /** Resolves when the first load finished. */
  readonly ready: Promise<void>;
  /** Resolves when nothing is scheduled or running (refreshes, summaries, checks): for tests and hosts that wait. */
  settled(): Promise<void>;
  dispose(): void;
}

const IDLE_MS = 30_000;
const PENDING_PREFIX = "pending:";

/**
 * The change a write made (PLAN 5.3: what a toast's Undo takes back), or undefined when it made none: a commit that
 * found nothing to change (`empty`), a conflict, a refusal, a fold with nothing new. A shared cut's change waiting to
 * sync is the person's newest one already (Ctrl+Z takes it back), by its id.
 */
function madeBy(r: { status: string; change?: { id: string } | null; empty?: boolean; id?: string } | null | undefined): string | undefined {
  if (r?.status === "confirmed") return !r.empty && r.change?.id ? r.change.id : undefined;
  if (r?.status === "pending") return r.id;
  return undefined;
}
/** `made` for an action's answer: the versions it made on `cut`, oldest first; none: nothing to undo. */
const madeOn = (cut: string, ids: readonly (string | undefined)[], by?: "redo"): { made: { cut: string; changes: string[]; by?: "redo" } } | Record<string, never> => {
  const changes = ids.filter((x): x is string => typeof x === "string");
  return changes.length ? { made: { cut, changes, ...(by ? { by } : {}) } } : {};
};

/** Split a path key back into segments (`~1` → `/`, `~0` → `~`), the inverse of core's pathKey(). */
export function splitPathKey(key: string): string[] {
  return key.split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * The agent a subagent works for. The identity sources (`@carton/cardboard` parseActor, `@carton/local`) give a
 * subagent the agent's id plus `/sub-<type>-<id>` (§10: `director/<chat>/<turn>/sub-Explore-ab12`); an id without
 * that suffix is the agent's own (a subagent told apart by `agentId` only).
 */
const agentIdOf = (a: CoreActor): string => {
  const i = a.id.lastIndexOf("/sub-");
  return i > 0 ? a.id.slice(0, i) : a.id;
};

// Agents by their product name, from their id ("director/<chat>/<turn>", "claude-code/<session>", "codex/<name>",
// "claude-code@<host>"), never the machine or the terminal they ran in.
const PRODUCTS: Readonly<Record<string, string>> = { director: "Director", "claude-code": "Claude Code", codex: "Codex", gemini: "Gemini", cursor: "Cursor" };
function productName(a: CoreActor): string {
  const head = agentIdOf(a).split("/")[0]!.split("@")[0]!;
  const known = PRODUCTS[head] ?? (a.provider && head.startsWith(a.provider) ? PRODUCTS[a.provider] : undefined);
  if (known) return known;
  // a declared or unknown agent: its recorded name, without a chain, a terminal or a self-given label ("Aider (fix)")
  const n = (a.name ?? head).split(" › ")[0]!.replace(/ \(terminal\)$/, "").replace(/ \([^)]*\)$/, "").trim();
  return n || head;
}
/** "claude-opus-5-5" → "Opus 5.5"; any other model as given. */
export function modelWords(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  return m ? `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : model;
}
/**
 * The agent behind a view's saves, by its product name: an agent CLI known only by its environment (Claude Code with
 * CLAUDECODE=1 and no hook, Codex, Gemini, Cursor) prints its own view, and `@carton/local` credits that view's saves to
 * the view (`external:.scratch/views/<name>.tsx`: two of them on one machine stay apart) with the agent's `provider`.
 * Saves recorded before the provider was kept say it in their name ("Claude Code (view cc)"). Undefined for anything
 * else, a terminal user's view ("Terminal (view x)") included (regress 2026-11-02 #1: they read as "You").
 */
function viewAgent(a: CoreActor): string | undefined {
  if (a.kind !== "external" || !a.id.startsWith("external:.scratch/views/")) return undefined;
  if (a.provider) return PRODUCTS[a.provider];
  const n = (a.name ?? "").replace(/ \(view [^)]*\)$/, "");
  return Object.values(PRODUCTS).find((p) => p === n);
}
/**
 * Writers with no name of their own, on a person's machine: a terminal user (`terminal:<user>@<host>`), an outside
 * program's save (`external:project.json`), and the bridge's defaults before ui-words ("cli" for a `cb` with no actor,
 * "app" for the app's own writes). They are the person at that machine. An agent's view (viewAgent) is not.
 */
const isPersonsWriter = (a: CoreActor): boolean => (a.kind === "external" && !viewAgent(a)) || (a.kind === "agent" && (a.id === "cli" || a.id === "app" || a.id.startsWith("external:")));

/**
 * A UI actor from a core actor, named in words an editor knows: the person is "You" (a `cb` they typed included), a
 * teammate their name, an agent its product name, a subagent its agent's (its type kept for tooltips). Core tells an
 * agent's change with its `owner`, the person behind the replica that made it: someone else's agent gets them as its
 * parent ("Leo's Director"); with no owner known, an agent is yours when it is in your undo group. A system actor
 * (the cut's start) has no name. Keys follow core's actorKey(); a subagent's parent is its agent.
 */
export function toUiActor(a: CoreActor | null | undefined, me: CoreActor, myGroup: string): Actor {
  if (!a) return SYSTEM;
  const key = actorKey(a);
  if (a.kind === "system") return { key, kind: "system", name: "" };
  const meKey = actorKey(me);
  const owner = a.owner;
  const mine = owner ? me.kind === "human" && owner.id === me.id : groupOf(a) === myGroup;
  const ownerKey = owner && !mine ? actorKey({ kind: "human", id: owner.id }) : undefined;
  if (a.kind === "human" || isPersonsWriter(a)) {
    if (key === meKey || (a.kind !== "human" && mine)) return { key: meKey, kind: "human", name: me.name ?? "You", isYou: true };
    if (a.kind === "human") return { key, kind: "human", name: a.name ?? (a.id === PERSON ? "Teammate" : a.id) };
    return owner ? { key: ownerKey!, kind: "human", name: owner.name } : { key, kind: "human", name: "Teammate" };
  }
  const name = viewAgent(a) ?? productName(a);
  const model = modelWords(a.model);
  const parent = a.kind === "subagent" ? actorKey({ kind: "agent", id: agentIdOf(a) }) : mine ? meKey : ownerKey;
  return { key, kind: a.kind === "subagent" ? "subagent" : "agent", name, ...(parent ? { parent } : {}), ...(a.agentType ? { subagentType: a.agentType } : {}), ...(model ? { model } : {}), ...(mine ? { isYou: true } : {}) };
}
const SYSTEM: Actor = { key: "system/carton", kind: "system", name: "" };

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

/**
 * Generic plain words for a card (core's describeCard): the record's label (looked up in `doc` when given), and for each
 * side only what it did differently, with the schema's field labels and times as History words them; never ids.
 */
export function defaultDescribeCard(card: ConflictCard, schema: Schema, doc?: Doc): { title: string; mine: string; theirs: string; reason?: string; name?: string } {
  const w = coreDescribeCard(card, schema, doc);
  return { title: w.title, mine: w.ours, theirs: w.theirs, ...(w.name ? { name: w.name } : {}), ...(w.reason ? { reason: w.reason } : {}) };
}

/**
 * What kind of clip a change row is about (DESIGN §5.1's colours): a title, a caption or a code graphic by what the
 * host calls it (`nounOf`), else the record's type; anything that isn't a timeline item (a track, media, a project
 * field) is the project's.
 */
export function defaultClipKind(row: ChangeRow, schema: Schema): ClipKind {
  const tl = schema.timeline;
  if (!row.coll || !tl || row.coll !== tl.collection) return "project";
  const noun = row.rec ? schema.collections[row.coll]?.nounOf?.(row.rec) : undefined;
  if (noun === "title") return "title";
  if (noun === "caption") return "caption";
  if (noun && /code|shader|graphic/.test(noun)) return "code";
  const t = row.rec?.type;
  if (t === "audio" || t === "image" || t === "video") return t;
  if (t === "text") return "title";
  if (t === "caption") return "caption";
  if (t === "code" || t === "shader") return "code";
  return "video";
}

/** What a side of a card did, as a noun for the viewing label ("Claude Code's move of “Interview B”"). */
export function sideNoun(sentence: string): string {
  const v = /^(\w+)/.exec(sentence)?.[1]?.toLowerCase();
  return v === "moved" ? "move" : v === "trimmed" ? "trim" : v === "slipped" ? "slip" : v === "removed" ? "removal" : v === "added" ? "addition" : v === "set" ? "change" : "change";
}

/** Changes in timeline order: by where they are, the ones with no place last. */
const byPlace = (a: Change, b: Change) => (a.at ?? Infinity) - (b.at ?? Infinity) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
/** A node id (`cut@seq`) split, or null for any other ref. */
const nodeOf = (ref: string): { cut: string; seq: number } | null => {
  const m = /^([^\s~]+)@(\d+)$/.exec(ref);
  return m ? { cut: m[1]!, seq: Number(m[2]) } : null;
};

function defaultMeasure(doc: Doc, schema: Schema) {
  const tl = schema.timeline;
  if (!tl) return { clips: 0, length: 0 };
  const items = (doc[tl.collection] as Rec[] | undefined) ?? [];
  const nounOf = schema.collections[tl.collection]?.nounOf;
  let end = 0, clips = 0;
  // clips only; titles and the like by what they are (laptop re-check P3-10: "7 clips" for 1 clip and 6 titles)
  const kinds = new Map<string, number>();
  for (const it of items) {
    end = Math.max(end, Number(it[tl.end]) || 0);
    const noun = nounOf?.(it);
    if (noun) kinds.set(noun, (kinds.get(noun) ?? 0) + 1);
    else if (noun === undefined) clips++;
  }
  return { clips, length: end, ...(kinds.size ? { kinds: [...kinds].map(([noun, n]) => ({ noun, n })) } : {}) };
}

const KIND: Record<string, VersionKind> = { edit: "edit", merge: "fold", revert: "undo", undo: "undo", "partial-revert": "fold", restore: "restore", rebalance: "edit", import: "import", external: "edit", root: "edit", fork: "edit" };
// The rest of a partial fold is core's revert, and a fold to the person (final re-check P3-12b: it had the undo mark).
const kindOf = (c: CoreVersion): VersionKind => (c.restOf ? "fold" : KIND[c.kind] ?? "edit");

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
  a.ref.branchId === b.ref.branchId && a.ref.seq === b.ref.seq && a.change === b.change && a.name === b.name && a.kind === b.kind && a.restOf === b.restOf && a.at === b.at && actorKey(a.author) === actorKey(b.author);

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
  // This machine's own GUI saves, as core recorded them (the generic person): told as `me`. Only for what is known to be
  // this machine's (a local change, your undo group); log() and credits() already come resolved by core.
  // The project's import made by this handle is this person's too (core's log() tells it so; this is the live event).
  const own = (a: CoreActor): CoreActor => ((personKey !== null && a.kind === "human" && a.id === PERSON) || (a.kind === "system" && a.id === "import") ? opts.me : a);
  const schema = carton.schema;
  const describeCard = opts.describeCard ?? defaultDescribeCard;
  const actors = new Map<string, Actor>();
  const ui = (a: CoreActor | null | undefined): Actor => {
    const x = toUiActor(a, opts.me, myGroup);
    const known = actors.get(x.key);
    if (known && known.name === x.name && known.parent === x.parent && known.isYou === x.isYou) return known;
    actors.set(x.key, x);
    // Someone else's agent is named by its owner ("Leo's Director"): the owner core told is registered as a person.
    const owner = a?.owner;
    const ownerKey = owner && !x.isYou ? actorKey({ kind: "human", id: owner.id }) : undefined;
    if (owner && ownerKey && actors.get(ownerKey)?.name !== owner.name) actors.set(ownerKey, { key: ownerKey, kind: "human", name: owner.name });
    // A subagent's agent may never act itself: register it, so the subagent reads as its agent. Its parent is whoever
    // the subagent belongs to: you, its owner, or no one known (never you by default: a teammate's subagent isn't).
    if (a?.kind === "subagent" && x.parent && (!actors.has(x.parent) || (ownerKey && !actors.get(x.parent)!.parent))) {
      const parent = x.isYou ? actorKey(opts.me) : ownerKey;
      actors.set(x.parent, { key: x.parent, kind: "agent", name: x.name, ...(parent ? { parent } : {}), ...(x.isYou ? { isYou: true } : {}) });
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
  const named: number[] = [], turns: number[] = [], mine: number[] = [];
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
    while (mine.length && mine[mine.length - 1]! >= start) mine.pop();
    for (let i = start; i < rows.length; i++) {
      const v = rows[i]!.v;
      pos.set(v.id, i);
      // a person's named versions: an agent turn is named after its prompt (a turn, not a named version)
      if (v.name && v.kind !== "turn") named.push(i);
      if (v.kind === "turn") turns.push(i);
      if (v.author.kind === "human" && v.author.isYou) mine.push(i);
    }
    changed(Math.min(changedFrom, rows.length));
  };

  // A turn: a Director turn by its id; an agent with no turn id (your Claude Code in the app, Codex, a cb an agent ran) by
  // its run of versions, which a name ends: the app names an agent turn's last version from the prompt (laptop #8). So
  // Director and Claude Code turns are both checkpoints, and the turns filter lists every agent's (UI audit P1-10).
  const turnKeyOf = (a: CoreActor | null | undefined) =>
    !a || a.kind === "human" || a.kind === "system" || isPersonsWriter(a) ? null : a.turn ? `${a.chat ?? ""}/${a.turn}` : `run:${agentIdOf(a)}`;
  /** A named version ends a run (a turn without an id): the next version by the same agent starts the next turn. */
  const ends = (key: string, c: CoreVersion | null) => key.startsWith("run:") && !!c?.name;
  // Summaries survive object replacement (a turn row growing, a rename).
  // A version's own words, and, while it is a turn of several versions, the whole turn's (from `turn.base`): a row that
  // stops being its turn's (the turn went on) shows its own again.
  type Words = { summary: string; details?: readonly string[]; changes?: number; leftOut?: number; start?: "created" | "imported" };
  const byId = new Map<string, Words & { turn?: Words & { base: string } }>();
  /** A turn row's base when its changes are several versions' (they're then the whole turn's), else undefined. */
  const turnBase = (v: Pick<Version, "id" | "kind" | "base" | "ref" | "seq">) => {
    if (v.kind !== "turn" || !v.base) return undefined;
    const c = rows[pos.get(v.id) ?? -1]?.core;
    const own = c ? baseOf(c) : `${v.ref.slice(0, v.ref.lastIndexOf("@"))}@${(v.seq ?? 0) - 1}`;
    return v.base !== own ? v.base : undefined;
  };
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
  // A partial fold: its own version (core lists it as a merge with what it left out), or a partial revert on its own
  const partial = (c: CoreVersion) => c.kind === "partial-revert" || !!c.rejected;
  const offersRest = (c: CoreVersion) => partial(c) && !!c.change && c.ref.branchId === cutId && restDecision.get(c.change) === true && !restDone.has(c.change);

  // The ref a version's changes start from: the version before it (a fold-some's: before its fold); a turn's, before its
  // first version (PLAN 0.1: `changes(base, ref)` is what the row did)
  // (core says where a version's changes start when it isn't the seq before: a fold-some's, a compacted run's; review
  // of the UX data #5, #6)
  const startOf = (c: CoreVersion) => c.startsAt ?? c.ref.seq - (c.rejected ? 2 : 1);
  const baseOf = (c: CoreVersion, runStart?: CoreVersion): string | undefined => {
    const first = runStart ?? c;
    const s = startOf(first);
    return first.ref.seq > 0 && s >= 0 ? `${first.ref.branchId}@${s}` : undefined;
  };
  // An agent turn's versions share a key (PLAN 0.4): its turn and where it started
  const runOf = (c: CoreVersion, runStart?: CoreVersion): string | undefined => {
    const k = turnKeyOf(c.author);
    return k && runStart ? `${k}#${runStart.ref.branchId}@${runStart.ref.seq}` : undefined;
  };
  const toVersion = (c: CoreVersion, kindOverride?: VersionKind, turnEdits?: number, runStart?: CoreVersion): Version => {
    const id = c.change ?? `${c.ref.branchId}@${c.ref.seq}`;
    const prev = byId.get(id);
    const kind = kindOverride ?? kindOf(c);
    // A partial fold's inverse offers "Fold in the rest" once checkRest() found its left-out changes still left out.
    const rest = offersRest(c);
    // History's start (PLAN 0.4): the cut's root and the project's import are one "Project created" row (an import of a
    // project that had clips: "History starts here", once described)
    const start = prev?.start ?? (c.kind === "root" || c.kind === "import" ? "created" : undefined);
    const base = kind === "turn" ? baseOf(c, runStart) : baseOf(c);
    const run = runOf(c, runStart);
    // the whole turn's words while it is a turn of several versions from this base; else its own
    const tb = kind === "turn" && base && base !== baseOf(c) ? base : undefined;
    const w = tb ? (prev?.turn?.base === tb ? prev.turn : undefined) : prev;
    return {
      id,
      seq: c.ref.seq,
      ref: `${c.ref.branchId}@${c.ref.seq}`,
      at: c.at,
      author: ui(c.author),
      kind,
      // the root is described here; an import (which may be a project brought in) and a new cut's start once read
      summary: w?.summary ?? prev?.summary ?? (start ? "Project created" : c.kind === "fork" ? "Made this cut" : ""),
      ...(w?.details ? { details: w.details } : {}),
      ...(w?.changes !== undefined ? { changes: w.changes } : {}),
      ...(w?.leftOut ? { leftOut: w.leftOut } : {}),
      ...(base ? { base } : {}),
      ...(run ? { run } : {}),
      ...(start ? { start } : {}),
      ...(c.name ? { name: c.name } : {}),
      ...(kind === "turn" ? { turn: { label: c.name ?? "", edits: turnEdits ?? 1 } } : {}),
      ...(rest ? { foldRest: true } : {}),
      ...(c.blank ? { empty: true } : {}),
    };
  };
  const sameShape = (v: Version, kind: VersionKind, edits: number, c?: CoreVersion | null, runStart?: CoreVersion) =>
    v.kind === kind && (kind !== "turn" || v.turn?.edits === edits) && (!c || (v.run === runOf(c, runStart) && v.base === (kind === "turn" ? baseOf(c, runStart) : baseOf(c))));

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
    if (key) while (j > 0 && rows[j - 1]!.turnKey === key && !ends(key, rows[j - 1]!.core)) j--;
    let low = rows.length;
    const runStart = key ? (rows[j]!.core ?? undefined) : undefined;
    for (let k = j; k <= i; k++) {
      const r = rows[k]!;
      if (!r.core) continue;
      const want: VersionKind = key && k === i ? "turn" : kindOf(r.core);
      const edits = i - j + 1;
      if (!sameShape(r.v, want, edits, r.core, runStart)) {
        r.v = toVersion(r.core, want, edits, runStart);
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
      if (key) while (j + 1 < all.length && turnKeyOf(all[j + 1]!.author) === key && !ends(key, all[j]!)) j++;
      const runStart = key ? all[i]! : undefined;
      for (let k = i; k <= j; k++) {
        const c = all[k]!;
        const kind: VersionKind = key && k === j ? "turn" : kindOf(c);
        const old = reuse.get(c.change ?? `${c.ref.branchId}@${c.ref.seq}`);
        // An unchanged version keeps its object, so a refresh re-renders nothing and the bridge sends nothing.
        if (old?.core && sameCore(old.core, c) && sameShape(old.v, kind, j - i + 1, c, runStart) && !!old.v.foldRest === offersRest(c)) next.push(old);
        else next.push({ core: c, turnKey: key, v: toVersion(c, kind, j - i + 1, runStart) });
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
    mine.length = 0;
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

  /**
   * Group a run of one agent's versions again (its name changed: a name ends a turn without an id). Returns the lowest
   * index it changed.
   */
  const regroupAt = (j: number): number => {
    const key = rows[j]?.turnKey;
    if (!key?.startsWith("run:")) return rows.length;
    let a = j, b = j;
    while (a > 0 && rows[a - 1]!.core && rows[a - 1]!.turnKey === key) a--;
    while (b + 1 < rows.length && rows[b + 1]!.core && rows[b + 1]!.turnKey === key) b++;
    const span = rows.slice(a, b + 1);
    const next = group(span.map((r) => r.core!), new Map(span.map((r) => [r.v.id, r])));
    rows.splice(a, span.length, ...next);
    return a;
  };

  /** A confirmed row that is no version (the fold half of a fold-some, once its partial revert arrives). */
  const dropRow = (id: string): number => {
    const i = pos.get(id);
    if (i === undefined) return rows.length;
    rows.splice(i, 1);
    pos.delete(id);
    return i;
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
    if (v.provisional || queued.has(v.id)) return;
    const known = byId.get(v.id);
    if (known) {
      // described: unless it has since become a turn of several versions whose words aren't known yet (a turn whose
      // start moved too: review of the UX data #7)
      const tb = turnBase(v);
      if (!tb || known.turn?.base === tb) return;
    } else if (v.summary) {
      // an import and a new cut's start have words at once, said better once read (PLAN 0.2: "History starts here",
      // "Made this cut from Main cut at 12:20 pm")
      const k = rows[pos.get(v.id) ?? -1]?.core?.kind;
      if (k !== "import" && k !== "fork") return;
    }
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
    // Core describes the version against the state just before it (log({summary, rows})): no whole-doc diff here. Its
    // rows are every change it made, in the app's words (PLAN 0.1, 0.2); its title says what a fold, a restore or an
    // undo of one was. A version log() no longer lists (a fold-some's fold half) gets another's: ignored.
    let got: CoreVersion | undefined;
    try {
      got = seq > 0 ? (await carton.log({ cut: r.core.ref.branchId, before: seq + 1, limit: 1, summary: true, rows: true }))[0] : undefined;
      if (got?.ref.seq !== seq) got = undefined;
    } catch {
      got = undefined;
    }
    const w = await wordsFor(r, got);
    byId.set(id, w);
    const j = pos.get(id);
    if (j === undefined || disposed) return;
    const row = rows[j]!;
    const tb = turnBase(row.v);
    const { turn, ...own } = w;
    const shown = tb ? (turn?.base === tb ? turn : null) : own;
    if (!shown) return; // the row became another turn's meanwhile: it asks again
    const { base: _b, ...words } = shown as Words & { base?: string };
    row.v = { ...row.v, ...words };
    changed(j);
    hub.notify("history");
  };

  // "Only “clip”" (PLAN 0.8): the versions that touched a clip, from the per-version index (clipVersions)
  // asked again when versions are added or go, not when a row is described
  const lastConfirmed = () => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.core) return rows[i]!.v.id;
    return undefined;
  };
  const items = itemFilter({ ask: (item, o) => handle.clipVersions(item, o), pos: (id) => pos.get(id), structure: () => `${rows.length}|${lastConfirmed() ?? ""}`, newest: lastConfirmed, changed: () => hub.notify("history") });
  const view = (f: HistoryFilter) => (typeof f === "object" ? items.view(f.item) : f === "named" ? named : f === "turns" ? turns : f === "mine" ? mine : null);
  const history: HistorySource = {
    status: (f) => (typeof f === "object" ? items.status(f.item) : { loading: false }),
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

  // a teammate's cut by their first name ("Leo's Main cut"), never an id (design QA G27, G30)
  const ownerName = (owner: string) => firstName(actors.get(owner)?.name);
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
        // who made its newest version (the cuts menu's "Director · 2 h ago", PLAN 6.1)
        ...(head?.author ? { updatedBy: ui(head.author) } : {}),
      };
      out.push(next);
    }
    // Every cut but Main its colour dot (PLAN 6.1): your cuts in the order they were made, a teammate's its owner's
    const colors = cutColors(out, (id) => {
      const owner = visible.find((c) => c.id === id)?.owner;
      return owner && !mine.has(owner) ? ui({ kind: "human", id: owner }) : undefined;
    });
    for (let i = 0; i < out.length; i++) {
      const color = colors.get(out[i]!.id);
      const next = color ? { ...out[i]!, color } : out[i]!;
      const prev = cuts.find((x) => x.id === next.id);
      out[i] = prev && sameCut(prev, next) ? prev : next;
    }
    if (out.length !== cuts.length || out.some((c, i) => c !== cuts[i])) {
      cuts = out;
      hub.notify("cuts");
    }
    // The published cut: the newest publication; "newer edits" and their count come from core.
    const pubs = (await carton.publications()).sort((a, b) => (b.cut.at ?? 0) - (a.cut.at ?? 0));
    const p = pubs[0];
    let next: Published | null = null;
    if (p) {
      const seq = Number(p.from.slice(p.from.lastIndexOf("@") + 1));
      const srcCut = records.find((c) => c.id === p.source);
      const i = pos.get(rows.find((r) => r.core?.ref.branchId === p.source && r.core.ref.seq === seq)?.v.id ?? "");
      const versionName = i === undefined ? undefined : rows[i]!.v.name;
      const url = opts.shareUrl?.(p.cut);
      // core counts them as log() lists them: a withdraw row (H1) is no newer edit
      const newerEdits = !p.newer ? 0 : Math.max(1, p.versions);
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
      const who = ui(own(top.author));
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
  const peerMap = new Map<string, { peer: Peer; seen: number; ghosts: Ghost[]; on: string; said?: boolean }>();
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
  let viewing: Viewing | null = null;
  let viewGen = 0;
  let working: Working | null = null;
  // the turn behind `working`: the ids its edits are recorded by, and the records it changed so far
  let workingTurn: { actors: Set<string>; since: number; records: Set<string>; cut?: string } | null = null;
  // Viewing (PLAN 0.5) and the deprecated preview say the same thing: both topics fire
  const setViewing = (next: Viewing | null) => {
    viewing = next;
    preview = next ? { ref: next.ref, label: next.label, ...(next.blockedEdit ? { blockedEdit: true } : {}) } : null;
    hub.notify("viewing");
    hub.notify("preview");
  };

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
      const idle = !!x.said || now - x.seen > IDLE_MS;
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
  // The clip a card is about (a timeline record or a field of one), for "Show on timeline".
  const itemOf = (card: ConflictCard): { item?: string } => {
    const tl = schema.timeline;
    const segs = splitPathKey(card.path);
    return tl && segs[0] === tl.collection && segs[1] ? { item: segs[1] } : {};
  };
  // What each side did, as change sentences about the card's clip (DESIGN §8, conflict-words.ts): ConflictSide.text,
  // .did and .what, and Conflict.clip. `mineIs`: core's side holding the person's edit. `doc`: the cut's head, which
  // names the clip and its track (without it, a field card's clip is unknown until completeCards reads the head).
  const sentencesOf = (card: ConflictCard, mineIs: "ours" | "theirs", doc?: Doc): { clip?: string; mine: SideSentence; theirs: SideSentence } => {
    const s = cardSentences(card, schema, doc, opts.valueWords);
    return { ...(s.clip ? { clip: s.clip } : {}), mine: s[mineIs], theirs: s[mineIs === "ours" ? "theirs" : "ours"] };
  };
  const addCards = (list: readonly ConflictCard[], by: CoreActor | undefined, cut = cutId) => {
    const key = (onCut: string, c: ConflictCard) => `${onCut}|${c.path}|${canonicalish(c.ours)}|${canonicalish(c.theirs)}`;
    const seen = new Set([...cardEntries.values()].map((e) => key(e.cut, e.card)));
    const added: string[] = [];
    for (const card of list) {
      if (seen.has(key(cut, card))) continue;
      seen.add(key(cut, card));
      const w = describeCard(card, schema);
      const sw = sentencesOf(card, "theirs");
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
          mine: { author: me, summary: w.theirs, ...sw.mine },
          theirs: { author: by ? ui(by) : someone, summary: w.mine, ...sw.theirs },
          canKeepBoth: !!opts.keepBoth?.(card),
          ...(w.reason ? { reason: w.reason } : {}),
          provisional: "theirs",
          sig: cardSig(card),
          ...itemOf(card),
          ...((sw.clip ?? w.name) ? { clip: (sw.clip ?? w.name)! } : {}),
        },
      });
      added.push(id);
    }
    publishConflicts();
    if (added.length) void track(completeCards(added, cut, !by));
  };
  /**
   * Cards are worded at once, then again with the cut's head (read once for the batch): it names the clip, its media
   * and its track. A rebase's cards (an edit made offline meeting another) don't say whose edit is at head, or when:
   * Credits does (`nameOther`), so a card between two of your own edits can tell them apart (earlier, later).
   */
  const completeCards = async (ids: readonly string[], cut: string, nameOther: boolean) => {
    const doc = await carton.head(cut).then((h) => h.doc, () => undefined);
    for (const id of ids) {
      const first = cardEntries.get(id);
      if (!first || disposed) return;
      const segs = splitPathKey(first.card.path);
      const record = schema.collections[segs[0] ?? ""] ? segs.slice(0, 2) : segs.slice(0, 1);
      const who = nameOther ? await carton.credits(record, { cut, detail: true }).catch(() => null) : null;
      const e = cardEntries.get(id);
      if (!e || disposed) return;
      let c = e.conflict;
      if (doc) {
        const w = describeCard(e.card, schema, doc);
        const sw = sentencesOf(e.card, e.mineSide, doc);
        // describeCard words core's sides; the person's edit is core's theirs here
        const clip = sw.clip ?? w.name;
        if (w.title !== c.title || w.theirs !== c.mine.summary || w.mine !== c.theirs.summary || clip !== c.clip || sw.mine.text !== c.mine.text || sw.theirs.text !== c.theirs.text) {
          const { clip: _clip, ...rest } = c;
          c = { ...rest, title: w.title, mine: { ...c.mine, summary: w.theirs, ...sw.mine }, theirs: { ...c.theirs, summary: w.mine, ...sw.theirs }, ...(clip ? { clip } : {}) };
        }
      }
      if (who) c = { ...c, theirs: { ...c.theirs, author: ui(who.actor), ...(who.at != null ? { at: who.at } : {}) } };
      if (c !== e.conflict) {
        e.conflict = c;
        publishConflicts();
      }
    }
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
      // a landmark recorded (an export, a send), or a version that may be one (a name, a turn, a restore's Before)
      case "landmarks":
        hub.notify("landmarks");
        break;
      case "change": {
        hub.notify("landmarks");
        const c = e.change;
        // Partial-fold decisions follow every cut's changes, not only the current cut's (R5-1).
        const rev = Array.isArray(c.reverts) ? c.reverts : c.reverts ? [c.reverts] : [];
        for (const id of rev) markRestDone(id); // folding in the rest reverts the inverse: no longer offered
        touchRest(e.branchId, c.paths ?? [], !!c.intent?.maps || c.ops.some((op) => op.op === "remap"), e.seq);
        if (e.branchId !== cutId) {
          void track(refreshCuts()); // tracked: settled() waits for it too
          break;
        }
        // A fold-some's partial revert right after its fold: the two are one version, the partial revert's (UI audit
        // P1-3), as log() lists them. The fold's row goes.
        let some = false;
        if (c.kind === "partial-revert" && typeof c.reverts === "string") {
          const i = pos.get(c.reverts);
          const f = i === undefined ? undefined : rows[i]!.core;
          if (f && f.ref.branchId === e.branchId && f.ref.seq === e.seq - 1) {
            reindexFrom(dropRow(c.reverts));
            hub.notify("history");
            some = true;
          }
        }
        // A withdraw row (H1: a sent edit a rebase emptied, its id spent) moves the head but is no version: History
        // leaves it out, as log() does
        // "Fold in the rest" (a revert of a partial fold's inverse) is marked as log() marks it (`restOf`)
        const target = c.kind === "revert" && typeof c.reverts === "string" ? pos.get(c.reverts) : undefined;
        const restOf = target !== undefined && rows[target]!.core && partial(rows[target]!.core!) ? (c.reverts as string) : undefined;
        // an agent working (PLAN 0.7): the records its turn changed so far
        if (workingTurn && working && e.branchId === (workingTurn.cut ?? cutId) && c.at >= workingTurn.since - 1000 && (workingTurn.actors.has(c.author.id) || workingTurn.actors.has(agentIdOf(c.author)))) {
          const was = workingTurn.records.size;
          for (const p of c.paths ?? []) workingTurn.records.add(recordOf(p));
          if (workingTurn.records.size !== was) {
            working = { ...working, edits: workingTurn.records.size };
            hub.notify("working");
          }
        }
        // what an undo undid, and a redo's undo, as log() says them (undoTurnOf skips what is out already)
        const undoes = c.kind === "undo" && c.reverts ? [c.reverts].flat() : undefined;
        const redoOf = c.kind === "revert" && typeof c.reverts === "string" && rows[pos.get(c.reverts) ?? -1]?.core?.kind === "undo" ? c.reverts : undefined;
        if (!c.withdrawn) appendConfirmed({ ref: { branchId: e.branchId, seq: e.seq, pending: [] }, hash: "", change: c.id, author: e.local ? own(c.author) : c.author, at: c.at, kind: some ? "merge" : c.kind ?? (c.mergeOf ? "merge" : "edit"), ...(some ? { rejected: [...(c.rejected ?? [])], startsAt: e.seq - 2 } : {}), ...(c.name ? { name: c.name } : {}), ...(restOf ? { restOf } : {}), ...(undoes ? { undoes } : {}), ...(redoOf ? { redoOf } : {}) });
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
        const state = e.state as { ghosts?: { item: string; track: string; start: number; end: number; label?: string }[]; activity?: string; idle?: unknown; who?: { id?: unknown; name?: unknown } } | null;
        if (!state) {
          if (peerMap.delete(key)) {
            publishPeers();
            publishGhosts();
          }
          break;
        }
        const prev = peerMap.get(key);
        // The person behind the sender's handle, as the sync layer sends them (`who`: their account and name on the
        // host; the handle's own actor was fixed before the share), as live.js shows them in the Share panel. A
        // malformed `who` is no one: the handle's actor stays (UI audit P1-1).
        const who = state.who && typeof state.who.id === "string" && state.who.id ? { kind: "human" as const, id: state.who.id, ...(typeof state.who.name === "string" && state.who.name ? { name: state.who.name } : {}) } : null;
        const actor = ui(who ?? e.actor);
        const activity = typeof state.activity === "string" ? state.activity : undefined;
        // Presence says which cut the peer is on; their drags are ghosts only over that cut's timeline.
        const on = e.branchId;
        // a peer who says they're idle (here, no input for a while: UI audit P2-11) shows as idle at once
        const idle = state.idle === true;
        const peer = prev && prev.peer.actor === actor && prev.peer.idle === idle && prev.peer.activity === activity && prev.peer.cutId === on ? prev.peer : { actor, cutId: on, idle, ...(activity ? { activity } : {}) };
        // Ghosts are the teammate's own data, relayed as sent: only well-formed ones are drawn (UI audit P1-1).
        const g = (Array.isArray(state.ghosts) ? state.ghosts : []).filter((x) => x && typeof x.item === "string" && typeof x.track === "string" && Number.isFinite(x.start) && Number.isFinite(x.end)).map((x) => ({ actorKey: actor.key, itemId: x.item, trackId: x.track, start: x.start, end: x.end, ...(typeof x.label === "string" && x.label ? { label: x.label } : {}) }));
        peerMap.set(key, { peer, seen: clock(), ghosts: g, on, said: idle });
        if (peer !== prev?.peer) publishPeers();
        if ((on === cutId && g.length) || (prev?.on === cutId && prev.ghosts.length)) publishGhosts();
        break;
      }
      // A cut made (with no edit yet too), renamed or gone, by any process: the cut menu reads them again. A new cut
      // with no edit moves no head, so no `change` tells it (laptop re-check P3 #1: `cb cut new` never showed).
      case "cuts":
        scheduleRefresh();
        break;
      case "notice": {
        const n = e.notice;
        if (n.cards?.length && (n.to === meKey || n.to === myGroup || n.to === personKey)) addCards(n.cards, n.by, n.cut ?? cutId);
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
    // folded in, then its records changed again (an Undo of "Fold in the rest" leaves it out again, review #2): the
    // state decides again
    restDone.delete(id);
    if (!restDecision.delete(id)) return;
    showRest(id);
  };
  const checkRest = async () => {
    // Only this cut's partial folds with no valid decision: usually none, so a refresh costs nothing here.
    const todo: CoreVersion[] = [];
    for (const r of rows) {
      const c = r.core;
      if (c?.change && partial(c) && c.ref.branchId === cutId && !restDone.has(c.change) && !restDecision.has(c.change)) todo.push(c);
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
  // A version in words (PLAN 0.9): the current cut's head is "Your edit", another cut's head that cut's name ("Main
  // cut"), any other version its one label ("“Sent to client”", "Director's “Add captions…”", "Your edit from 12:41
  // pm"); never its ref (an id).
  const labelCtx = () => ({ now: clock(), actor: (k: string) => actors.get(k) });
  const refLabel = (ref: string): string => {
    const head = cuts.find((c) => c.head === ref);
    if (head) return head.current ? "Your edit" : head.label;
    const v = versionAt(ref);
    return v ? versionLabel(v, { ...labelCtx(), start: true }) : "An earlier version";
  };

  /**
   * A version of another cut in words (Carton UX v2, DESIGN-V2 §1.12: compare across cuts): its cut and its moment
   * ("“30s Instagram cut” at 12:20 pm"); its head is the cut's name, as `refLabel` says.
   */
  const refLabelOf = async (ref: string): Promise<string> => {
    const n = nodeOf(ref);
    if (!n || n.cut === cutId || cuts.some((c) => c.head === ref) || versionAt(ref)) return refLabel(ref);
    const v = (await carton.log({ cut: n.cut, before: n.seq + 1, limit: 1 }).catch(() => []))[0];
    return v && v.ref.seq === n.seq ? `${cutWords(n.cut)} at ${clockWords(v.at, { now: clock() })}` : refLabel(ref);
  };
  // ------------------------------------------------------------ change rows (PLAN 0.1, 0.2)
  const valueOpt = opts.valueWords ? { value: opts.valueWords } : {};
  const clipKindOf = (r: ChangeRow): ClipKind => (opts.clipKind ?? defaultClipKind)(r, schema);
  const tl = schema.timeline;
  const toChange = (r: ChangeRow, who?: { author: Actor; when: number }): Change => ({
    key: r.key,
    text: r.text,
    kind: r.kind,
    clip: clipKindOf(r),
    ...(tl && r.coll === tl.collection && r.id !== undefined ? { itemId: r.id } : {}),
    ...(r.at !== undefined ? { at: r.at } : {}),
    ...(r.end !== undefined ? { end: r.end } : {}),
    ...(who ? { author: who.author, when: who.when } : {}),
  });
  // A row of the Fold dialog as a change row (PLAN 6.3): its place in the edit, the kind of clip and what happened. A
  // row of several sentences (a record's own and its part's) takes the first's place and kind; the text is all of them.
  const foldRow = (key: string, list: readonly ChangeRow[]): { change?: Change } =>
    list[0] ? { change: { ...toChange(list[0]), key, text: list.map((x) => x.text).join("; ") } } : {};
  const notSent = () => new Error("Available once it's sent");
  // Every change from a to b, as core's change rows (a docDiff: one per change as countChanges counts it). Kept per
  // pair of versions (refs `cut@seq` name fixed states; a cut id moves with its head, so it isn't kept).
  const rowsCache = new Map<string, Promise<readonly ChangeRow[]>>();
  const rowsBetween = (a: string, b: string): Promise<readonly ChangeRow[]> => {
    const key = `${a}|${b}`;
    const hit = rowsCache.get(key);
    if (hit) return hit;
    const p = (async () => {
      if (a.startsWith(PENDING_PREFIX) || b.startsWith(PENDING_PREFIX)) throw notSent();
      const [da, db] = await Promise.all([carton.checkout(a), carton.checkout(b)]);
      return changeList(docDiff(da, db, schema), da, schema, valueOpt);
    })();
    if (nodeOf(a) && nodeOf(b)) {
      rowsCache.set(key, p);
      if (rowsCache.size > 16) rowsCache.delete(rowsCache.keys().next().value!);
      p.catch(() => rowsCache.delete(key));
    }
    return p;
  };
  /**
   * Who last changed each record between a and b (PLAN 0.1: author and when), from the per-version index (`touched`),
   * never a diff: when both are versions of one cut, a before b. Else nobody is named.
   */
  const whoChanged = async (a: string, b: string, keys: readonly string[]): Promise<Map<string, { author: Actor; when: number }>> => {
    const out = new Map<string, { author: Actor; when: number }>();
    const na = nodeOf(a), nb = nodeOf(b);
    if (!na || !nb || na.cut !== nb.cut || na.seq >= nb.seq || typeof carton.touched !== "function" || !keys.length) return out;
    const want = new Set(keys);
    const list = await carton.touched({ cut: na.cut, after: na.seq, upTo: nb.seq }).catch(() => []);
    for (let i = list.length - 1; i >= 0 && want.size; i--) {
      const t = list[i]!;
      for (const k of t.records) if (want.delete(k)) out.set(k, { author: ui(t.author), when: t.at });
    }
    return out;
  };
  const changeCache = new Map<string, Promise<readonly Change[]>>();
  const changesBetween = (a: string, b: string): Promise<readonly Change[]> => {
    const key = `${a}|${b}`;
    const hit = changeCache.get(key);
    if (hit) return hit;
    const p = (async () => {
      const list = await rowsBetween(a, b);
      const who = await whoChanged(a, b, list.map((r) => r.key));
      return list.map((r) => toChange(r, who.get(r.key))).sort(byPlace);
    })();
    if (nodeOf(a) && nodeOf(b)) {
      changeCache.set(key, p);
      if (changeCache.size > 16) changeCache.delete(changeCache.keys().next().value!);
      p.catch(() => changeCache.delete(key));
    }
    return p;
  };
  // ------------------------------------------------------------ Carton UX v2 (N0): two cuts, find, landmarks
  /** A cut's name in a sentence: Main cut as it is, any other in quotes ("“30s Instagram cut”"). */
  const cutWords = (id: string): string => {
    const c = cuts.find((x) => x.id === id), r = records.find((x) => x.id === id);
    const name = c?.label ?? r?.name ?? "another cut";
    return c?.kind === "main" || r?.kind === "main" ? name : `“${name}”`;
  };
  const cutOfRef = (ref: string): string => nodeOf(ref)?.cut ?? ref;
  /** Two cuts' differences (DESIGN-V2 §1.12): the same rows as `changes`, said as where a clip is. Cached per pair. */
  const cutsCache = new Map<string, Promise<readonly Change[]>>();
  const cutsBetween = (a: string, b: string): Promise<readonly Change[]> => {
    const key = `${a}|${b}`;
    const hit = cutsCache.get(key);
    if (hit) return hit;
    const p = (async () => {
      const [list, da, db] = await Promise.all([rowsBetween(a, b), carton.checkout(a), carton.checkout(b)]);
      const rb = cutOfRef(b);
      return betweenCuts(list, da, db, schema, { left: cutWords(cutOfRef(a)), right: cutWords(rb), here: rb === cutId }).map((r) => toChange(r)).sort(byPlace);
    })();
    if (nodeOf(a) && nodeOf(b)) {
      cutsCache.set(key, p);
      if (cutsCache.size > 16) cutsCache.delete(cutsCache.keys().next().value!);
      p.catch(() => cutsCache.delete(key));
    }
    return p;
  };
  /** The clip-by-clip match of two versions (DESIGN-V2 §1.15 `ui.align`), by identity. Cached per pair. */
  const alignCache = new Map<string, Promise<readonly AlignEntry[]>>();
  const align = (a: string, b: string): Promise<readonly AlignEntry[]> => {
    const key = `${a}|${b}`;
    const hit = alignCache.get(key);
    if (hit) return hit;
    const p = (async (): Promise<readonly AlignEntry[]> => {
      if (!tl) return [];
      const [da, db] = await Promise.all([carton.checkout(a), carton.checkout(b)]);
      const k = schema.collections[tl.collection]?.key ?? "id";
      const out = new Map<string, AlignEntry>();
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      for (const [d, side] of [[da, "a"], [db, "b"]] as const) {
        for (const r of (d[tl.collection] as Rec[] | undefined) ?? []) {
          const id = String(r[k]);
          const was = out.get(id);
          const name = schema.label?.(tl.collection, r, d);
          const start = num(r[tl.start]), end = num(r[tl.end]);
          out.set(id, {
            ...(was ?? { item: id }),
            ...(name && !was?.name ? { name } : {}),
            ...(side === "a" ? { ...(start !== undefined ? { aStart: start } : {}), ...(end !== undefined ? { aEnd: end } : {}) } : { ...(start !== undefined ? { bStart: start } : {}), ...(end !== undefined ? { bEnd: end } : {}) }),
            ...(typeof r[tl.lane] === "string" && (side === "b" || !was?.track) ? { track: r[tl.lane] as string } : {}),
          });
        }
      }
      const at = (e: AlignEntry) => e.bStart ?? e.aStart ?? 0;
      return [...out.values()].sort((x, y) => at(x) - at(y));
    })();
    if (nodeOf(a) && nodeOf(b)) {
      alignCache.set(key, p);
      if (alignCache.size > 8) alignCache.delete(alignCache.keys().next().value!);
      p.catch(() => alignCache.delete(key));
    }
    return p;
  };
  const rowIdOf = (change: string | null, ref: { branchId: string; seq: number }) => change ?? `${ref.branchId}@${ref.seq}`;
  /** Core's place and ripple (N0b) in the view model's terms: clips by their timeline ids, no paths. */
  const placeOf = (x: { place?: CoreBroughtPlace; ripple?: CoreBroughtRipple | null }): { place?: BringBackPlace; ripple?: BringBackRipple | null } => ({
    ...(x.place ? { place: { placed: x.place.placed, ...(x.place.track ? { trackId: x.place.track } : {}), ...(x.place.takenBy ? { takenBy: x.place.takenBy.map((t) => ({ itemId: itemOfRecord(t.record) ?? t.record, name: t.name })) } : {}) } } : {}),
    ...(x.ripple !== undefined ? { ripple: x.ripple ? { direction: x.ripple.direction, by: x.ripple.by, at: x.ripple.at, moved: x.ripple.moved } : null } : {}),
  });
  const itemOfRecord = (record: string | undefined): string | undefined => {
    if (!record || !tl) return undefined;
    const [c, id] = splitPathKey(record);
    return c === tl.collection ? id : undefined;
  };
  /** A row's own changes (the version card): a version's, as log() gives them; a turn's, all of it (from before its first version). */
  const changesInCache = new Map<string, Promise<readonly Change[]>>();
  const changesIn = (versionId: string): Promise<readonly Change[]> => {
    const i = pos.get(versionId);
    const r = i === undefined ? undefined : rows[i];
    if (!r) return Promise.resolve([]);
    if (r.v.provisional || !r.core) return Promise.reject(notSent());
    const key = `${versionId}|${r.v.ref}|${r.v.base ?? ""}`;
    const hit = changesInCache.get(key);
    if (hit) return hit;
    const v = r.v, c = r.core;
    const p = (async (): Promise<readonly Change[]> => {
      // a turn of several versions: what the whole turn changed, each change by whoever in it made it last
      const tb = turnBase(v);
      if (tb) return changesBetween(tb, v.ref);
      const got = c.ref.seq > 0 ? (await carton.log({ cut: c.ref.branchId, before: c.ref.seq + 1, limit: 1, summary: true, rows: true }))[0] : undefined;
      const list = got?.ref.seq === c.ref.seq ? (got.rows ?? []) : [];
      return list.map((x) => toChange(x, { author: v.author, when: v.at })).sort(byPlace);
    })();
    changesInCache.set(key, p);
    if (changesInCache.size > 32) changesInCache.delete(changesInCache.keys().next().value!);
    p.catch(() => changesInCache.delete(key));
    return p;
  };

  /**
   * A version in the app's words (PLAN 0.2), from what core gave (log's rows and title): what a fold, a restore, an undo
   * of either, a turn's undo, a new cut's start and History's start were; else its changes summed up.
   */
  const wordsFor = async (r: Row, got?: CoreVersion): Promise<Words & { turn?: Words & { base: string } }> => {
    const c = r.core!, v = r.v;
    const list: readonly ChangeRow[] = got?.rows ?? [];
    const t = got?.title;
    const at = (x: number) => clockWords(x, { now: clock() });
    const restored = (of?: string) => {
      const x = of ? versionAt(of) : undefined;
      return x?.name ? `“${x.name}”` : x ? `the ${at(x.at)} version` : "an earlier version";
    };
    const cutName = (n?: string) => (n ? `“${n}”` : "another copy");
    let summary: string | undefined, changes = list.length, leftOut: number | undefined, start = v.start;
    if (c.kind === "root") summary = "Project created";
    else if (c.kind === "import") {
      // a project that had clips when Carton started keeping it: its history starts here; a new one was created here
      start = list.some((x) => x.kind === "add" && !!tl && x.coll === tl.collection) ? "imported" : "created";
      summary = start === "imported" ? "History starts here" : "Project created";
    } else if (c.kind === "fork") {
      const rec = records.find((x) => x.id === c.ref.branchId);
      const from = rec?.forkOf ? nodeOf(rec.forkOf) : null;
      const parent = from ? records.find((x) => x.id === from.cut)?.name : undefined;
      const when = rec?.forkOf ? versionAt(rec.forkOf)?.at : undefined;
      summary = parent ? `Made this cut from ${parent}${when !== undefined ? ` at ${at(when)}` : ""}` : "Made this cut";
    } else if (t?.kind === "fold" || t?.kind === "rest") {
      summary = t.kind === "rest" ? `Folded in the rest of ${cutName(t.cut)}` : `Folded in ${cutName(t.cut)}`;
      if (t.taken !== undefined) changes = t.taken;
      if (t.taken !== undefined && t.total !== undefined && t.total > t.taken) leftOut = t.total - t.taken;
    } else if (t?.kind === "restore") summary = `Restored ${restored(t.of)}`;
    else if (t?.kind === "undo-restore" || t?.kind === "redo-restore") summary = `${t.kind === "undo-restore" ? "Undid" : "Redid"} the restore of ${restored(t.of)}`;
    else if (t?.kind === "undo-fold" || t?.kind === "redo-fold") summary = `${t.kind === "undo-fold" ? "Undid" : "Redid"} the fold of ${t.rest ? "the rest of " : ""}${cutName(t.cut)}`;
    else if (c.kind === "undo" && got?.undoes?.length) {
      // an agent turn taken out (undoTurnOf, `cb undo --turn`): named as the turn is
      const turn = turnOfChanges(got.undoes);
      if (turn) summary = `Took out ${versionLabel(turn, labelCtx())}`;
    }
    const fallback = v.kind === "fold" ? "Folded in" : v.kind === "undo" ? "Undid a change" : v.kind === "restore" ? "Restored an earlier version" : "No visible change";
    const own: Words = { summary: summary ?? (changeSummary(list, schema) || fallback), changes, ...(list.length > 1 ? { details: list.map((x) => x.text) } : {}), ...(leftOut ? { leftOut } : {}), ...(start ? { start } : {}) };
    // a turn of several versions: what the whole turn changed, from before its first version
    const tb = turnBase(v);
    if (!tb) return own;
    try {
      const all = await rowsBetween(tb, v.ref);
      return { ...own, turn: { base: tb, summary: changeSummary(all, schema) || own.summary, changes: all.length, ...(all.length > 1 ? { details: all.map((x) => x.text) } : {}) } };
    } catch {
      return own;
    }
  };
  /**
   * What a view target shows, labelled in one place (PLAN 0.5, DESIGN §8 "Viewing"), so the chip, the frame and the
   * row never disagree: a version ("Director's “Add captions…”"), how it was before one ("Before …"), a card's side
   * ("Claude Code's move of “Interview B”"), a teammate's cut ("Leo's Main cut").
   */
  const viewingOf = async (target: ViewTarget): Promise<Viewing> => {
    const failed = () => new Error("Couldn't load this version. Try again.");
    const ctx = labelCtx();
    if (target.kind === "cut") {
      const c = cuts.find((x) => x.id === target.cutId);
      if (!c) throw failed();
      const rec = records.find((x) => x.id === c.id);
      const mine = new Set([opts.me.id, opts.me.name, actorKey(opts.me)].filter(Boolean) as string[]);
      const label = rec?.owner && !mine.has(rec.owner) && c.readOnly ? `${ownerName(rec.owner)}'s ${c.name}` : c.label;
      return { ref: c.head, kind: "cut", cutId: c.id, label, short: label };
    }
    if (target.kind === "conflict") {
      const e = cardEntries.get(target.conflictId);
      const ref = e && handle.conflictRef ? await handle.conflictRef(target.conflictId, target.side) : null;
      if (!e || !ref) throw failed();
      // the card's own words for its side (conflict-words.ts): the card, the chip, the frame and the toast say the same
      // ("Claude Code's move of “Interview B”", "Your earlier change to “Summer launch”", "Director's aspect ratio")
      const label = conflictWords(e.conflict, (a) => actorLabel(a, (k) => actors.get(k), "You")).label[target.side];
      return { ref, kind: "conflict", conflictId: target.conflictId, side: target.side, label, short: label };
    }
    const r = target.versionId !== undefined ? rows[pos.get(target.versionId) ?? -1] : undefined;
    const v = r?.v ?? (target.ref !== undefined ? versionAt(target.ref) : undefined);
    if (v?.provisional) throw notSent();
    if (target.kind === "before") {
      const ref = target.ref ?? v?.base;
      if (!ref) throw failed();
      const of = v ? versionLabel(v, ctx) : (target.label ?? "this version");
      return { ref, kind: "before", ...(v ? { versionId: v.id } : {}), label: `Before ${of}`, short: v ? `Before · ${versionShort(v, ctx)}` : `Before ${of}` };
    }
    const ref = v?.ref ?? target.ref;
    if (!ref) throw failed();
    if (v) return { ref, kind: "version", versionId: v.id, label: versionLabel(v, { ...ctx, start: true }), short: versionShort(v, ctx) };
    const label = target.label ?? "An earlier version";
    return { ref, kind: "version", label, short: label };
  };
  const actorLabelOf = (a: Actor) => (a.isYou && a.kind === "human" ? "Your" : actorLabel(a, (k) => actors.get(k), "You"));
  /** The turn row whose versions these changes are (an undo of a whole turn), or undefined. */
  const turnOfChanges = (ids: readonly string[]): Version | undefined => {
    let run: string | undefined;
    for (const id of ids) {
      const i = pos.get(id) ?? pos.get(id.endsWith(".inverse") ? id : `${id}.inverse`);
      const r = i === undefined ? undefined : rows[i];
      if (!r?.v.run || (run !== undefined && r.v.run !== run)) return undefined;
      run = r.v.run;
    }
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.v.run === run && rows[i]!.v.kind === "turn") return rows[i]!.v;
    return undefined;
  };
  // How many changes from one state to another, counted one way everywhere (core's countChanges: a record each, a split
  // one; laptop re-check P3-11); undefined when it can't be told
  const countOf = (da: Doc, db: Doc): number | undefined => {
    try {
      return countChanges(docDiff(da, db, schema), da, schema);
    } catch {
      return undefined;
    }
  };
  const diffCache = new Map<string, Promise<ShotDiff>>();
  const shotDiff = (a: string, b: string): Promise<ShotDiff> => {
    const key = `${a}|${b}`;
    let p = diffCache.get(key);
    if (!p) {
      p = (async () => {
        const [da, db] = await Promise.all([carton.checkout(a), carton.checkout(b)]);
        const changes = countOf(da, db);
        const intern = new Map<string, number>();
        const A = engine.shots(da, schema, intern), B = engine.shots(db, schema, intern);
        const matches = engine.lcs(A.map((s) => s.sig), B.map((s) => s.sig));
        const la = shotLabels(da, A, schema), lb = shotLabels(db, B, schema);
        const shot = (labels: (string | undefined)[]) => (s: CoreShot, i: number): Shot => ({ start: s.start, end: s.end, sig: s.sig, ...(labels[i] ? { label: labels[i]! } : {}) });
        return {
          a: A.map(shot(la)),
          b: B.map(shot(lb)),
          matches,
          // a version by its name or what it did, never its ref (an id)
          aLabel: await refLabelOf(a),
          bLabel: await refLabelOf(b),
          ...(changes === undefined ? {} : { changes }),
        };
      })();
      diffCache.set(key, p);
      // Keep a few: Compare and WatchTheChanges ask for the same pair.
      if (diffCache.size > 4) diffCache.delete(diffCache.keys().next().value!);
      p.catch(() => diffCache.delete(key));
    }
    return p;
  };

  /**
   * How a fold's two cuts are related, for the dialog's line (PLAN 6.3): one made from the other (its fork point is on
   * the other's line), when. Read from the cuts as last listed; nothing when neither was made from the other.
   */
  const madeOf = (fromId: string, intoId: string): { made?: FoldPlan["made"] } => {
    const rec = (id: string) => records.find((c) => c.id === id);
    const forkedFrom = (id: string) => rec(id)?.forkOf?.slice(0, rec(id)!.forkOf!.lastIndexOf("@"));
    const f = rec(fromId), i = rec(intoId);
    if (f?.at != null && forkedFrom(fromId) === intoId) return { made: { which: "from", at: f.at } };
    if (i?.at != null && forkedFrom(intoId) === fromId) return { made: { which: "into", at: i.at } };
    return {};
  };

  // Cards of the last fold plan, by path: the fold's choices and "Keep both" read the real cards, not placeholders.
  const planCards = new Map<string, ConflictCard>();
  // What earlier partial folds of the plan's cut left out (UI audit P1-4): each partial fold's inverse change → its rows.
  // `ops`: what folding in those rows does (a record changed on the cut since isn't offered, review #1); `whole`: they
  // are all its records, so it folds in as "Fold in the rest" (a revert of its inverse) rather than as those ops.
  const planRest = new Map<string, { ids: string[]; ops: Op[]; whole: boolean }>();
  // Whether the plan had anything new to fold in (changes or cards), beyond what was left out earlier.
  let planNew = false;
  // A row of the plan that stands for more than its own record (a split clip: the removed clip and its parts) → the
  // other records' keys, left out with it.
  const planJoined = new Map<string, string[]>();
  const planKey = (from: string, into: string) => `${from}>${into}`;
  let planFor = "";
  // Which plan is the newest (planFold): only it writes the plan state above.
  let planGen = 0;

  // A fold card: yours is the cut you fold into, theirs the cut you fold in; each side says which.
  const toFoldConflict = (card: ConflictCard, theirs: Actor, intoCut?: string, fromCut?: string, doc?: Doc): Conflict => {
    const w = describeCard(card, schema, doc);
    const sw = sentencesOf(card, "ours", doc);
    const where = (id?: string) => (id ? cuts.find((c) => c.id === id)?.label : undefined);
    const mineWhere = where(intoCut), theirWhere = where(fromCut);
    return {
      id: card.path,
      path: card.path,
      title: w.title,
      mine: { author: me, summary: w.mine, ...sw.mine, ...(mineWhere ? { where: mineWhere } : {}) },
      theirs: { author: theirs, summary: w.theirs, ...sw.theirs, ...(theirWhere ? { where: theirWhere } : {}) },
      // Core's compare2 applies a {value} choice too (99db79c), so a §13 compare card can Keep both like any other.
      canKeepBoth: !!opts.keepBoth?.(card),
      ...(w.reason ? { reason: w.reason } : {}),
      provisional: "mine",
      sig: cardSig(card),
      ...itemOf(card),
      ...((sw.clip ?? w.name) ? { clip: (sw.clip ?? w.name)! } : {}),
    };
  };

  /**
   * A split clip in a list of changes by record (the Fold dialog) is one change: its parts' ops join the removed clip's
   * row (which keeps that record's key; `joined` gets the parts' keys, left out with it), so it is worded as the split
   * ("Split 'clip.mp4' at 4.0 s"). Returns, per joined row, the record to credit it to: the first part, which whoever
   * split it made.
   */
  /** A fold's ops by record (`items/c1`), root fields by name: one row of the Fold dialog each. */
  const byRecord = (ops: readonly Op[]) => {
    const groups = new Map<string, Op[]>();
    for (const op of ops) {
      if (op.op === "remap") continue;
      const p = op.path;
      const key = schema.collections[String(p[0])] ? pathKey(p.slice(0, 2)) : pathKey(p.slice(0, 1));
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(op);
    }
    return groups;
  };
  // Both cuts' heads as a plan saw them: a split row left out is checked against the cuts as they are at the fold.
  const headsOf = async (fromId: string, intoId: string) => (await Promise.all([fromId, intoId].map(async (cut) => (await carton.log({ cut, limit: 1 }))[0]?.ref.seq ?? 0))).join("|");
  let planHeads = "";
  const joinSplits = (groups: Map<string, Op[]>, ops: readonly Op[], doc: Doc, joined?: Map<string, string[]>) => {
    const creditOf = new Map<string, string>();
    const rowOf = new Map<string, string>();
    for (const sp of splits(ops, doc, schema)) {
      const key = pathKey([sp.collection, sp.removed]), parts = sp.parts.map((id) => pathKey([sp.collection, id]));
      if (!groups.has(key) || parts.some((k) => !groups.has(k))) continue;
      for (const k of parts) groups.get(key)!.push(...groups.get(k)!), groups.delete(k), rowOf.set(k, key);
      joined?.set(key, parts);
      creditOf.set(key, parts[0]!);
    }
    // A title's own media entry with it (core's heldBy) is one row with the title, as History and the counts tell it,
    // and is left out with it (laptop, merge/prod-2 N-1; regress prod3 P3-C). A title joined into a split's row takes
    // its entry there.
    for (const { part, holder } of heldBy(ops, doc, schema)) {
      const k = pathKey(part), h = pathKey(holder), row = rowOf.get(h) ?? h;
      if (!groups.has(k) || !groups.has(row)) continue;
      groups.get(row)!.push(...groups.get(k)!);
      groups.delete(k);
      joined?.set(row, [...(joined.get(row) ?? []), k]);
    }
    return creditOf;
  };

  /**
   * What earlier partial folds of `fromId` into `intoId` left out and is still left out (core's leftOut), one row per
   * record, marked with its partial fold (`leftOut`): its rows fold in together. Each row says what folding it in does
   * (described from the partial fold's state) and who made it on `fromId`. Read only while planning a fold.
   */
  const leftOutRows = async (fromId: string, intoId: string, rests: Map<string, { ids: string[]; ops: Op[]; whole: boolean }>): Promise<FoldChange[]> => {
    const list = (await carton.leftOut?.(fromId, { into: intoId }).catch(() => [])) ?? [];
    const out: FoldChange[] = [];
    if (!list.length) return out;
    const head = (await carton.head(intoId)).doc;
    for (const p of list) {
      const at = `${intoId}@${p.ref.seq}`;
      const [doc, d] = await Promise.all([carton.checkout(at), carton.diff(at, `${intoId}@${p.ref.seq - 1}`)]);
      const groups = new Map<string, Op[]>();
      let whole = true;
      for (const op of d.ops) {
        if (op.op === "remap") continue;
        // still left out: the head holds what the partial fold set back (a record changed since isn't offered)
        if (!deepEqual(getIn(head, op.path, schema), getIn(doc, op.path, schema))) {
          whole = false;
          continue;
        }
        const key = recordOf(pathKey(op.path));
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(op);
      }
      // a split left out is one row, as it was in the plan (all of a partial fold's rows fold in together anyway)
      const creditOf = joinSplits(groups, d.ops, doc);
      const names = namingDoc(doc, d.ops, schema); // once for all its rows
      const ids: string[] = [];
      for (const [key, ops] of groups) {
        const record = !!schema.collections[splitPathKey(key)[0]!];
        const who = record ? await carton.credits(splitPathKey(creditOf.get(key) ?? key), { cut: fromId, detail: true }).catch(() => null) : null;
        const id = `left:${p.change}:${key}`;
        ids.push(id);
        const list = changeList(ops, doc, schema, { names, ...valueOpt });
        out.push({ id, summary: list.map((x) => x.text).join("; ") || key, author: ui(who?.actor ?? p.author), at: who?.at ?? p.at, leftOut: p.change, leftOutAt: p.at, ...foldRow(id, list) });
      }
      if (ids.length) rests.set(p.change, { ids, ops: [...groups.values()].flat(), whole });
    }
    return out;
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
    viewing: () => viewing,
    working: () => working,
    me: () => me,
    actor: (key) => actors.get(key),

    changes: (a, b, o) => (o?.between === "cuts" ? cutsBetween(a, b) : changesBetween(a, b)),
    changesIn: (versionId) => changesIn(versionId),
    async undoTurnOf(versionId) {
      const i = pos.get(versionId);
      const r = i === undefined ? undefined : rows[i];
      if (!r?.core || (r.v.kind !== "turn" && !r.v.run)) return { ok: false, error: "That isn't an agent turn" };
      if (r.v.provisional) return { ok: false, error: "Available once it's sent" };
      // the turn's versions, newest first, each inverted onto head: what a later change changed again keeps that newer
      // value and becomes a card (base: the turn's value, ours: head's, theirs: before the turn), the rest is undone
      // (core's turn undo, as `cb undo --turn` does it). The whole turn: a turn's id takes its versions however other
      // edits interleave them (review of the UX data #4); a run with no turn id (an agent that names none) is its run.
      const key = r.turnKey, run = r.v.run;
      const inTurn = (x: Row) => !!x.core && (key && !key.startsWith("run:") ? x.turnKey === key : run ? x.v.run === run : x === r);
      // what an undo since took out (and no redo put back) is out already: never inverted twice, so an edit made since
      // to the same value stays (review #2)
      const redone = new Set<string>();
      for (const x of rows) if (x.core?.redoOf) redone.add(x.core.redoOf);
      const undone = new Set<string>();
      for (const x of rows) if (x.core?.kind === "undo" && x.core.change && !redone.has(x.core.change)) for (const id of x.core.undoes ?? []) undone.add(id);
      const members: Row[] = [];
      for (let k = rows.length - 1; k >= 0; k--) {
        const x = rows[k]!;
        if (inTurn(x) && !(x.core!.change && undone.has(x.core!.change))) members.push(x);
      }
      if (!members.length) return { ok: false, error: "This turn is undone already" };
      // the cut on screen: a turn inherited from the cut this one was made from is taken out here, never there (#1)
      const onCut = cutId;
      const head = await carton.head(onCut);
      let doc: Doc = head.doc;
      const byPath = new Map<string, ConflictCard>();
      const ids: string[] = [];
      for (const m of members) {
        const c = m.core!;
        // a fold-some's version is its fold and its partial revert: undone from before the fold, both named
        const pair = c.rejected && c.change?.endsWith(".inverse") ? [c.change, c.change.slice(0, -".inverse".length)] : c.change ? [c.change] : [];
        ids.push(...pair);
        const [before, after] = await Promise.all([carton.checkout(`${c.ref.branchId}@${startOf(c)}`), carton.checkout(`${c.ref.branchId}@${c.ref.seq}`)]);
        const mg = merge3(after, doc, before, schema, { infer: false });
        doc = mg.doc;
        for (const card of mg.conflicts) {
          const prev = byPath.get(card.path);
          if (!prev) byPath.set(card.path, card);
          else {
            const { hunks: _h, ops: _o, ...kept } = prev as ConflictCard & { hunks?: unknown; ops?: unknown };
            byPath.set(card.path, { ...kept, theirs: card.theirs } as ConflictCard);
          }
        }
      }
      // an undo never empties a project its head holds (P2-1; core refuses the same for ⌘Z and cb undo)
      if (schema.empty?.(doc) && !schema.empty(head.doc)) return { ok: false, error: "Can't undo that: the project would be left empty" };
      const res = await carton.commit({ cut: onCut, doc, base: head.ref, author: opts.me, undoOf: ids });
      await refreshUndo();
      if (res.status === "rejected") return { ok: false, error: res.reason };
      const cards = [...byPath.values(), ...(res.status === "conflicts" ? res.cards : [])];
      // the undo's own version, for its toast's Undo (PLAN 5.3); none when it changed nothing. It is an undo change
      // (`undoOf`), off the undo stack: redo is what puts the turn back
      const made = madeOn(onCut, [madeBy(res)], "redo");
      if (!cards.length) return { ok: true, ...made };
      addCards(cards, undefined, onCut);
      return { ok: true, conflicts, ...made };
    },
    async find(text, o) {
      if (typeof carton.find !== "function") return { clips: [], hits: [], total: 0, versions: 0 };
      const r = await carton.find(text, { cut: cutId, ...(o?.limit !== undefined ? { limit: o.limit } : {}), ...(o?.before !== undefined ? { before: o.before } : {}), ...(o?.fields ? { fields: o.fields } : {}), ...(o?.allCuts ? { allCuts: true } : {}), now: clock() });
      const hits: FindHit[] = r.matches.map((m) => {
        const itemId = itemOfRecord(m.record);
        return {
          versionId: rowIdOf(m.change, m.ref),
          ref: `${m.ref.branchId}@${m.ref.seq}`,
          cutId: m.ref.branchId,
          at: m.at,
          author: ui(m.author),
          field: m.field,
          fields: m.fields,
          snippet: m.snippet,
          hits: m.hits,
          ...(itemId !== undefined ? { itemId } : {}),
          ...(m.recordName ? { clipName: m.recordName } : {}),
          ...(m.span ? { span: m.span } : {}),
          ...(m.landmarks ? { landmarks: m.landmarks } : {}),
        };
      });
      const clips = r.clips.flatMap((c) => {
        const itemId = itemOfRecord(c.record);
        return itemId === undefined ? [] : [{ itemId, name: c.name, cutId: c.cut, ...(c.deleted ? { deleted: true } : {}) }];
      });
      return { clips, hits, total: r.total, versions: r.versions };
    },
    async landmarks(o) {
      if (typeof carton.landmarks !== "function") return [];
      const list = await carton.landmarks({ cut: cutId, ...(o?.kinds ? { kinds: o.kinds } : {}), ...(o?.limit !== undefined ? { limit: o.limit } : {}) });
      return list.map((l): Landmark => ({
        id: l.id,
        kind: l.kind,
        versionId: rowIdOf(l.change ?? null, l.ref),
        ref: `${l.ref.branchId}@${l.ref.seq}`,
        at: l.at,
        by: l.by ? ui(l.by) : null,
        ...(l.label ? { label: l.label } : {}),
        ...(l.before ? { before: l.before } : {}),
        ...(l.after ? { after: l.after } : {}),
        personal: l.personal,
        local: l.local,
        picture: l.picture,
      }));
    },
    async restoreClip(ref, itemId, o) {
      if (ref.startsWith(PENDING_PREFIX)) throw new Error("This version is still waiting to sync");
      const onCut = carton.cut;
      const res = await carton.restoreClip(ref, [tl?.collection ?? "items", itemId], { author: opts.me, ...(o?.remove ? { remove: true } : {}), ...(typeof o?.expect === "string" ? { expect: o.expect } : {}) });
      await refreshUndo();
      const made = res.brought.how === "same" ? {} : madeOn(onCut, [madeBy(res as Parameters<typeof madeBy>[0])]);
      return { ...made, how: res.brought.how, clipName: res.brought.name, ...placeOf(res.brought) };
    },
    async bringBackChoices(ref) {
      const r = await carton.bringBackChoices(ref, { cut: cutId });
      const row = (c: (typeof r.changed)[number]): BringBackChoice => ({
        itemId: itemOfRecord(c.record) ?? splitPathKey(c.record)[1] ?? c.record,
        name: c.name,
        ...(c.noun ? { noun: c.noun } : {}),
        ...(c.then ? { then: { ...(c.then.start !== undefined ? { start: c.then.start } : {}), ...(c.then.end !== undefined ? { end: c.then.end } : {}), ...(c.then.text !== undefined ? { text: c.then.text } : {}) } } : {}),
        ...(c.now ? { now: { ...(c.now.start !== undefined ? { start: c.now.start } : {}), ...(c.now.end !== undefined ? { end: c.now.end } : {}), ...(c.now.text !== undefined ? { text: c.now.text } : {}) } } : {}),
        ...(c.by !== undefined ? { by: c.by ? ui(c.by) : null } : {}),
        ...(c.at !== undefined ? { at: c.at } : {}),
        token: c.token,
        ...placeOf(c),
      });
      return { changed: r.changed.map(row), deleted: r.deleted.map(row), added: r.added.map(row), same: r.same };
    },
    align,
    async landmarkPicture(key) {
      return (await opts.pictures?.get(key)) ?? null;
    },
    async saveLandmarkPicture(key, jpeg) {
      if (!opts.pictures) return;
      if (typeof jpeg !== "string" || !jpeg.startsWith("data:image/jpeg;base64,") || jpeg.length > 90_000) throw new Error("A landmark's picture is a small JPEG (a data:image/jpeg URL of at most 64 KB)");
      await opts.pictures.put(key, jpeg);
    },
    async clipVersions(itemId, o) {
      const record = pathKey([tl?.collection ?? "items", itemId]);
      const out: string[] = [];
      // only the versions after one the filter already holds (on this cut): the index's tail, never the whole of it
      const held = o?.after !== undefined ? rows[pos.get(o.after) ?? -1]?.core : undefined;
      if (held && held.ref.branchId === cutId && typeof carton.touched === "function") {
        const list = await carton.touched({ cut: cutId, record, after: held.ref.seq });
        for (let k = list.length - 1; k >= 0; k--) if (pos.has(list[k]!.change)) out.push(list[k]!.change);
        return { ids: out };
      }
      if (typeof carton.touched !== "function") {
        // no index here: the last day's versions only, read one by one, and the filter says so
        const since = clock() - 86_400_000;
        for (let i = rows.length - 1; i >= 0 && rows[i]!.v.at >= since; i--) {
          const r = rows[i]!;
          if (!r.core || r.core.ref.seq <= 0) continue;
          const got = (await carton.log({ cut: r.core.ref.branchId, before: r.core.ref.seq + 1, limit: 1, summary: true, rows: true }))[0];
          if (got?.rows?.some((x) => x.key === record)) out.push(r.v.id);
        }
        return { ids: out, since };
      }
      // this cut's versions, then those of the cuts it was made from, up to each fork (as History lists them)
      const chain: { cut: string; upTo?: number }[] = [{ cut: cutId }];
      let from = records.find((c) => c.id === cutId)?.forkOf ?? null;
      for (let d = 0; from && d < 8; d++) {
        const n = nodeOf(from);
        if (!n || !records.some((c) => c.id === n.cut)) break;
        chain.push({ cut: n.cut, upTo: n.seq });
        from = records.find((c) => c.id === n.cut)?.forkOf ?? null;
      }
      for (const { cut, upTo } of chain) {
        const list = await carton.touched({ cut, record, ...(upTo !== undefined ? { upTo } : {}) });
        for (let k = list.length - 1; k >= 0; k--) if (pos.has(list[k]!.change)) out.push(list[k]!.change);
      }
      const r: ClipVersions = { ids: out };
      return r;
    },
    async view(target: ViewTarget | null) {
      const gen = ++viewGen;
      if (!target) {
        if (viewing || preview) setViewing(null);
        opts.onPreview?.(null);
        return;
      }
      const next = await viewingOf(target);
      // load first: the editor stays on your edit until the state is there, and a failure says so (PLAN 4.2)
      let doc: Readonly<Doc>;
      try {
        doc = (await carton.preview(next.ref)).doc;
      } catch {
        if (gen === viewGen) throw new Error("Couldn't load this version. Try again.");
        return;
      }
      if (gen !== viewGen || disposed) return;
      setViewing(next);
      opts.onPreview?.({ ref: next.ref, label: next.label, doc });
    },
    setWorking(turn) {
      if (!turn) {
        workingTurn = null;
        if (working) {
          working = null;
          hub.notify("working");
        }
        return;
      }
      const since = turn.since ?? clock();
      const actorsNow = new Set(turn.actors?.length ? turn.actors : [turn.actor.id]);
      const actor = ui(turn.actor);
      // the same turn again (a panel told twice): what it changed so far stays (review of the UX data #9)
      const same = !!workingTurn && !!working && working.actor.key === actor.key && workingTurn.since === since && (workingTurn.cut ?? null) === (turn.cut ?? null);
      const records = same ? workingTurn!.records : new Set<string>();
      workingTurn = { actors: actorsNow, since, records, ...(turn.cut ? { cut: turn.cut } : {}) };
      working = { actor, label: turn.label, edits: records.size, since, ...(turn.cut ? { cutId: turn.cut } : {}) };
      hub.notify("working");
      if (same) return;
      // a panel opened during the turn: what it changed before, from the per-version index (the versions since it
      // began only)
      const mine = workingTurn;
      const onCut = turn.cut ?? cutId;
      let after = rows.length;
      while (after > 0 && (rows[after - 1]!.v.at >= since - 1000 || !rows[after - 1]!.core)) after--;
      const fromSeq = after > 0 ? (rows[after - 1]!.core?.ref.branchId === onCut ? rows[after - 1]!.core!.ref.seq : 0) : 0;
      if (typeof carton.touched !== "function") return;
      void track(
        carton.touched({ cut: onCut, after: fromSeq }).then((list) => {
          if (workingTurn !== mine || !working) return;
          const was = mine.records.size;
          for (const t of list) {
            const id = t.author?.id ?? "";
            if (t.at >= since - 1000 && (mine.actors.has(id) || mine.actors.has(id.replace(/\/sub-[^/]*$/, "")))) for (const k of t.records) mine.records.add(k);
          }
          if (mine.records.size !== was) {
            working = { ...working, edits: mine.records.size };
            hub.notify("working");
          }
        }, () => {}),
      );
    },

    async compare(a, b) {
      const [d, da, db] = await Promise.all([shotDiff(a, b), carton.checkout(a), carton.checkout(b)]);
      const measure = opts.measure ?? defaultMeasure;
      const side = (ref: string, doc: Doc, label: string) => {
        const v = versionAt(ref);
        const m = measure(doc, schema);
        return { label, ref, at: v?.at ?? clock(), author: v?.author ?? me, clipCount: m.clips, ...(m.kinds?.length ? { kinds: m.kinds } : {}), length: m.length };
      };
      // What changed, in History's words (UI audit P2-5: the card said only "N shots differ"): the ops from a to b,
      // described against a. A describe that fails leaves the card with its summary.
      let changes: string[] | undefined;
      try {
        changes = (await changesBetween(a, b)).map((x) => x.text);
      } catch {
        changes = undefined;
      }
      // counted as WatchTheChanges counts them (the same shot diff's count)
      const changeCount = d.changes ?? countOf(da, db);
      const c: Comparison = { a: side(a, da, d.aLabel), b: side(b, db, d.bLabel), diff: diffSummary(d), ...(changes ? { changes } : {}), ...(changeCount === undefined ? {} : { changeCount }) };
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
      // Only the newest plan is the one a fold acts on. Each plan is built apart and written to the plan state at its
      // end, and only while no newer plan has started: an older one still running (the Fold dialog's From or Into
      // changed meanwhile) never writes what fold() reads (review of feat/ux-6: a slow plan of cut A, finishing after
      // B's, made folding B bring in A's left-out change too).
      const gen = ++planGen;
      const cards = new Map<string, ConflictCard>();
      const rests = new Map<string, { ids: string[]; ops: Op[]; whole: boolean }>();
      const joined = new Map<string, string[]>();
      let isNew = false, heads = "";
      const publish = <T>(plan: T): T => {
        if (gen !== planGen) return plan;
        planCards.clear();
        for (const [k, v] of cards) planCards.set(k, v);
        planRest.clear();
        for (const [k, v] of rests) planRest.set(k, v);
        planJoined.clear();
        for (const [k, v] of joined) planJoined.set(k, v);
        planNew = isNew;
        planHeads = heads;
        planFor = planKey(fromId, intoId);
        return plan;
      };
      const from = cuts.find((c) => c.id === fromId) ?? fallbackCut(fromId), into = cuts.find((c) => c.id === intoId) ?? fallbackCut(intoId);
      const r = await carton.fold(fromId, { into: intoId, check: true, ...(o?.allCards ? { missingBase: "all-cards" as const } : {}) });
      const base = { from, into, ...madeOf(fromId, intoId), changes: [] as FoldChange[], conflicts: [] as Conflict[], warnings: [] as string[] };
      if (r.status === "up-to-date") {
        const rest = await leftOutRows(fromId, intoId, rests);
        return publish(rest.length ? { ...base, changes: rest } : base);
      }
      if (r.status === "missing-base") return publish({ ...base, missingBase: r.dialog.text });
      if (r.status === "rejected") throw (publish(null), new Error(r.reason));
      const cardList: ConflictCard[] = r.status === "conflicts" || r.status === "compare" ? r.cards : [];
      for (const c of cardList) cards.set(c.path, c);
      isNew = r.status === "confirmed" || r.status === "conflicts" || r.status === "compare";
      const fromHead = (await carton.log({ cut: fromId, limit: 1 }))[0];
      heads = await headsOf(fromId, intoId);
      // the cut folded into names the cards' clips (and every change below): read once
      const intoDoc = cardList.length || r.preview ? (await carton.head(intoId)).doc : undefined;
      const cardsOut = cardList.map((card) => toFoldConflict(card, ui(fromHead?.author), intoId, fromId, intoDoc));
      // §13 "every difference shown as a card": the cards are the whole plan, there is nothing else to leave out.
      if (r.status === "compare") return publish({ ...base, conflicts: cardsOut, partial: false });
      const preview = r.preview;
      if (!preview) return publish({ ...base, conflicts: cardsOut, partial: false });
      // One row per record the fold touches, so leaving one out (partial accept) is keyed by its record path.
      const groups = byRecord(preview.ops);
      // a split clip is one row, left out whole (fold() adds its parts' keys)
      const creditOf = joinSplits(groups, preview.ops, intoDoc!, joined);
      const changes: FoldChange[] = [];
      // named from all of the fold, made once: a track it adds names the clip moved onto it (regress prod3 P3-B)
      const names = namingDoc(intoDoc!, preview.ops, schema);
      for (const [key, ops] of groups) {
        // the change sentences (PLAN 0.2): a row of the Fold dialog says it as History and the card do
        const list = changeList(ops, intoDoc!, schema, { names, ...valueOpt });
        const words = list.map((x) => x.text);
        const record = !!schema.collections[splitPathKey(key)[0]!];
        const who = record ? await carton.credits(splitPathKey(creditOf.get(key) ?? key), { cut: fromId, detail: true }) : null;
        changes.push({ id: key, summary: words.join("; ") || key, author: ui(who?.actor ?? fromHead?.author), at: who?.at ?? fromHead?.at ?? clock(), ...foldRow(key, list) });
      }
      // A remap (ripple) can't be left out on its own: it moves many records at once.
      const hasRemap = preview.ops.some((op) => op.op === "remap");
      isNew = true;
      // what earlier partial folds left out comes with them (none when the fold can't be split)
      if (!hasRemap) changes.push(...(await leftOutRows(fromId, intoId, rests)));
      return publish({
        ...base,
        changes,
        conflicts: cardsOut,
        warnings: preview.warnings.map((w) => String((w as { text?: unknown }).text ?? w.kind)),
        ...(hasRemap ? { partial: false } : {}),
      });
    },

    async switchCut(id, o) {
      // a queued switch (onlyFrom): the cut is the handle's own, so a switch made since, here or by `cb cut switch`, wins
      if (o?.onlyFrom !== undefined && carton.cut !== o.onlyFrom) return;
      await carton.switchTo(id);
      cutId = id;
      rows.length = 0;
      pos.clear();
      named.length = 0;
      turns.length = 0;
      mine.length = 0;
      items.clear();
      reindexFrom(0);
      publishConflicts();
      publishGhosts();
      hub.notify("history");
      await refresh();
    },
    async newCut(name, fromRef) {
      const rec = await carton.fork(name, { from: fromRef, author: opts.me });
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
      const common = { into: intoId, author: opts.me, ...(choices ? { choices } : {}), ...(o.allCards ? { missingBase: "all-cards" as const } : {}) };
      // What earlier partial folds left out (UI audit P1-4): each one's rows fold in together, as "fold in the rest"
      // (a revert of its inverse), after the new changes; leaving any of its rows out keeps all of them for later.
      const restRows = new Set([...planRest.values()].flatMap((x) => x.ids));
      // A split row left out stands for the clip and its parts. If either cut moved since the plan (its parts split
      // again, say), they are found again in what the fold would bring now, so no part of it comes in (review P2).
      let joined: ReadonlyMap<string, string[]> = planJoined;
      if (o.leaveOut.some((id) => planJoined.has(id)) && (await headsOf(fromId, intoId)) !== planHeads) {
        const now = (await carton.fold(fromId, { into: intoId, check: true, ...(o.allCards ? { missingBase: "all-cards" as const } : {}) })) as { preview?: { ops: Op[] } };
        const fresh = new Map<string, string[]>();
        if (now.preview) joinSplits(byRecord(now.preview.ops), now.preview.ops, (await carton.head(intoId)).doc, fresh);
        joined = new Map([...planJoined].map(([k, parts]) => [k, fresh.get(k) ?? parts]));
      }
      const leaveOut = o.leaveOut.filter((id) => !restRows.has(id)).flatMap((id) => [id, ...(joined.get(id) ?? [])]);
      const rests = [...planRest].filter(([, x]) => !x.ids.some((id) => o.leaveOut.includes(id)));
      let r;
      try {
        r = !planNew ? ({ status: "up-to-date" } as const) : leaveOut.length ? await carton.foldSome(fromId, { ...common, reject: [...leaveOut] }) : await carton.fold(fromId, common);
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
      if (r.status === "rejected") return await refresh(), { ok: false, error: r.reason };
      if (r.status !== "confirmed" && r.status !== "pending" && r.status !== "up-to-date") return await refresh(), { ok: false, error: r.dialog.text };
      // What earlier partial folds left out: each as "Fold in the rest" when all of it is still left out, else exactly
      // the changes shown (a revert would also take back what was changed on the cut since: a card the plan never
      // showed, review #1). A clash with an edit made since the plan is a card in the stack, as Fold in the rest's.
      let carded = false;
      // the versions it makes, oldest first (PLAN 5.3: its toast's Undo takes back all of them, and nothing else)
      const ids = [madeBy(r as Parameters<typeof madeBy>[0])];
      for (const [inverse, x] of rests) {
        const res = x.whole ? await carton.revert(inverse, { author: opts.me, cut: intoId }) : await carton.commit({ cut: intoId, ops: x.ops, author: opts.me });
        if (res.status === "conflicts") {
          addCards(res.cards, undefined, intoId);
          carded = true;
          continue;
        }
        if (res.status === "rejected") return await refresh(), { ok: false, error: res.reason };
        ids.push(madeBy(res));
        if (x.whole) markRestDone(inverse);
      }
      await refresh();
      const made = madeOn(intoId, ids);
      return carded ? { ok: true, conflicts, ...made } : { ok: true, ...made };
    },
    async resolve(id, choice) {
      const entry = cardEntries.get(id);
      if (!entry) return;
      // The other side is already on screen (head); only the person's own side needs a commit.
      let made: string | undefined;
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
        made = madeBy(r);
      }
      cardEntries.delete(id);
      publishConflicts();
      // what the pick made (PLAN 5.3): nothing for the side on screen, so its toast has no Undo (WS7's note: an Undo
      // there would take back an earlier change)
      return madeOn(entry.cut, [made]);
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
        // its Undo is offered when the call returns, not a debounce later: a page that reads Undo then gets this one
        await refreshUndo();
        return { ok: true, ...madeOn(r.core.ref.branchId, [madeBy(res)]) };
      }
      if (res.status === "conflicts") {
        addCards(res.cards, undefined, r.core.ref.branchId);
        return { ok: false, conflicts };
      }
      return { ok: false, error: res.status === "rejected" ? res.reason : "Couldn't fold in the rest" };
    },
    async restore(ref) {
      if (ref.startsWith(PENDING_PREFIX)) throw new Error("This version is still waiting to sync");
      // (the handle's cut, which a restore with no cut writes)
      const onCut = carton.cut;
      const res = await carton.restore(ref, { author: opts.me });
      // Its Undo is offered when the call returns (panel-author: Undo read right after a restore was the version
      // before it's, and the panel then refused it, "Something changed")
      await refreshUndo();
      // the version it made (PLAN 5.3: its toast's Undo); a restore of what head already is makes one too (allowEmpty)
      return madeOn(onCut, [madeBy(res as Parameters<typeof madeBy>[0])]);
    },
    async nameVersion(id, name) {
      const i = pos.get(id);
      const r = i === undefined ? undefined : rows[i];
      if (!r?.core) return;
      await carton.name(r.v.ref, name, { author: opts.me });
      const j = pos.get(id);
      if (j === undefined) return;
      const row = rows[j]!;
      row.core = { ...row.core!, name };
      row.v = { ...row.v, name, ...(row.v.turn ? { turn: { ...row.v.turn, label: name } } : {}) };
      reindexFrom(Math.min(j, regroupAt(j)));
      hub.notify("history");
    },
    async undo(turnId) {
      if (undo?.id !== turnId) return { ok: false, error: "Something changed. Try again." };
      const onCut = cutId;
      const r = await carton.undo(myGroup, { cut: onCut, author: opts.me });
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
      await carton.publish({ from: src?.head ?? id, name: `${src?.name ?? "Cut"} (published)`, author: opts.me });
      await refreshCuts();
    },
    // Deprecated alias of view() (PLAN 0.5): as before, it shows at once with its caller's label, and closes if the state
    // can't be rebuilt; viewing() says the same
    openPreview(ref, label) {
      // A provisional version has no state to rebuild yet (L5): there is nothing to preview.
      if (ref?.startsWith(PENDING_PREFIX)) return;
      const gen = ++viewGen;
      const v = ref ? versionAt(ref) : undefined;
      setViewing(ref ? { ref, kind: "version", label: label ?? (v ? versionLabel(v, { ...labelCtx(), start: true }) : ref), short: v ? versionShort(v, labelCtx()) : (label ?? ref), ...(v ? { versionId: v.id } : {}) } : null);
      if (!opts.onPreview) return;
      if (!ref) opts.onPreview(null);
      else
        carton.preview(ref).then(
          // a newer view or preview since (even of the same ref) owns the stage (review of the UX data #10)
          (p) => gen === viewGen && preview?.ref === ref && opts.onPreview!({ ref, label: label ?? ref, doc: p.doc }),
          () => {
            // The state can't be rebuilt (expired pin, unknown ref): close the preview rather than show a wrong one.
            if (gen !== viewGen || preview?.ref !== ref) return;
            setViewing(null);
            opts.onPreview!(null);
          },
        );
    },
    async conflictRef(conflictId, side) {
      const e = cardEntries.get(conflictId);
      if (!e) return null;
      const head = await carton.head(e.cut);
      // The side shown now is head; the other is head with that side applied, held as a pin for the preview's while.
      if (side === (e.conflict.provisional ?? "theirs")) return `${head.ref.branchId}@${head.ref.seq}`;
      const value = side === "mine" ? e.card[e.mineSide] : e.card[e.mineSide === "ours" ? "theirs" : "ours"];
      const doc = apply(fork(head.doc, schema), cardOps(e.card, value), schema);
      const pin = await carton.pin({ owner: `see:${conflictId}:${side}`, cut: e.cut, doc, ttlMs: 30 * 60_000 });
      return pin.header;
    },
    blockEdit() {
      if (!viewing || viewing.blockedEdit) return;
      setViewing({ ...viewing, blockedEdit: true });
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
      out[s.i] = schema.label?.(tl.collection, it, doc) ?? (typeof it.name === "string" ? it.name : undefined);
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
  return a.name === b.name && a.label === b.label && a.current === b.current && a.readOnly === b.readOnly && a.kind === b.kind && a.head === b.head && a.updatedAt === b.updatedAt && a.shared === b.shared && a.color === b.color && a.updatedBy?.key === b.updatedBy?.key;
}

function samePublished(a: Published | null, b: Published | null): boolean {
  if (!a || !b) return a === b;
  return a.cutId === b.cutId && a.ref === b.ref && a.newerEdits === b.newerEdits && a.versionName === b.versionName && a.at === b.at && a.url === b.url;
}
