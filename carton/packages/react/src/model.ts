// The view model the components read. It is deliberately narrower than the Carton API: plain, immutable records
// that a host adapter (from-carton.ts for the real engine, mock.ts for the gallery and tests) keeps up to date.
//
// Two rules make "no re-render storms" possible (task: subscribe narrowly):
// - every getter returns the *same object* until that piece of state really changes, so useSyncExternalStore and
//   memo() can skip work by identity;
// - state is split into topics, and a component subscribes only to the topics it shows. A presence ghost moving at
//   20 Hz never wakes the history list, and a new version never wakes the avatars.

/** Who acted. Subagents point at the agent that started them, and agents at the person (§10, §0.1 Credits). */
export interface Actor {
  /** Stable key, e.g. `human/alice` or `agent/director/chat-1/turn-3/sub-explore-ab12`. */
  readonly key: string;
  readonly kind: "human" | "agent" | "subagent" | "system";
  /** Display name: "Alice", "Director", "Claude Code" (a subagent: its agent's product name). */
  readonly name: string;
  /** Key of the actor that started this one. */
  readonly parent?: string;
  /** Subagent type from the Claude Code hook (`agent_type`), e.g. "Explore". */
  readonly subagentType?: string;
  /** Presence colour; derived from the key when absent. */
  readonly color?: string;
  /** True for the local person and the agents acting for them. */
  readonly isYou?: boolean;
  /** The model an agent ran on, in words ("Opus 5.5"), when known: tooltips only (actorDetail). */
  readonly model?: string;
}

/** What made a version. "turn" is a Director turn, shown as a checkpoint (the existing chat checkpoints). */
export type VersionKind = "edit" | "turn" | "fold" | "restore" | "undo" | "publish" | "import" | "export";

/** One row of History. Immutable: a version's object never changes once it is shown. */
export interface Version {
  /** Stable key: the change id while pending, kept after confirmation so rows don't remount. */
  readonly id: string;
  /** Confirmed position in the cut, or null while it is still provisional (L5). */
  readonly seq: number | null;
  /** The ref to restore or compare: `main@57`, or a pin ref for a provisional state. */
  readonly ref: string;
  /** Milliseconds since the epoch. */
  readonly at: number;
  readonly author: Actor;
  readonly kind: VersionKind;
  /**
   * One sentence in editor words (DESIGN §8 "Change sentences"): "Trimmed “Intro”, now ends at 0:05", "Restored the
   * 11:02 am version", "Folded in “30s cut”", "Made this cut from Main cut at 12:20 pm". Empty until described (the
   * rows on screen are described first). Never an id or a hash.
   */
  readonly summary: string;
  /** Every change the version made, one sentence each, when the summary doesn't say it all. */
  readonly details?: readonly string[];
  /**
   * How many changes it made, counted as everywhere (core's `countChanges`): "1 change", a turn's "4 changes" (what the
   * whole turn changed). Known once described; a fold that left some out counts what it took ("2 of 3 changes" with
   * `leftOut`).
   */
  readonly changes?: number;
  /** A partial fold: how many changes it left out ("2 of 3 changes": `changes` of `changes + leftOut`). */
  readonly leftOut?: number;
  /** The ref its changes start from (the version before it; a turn's: before its first version): `changes(base, ref)` is what it did. */
  readonly base?: string;
  /**
   * The agent turn it is part of (PLAN 0.4): a turn's versions share it, and its newest is the turn's row (kind "turn").
   * History shows the turn as that one row (`groupHistory` folds the others under it).
   */
  readonly run?: string;
  /** A name the user gave it: "Sent to client, Monday". */
  readonly name?: string;
  /** A Director turn: its label (the prompt, shortened) and how many edits it made. */
  readonly turn?: { readonly label: string; readonly edits: number };
  /** Still waiting for the server: its version number is provisional (L5). */
  readonly provisional?: boolean;
  /** This version is the published cut. */
  readonly published?: boolean;
  /**
   * A partial fold's inverse (§5.3 R2-14: "fold in some of it"): the changes left out can still be folded in, with
   * CartonUi.foldRest().
   */
  readonly foldRest?: boolean;
  /**
   * Nothing in it (core's `blank`): the start of an imported project's history, from before the project was added. It
   * can't be previewed, restored or made into a cut (laptop, build 915eb36: restoring it emptied the project).
   */
  readonly empty?: boolean;
  /**
   * The start of History (PLAN 0.4): the cut's first version ("Started the cut"), the project's history start, or the
   * import. History shows them as one row: "Project created", or "History starts here" for an imported project.
   */
  readonly start?: "created" | "imported";
}

/**
 * Which rows History shows (DESIGN §6.1's filter menu): All versions, Named versions, Agent turns, Your changes, and
 * Only “clip” (`{ item }`: the versions that touched one clip, PLAN 0.8). A filter that reads an index the source
 * hasn't loaded yet counts 0 until it has (`HistorySource.status`), then History's topic fires.
 */
export type HistoryFilter = "all" | "named" | "turns" | "mine" | { readonly item: string };

/** How far a filter's rows are known (PLAN 0.8): loading, or covering only the versions since `since`. */
export interface FilterStatus {
  /** The filter's index is still being read: its count is 0 for now. */
  readonly loading: boolean;
  /** Only versions from this time on could be checked: the filter says so ("Today's versions only"). */
  readonly since?: number;
}

/** The versions that touched one clip (PLAN 0.8), from the per-version index of the records each version touched. */
export interface ClipVersions {
  /** Version ids (History's ids), newest first. */
  readonly ids: readonly string[];
  /** Set when only the versions from then on could be checked (no index for older ones). */
  readonly since?: number;
}

/** What kind of clip a change is about, shown in Cardboard's own timeline colours (DESIGN §5.1). */
export type ClipKind = "video" | "title" | "caption" | "audio" | "image" | "code" | "project";
/** What happened to it: the change row's corner mark (green +, red −, amber dot). */
export type ChangeKind = "add" | "remove" | "change";

/**
 * One change between two versions (PLAN 0.1, DESIGN §5.1): a row of a version's card, the Changes view, the Fold
 * dialog and a toast. One per change as core's `countChanges` counts them (a record each, a split one, a title's own
 * media entry with its title, a ripple's shift none), so `changes(a, b).length` is the count every other place shows.
 */
export interface Change {
  /** Stable within one answer and across answers for the same record: the record's key (`timelineItems/c1`), or a root field's name. */
  readonly key: string;
  /** One sentence in editor words, verb first, the clip by name in curly quotes, positions as 0:09 (DESIGN §8). Never an id or a hash. */
  readonly text: string;
  readonly kind: ChangeKind;
  readonly clip: ClipKind;
  /** The timeline item it is about, when it is one: a host can select it ("Show on timeline"). */
  readonly itemId?: string;
  /** Where it is in the edit, in seconds: its start in b (in a for a removal). None for a change with no place (frame rate, aspect ratio). */
  readonly at?: number;
  /** Where its span ends (seconds, same side as `at`): Play plays [at − 1, end + 1]. */
  readonly end?: number;
  /** Who made it, when known (a version's own changes; a range on one cut, from the per-version index). */
  readonly author?: Actor;
  /** When it was made (ms since the epoch), with `author`. */
  readonly when?: number;
}

/** What `view()` shows on the stage (PLAN 0.5): a History version, how it was before one, a conflict's side, or a cut. */
export type ViewingKind = "version" | "before" | "conflict" | "cut";

/**
 * Viewing (DESIGN §4.2): the editor shows something other than your edit. One label, built in one place, so the chip,
 * the frame and the row never disagree.
 */
export interface Viewing {
  /** The state shown (a ref History and the host can rebuild). */
  readonly ref: string;
  readonly kind: ViewingKind;
  /**
   * "Director's “Add captions…”", "Before Director's “Add captions…”", "Leo's Main cut", "Claude Code's move of
   * “Interview B”", "“Sent to client”", "Your edit from 12:41 pm".
   */
  readonly label: string;
  /** "12:20 pm · Director": the chip's short form, when the label doesn't fit. */
  readonly short: string;
  /** The History row viewed (kind "version" and "before"): its row gets the mark. */
  readonly versionId?: string;
  /** The card (kind "conflict") and the side shown. */
  readonly conflictId?: string;
  readonly side?: ConflictChoice;
  /** The cut viewed (kind "cut"). */
  readonly cutId?: string;
  /** An edit was tried while viewing (the edit-attempt toast and the frame's pulse, PLAN 1.4). */
  readonly blockedEdit?: boolean;
}

/** What to view: `ui.view(target)`; `ui.view(null)` is back to your edit. */
export type ViewTarget =
  /** A History row by id, or any ref (a comment's "See it as it was"), with its label when it isn't a row. */
  | { readonly kind: "version"; readonly versionId?: string; readonly ref?: string; readonly label?: string }
  /** How it was before a row's changes (a turn: before its first version), or before a ref (the Changes view's older side, with its label). */
  | { readonly kind: "before"; readonly versionId?: string; readonly ref?: string; readonly label?: string }
  | { readonly kind: "conflict"; readonly conflictId: string; readonly side: ConflictChoice }
  | { readonly kind: "cut"; readonly cutId: string };

/** An agent working (PLAN 0.7, DESIGN §6.1): an in-app turn holding the timeline. Null otherwise. */
export interface Working {
  readonly actor: Actor;
  /** The turn's prompt, as its row's title. */
  readonly label: string;
  /** Changes it made so far: "2 changes so far". */
  readonly edits: number;
  /** When the turn started (ms since the epoch). */
  readonly since: number;
  /** The cut it works on (agents work on the cut you're on). */
  readonly cutId?: string;
}

/**
 * History as an indexed, append-mostly sequence. A list of 10k+ versions is never copied: the list asks for the rows
 * it shows. Index 0 is the newest.
 */
export interface HistorySource {
  /** Goes up on every change to History (a new version, a provisional one confirmed, a rename). */
  revision(): number;
  count(filter: HistoryFilter): number;
  at(filter: HistoryFilter, index: number): Version | undefined;
  /** Index of a version under a filter, or -1. Used to keep the list's place when rows arrive above it. */
  indexOf(filter: HistoryFilter, id: string): number;
  /**
   * How far a filter's rows are known (PLAN 0.8): `{ item }` is read from an index, async; the others are always
   * known (`{ loading: false }`). Optional: a source without it knows every filter it counts.
   */
  status?(filter: HistoryFilter): FilterStatus;
  /**
   * Every version, oldest first, without side effects (at() may start work, like describing the row). The bridge
   * (remote.ts) diffs it by identity to send only what changed. Optional: without it the bridge reads at().
   */
  all?(): readonly Version[];
  /** Ask for the summaries of these versions now (the rows a remote list shows). */
  want?(ids: readonly string[]): void;
  /**
   * The lowest index (oldest first) that may differ from what all() returned at `revision`; all().length when nothing
   * did. Lets the bridge re-read only the tail after an append instead of the whole History.
   */
  firstChangedSince?(revision: number): number;
  /** The versions from index `from` on (oldest first), without side effects: the bridge reads the changed tail only. */
  slice?(from: number): readonly Version[];
}

export interface Cut {
  readonly id: string;
  /** The name people gave it: "Main cut", "30s Instagram cut". */
  readonly name: string;
  /** Owner-qualified when two cuts share a name: "Bob's main cut" (§5.3). */
  readonly label: string;
  readonly current: boolean;
  /** Imported from someone else's copy or sync: you can watch it and fold it in, not edit it (§5.3). */
  readonly readOnly: boolean;
  readonly kind: "main" | "cut" | "director" | "offline";
  readonly owner?: Actor;
  /** Ref of its newest version. */
  readonly head: string;
  readonly updatedAt: number;
  /** "Shared" cuts sync through the server; the others live on this computer. */
  readonly shared?: boolean;
}

/** The three status words of §0.1 / §13, plus "not shared" (nothing is shown). */
export type SyncStatus =
  | { readonly kind: "local" }
  | { readonly kind: "syncing"; readonly waiting: number }
  | { readonly kind: "upToDate" }
  | { readonly kind: "offline"; readonly waiting: number };

/** A person, agent or subagent here now (§12). Changes at most about once a second per peer. */
export interface Peer {
  readonly actor: Actor;
  /** The cut they are on. */
  readonly cutId: string;
  /** Idle after 30 s without activity (§12): shown dimmed. */
  readonly idle: boolean;
  /** What they are doing, in words: "Editing captions", "Watching". Optional. */
  readonly activity?: string;
}

/** A remote drag in flight (§5.1: drags are presence ghosts until release). Changes at 10–20 Hz. */
export interface Ghost {
  readonly actorKey: string;
  readonly itemId: string;
  readonly trackId: string;
  /** Output seconds. */
  readonly start: number;
  readonly end: number;
  readonly label?: string;
}

export type ConflictChoice = "mine" | "theirs" | "both";

export interface ConflictSide {
  readonly author: Actor;
  /** Plain words: "Trimmed the end to 0:05.0". */
  readonly summary: string;
  readonly at?: number;
  /** The cut this side's edit is on, when the two sides are on different cuts (a fold): "30s Instagram cut". */
  readonly where?: string;
  /** What this side did, as a noun for the viewing label ("Claude Code's move of “Interview B”"): "move", "trim", "change". */
  readonly what?: string;
  /**
   * What this side did, as a change sentence about the card's clip (DESIGN §8: "(a conflict side) Moved it to start at
   * 0:07"): "Made it smaller (font size 80)", "Removed it". The card shows it in place of `summary` when given; the two
   * sides' sentences never read the same. Never an id.
   */
  readonly text?: string;
  /** The same as a verb phrase for the card's title: "moved it", "changed its font size" ("you and Claude Code both moved it"). */
  readonly did?: string;
}

/** A conflict card (§7): both edits are kept, and the person picks. */
export interface Conflict {
  /** Opaque and unique. A host maps a card back with fromCarton's `cardFor(id)`, never by parsing it. */
  readonly id: string;
  /** Which field or record the card is about (core's card path, `items/a/name`); several cards can share one. */
  readonly path?: string;
  /** What the card is about: "'Intro' timing", "Title text". */
  readonly title: string;
  readonly mine: ConflictSide;
  readonly theirs: ConflictSide;
  /** "Keep both" is offered when both can live side by side (a new track, or alternatives). */
  readonly canKeepBoth: boolean;
  /** What "Keep both" makes, in words, when the host can say: "Leo's music on a new track under yours". */
  readonly both?: string;
  /** Why a card instead of a merge, when it isn't plain: "The result would end before it starts". */
  readonly reason?: string;
  /** The choice already shown in the edit while undecided (§7: provisional = your side). */
  readonly provisional?: ConflictChoice;
  /** A fingerprint of both sides' values: a pick made on the card holds only while it still matches. */
  readonly sig?: string;
  /** The clip the card is about, when it is one: a host can select it on its timeline ("Show on timeline"). */
  readonly item?: string;
  /** That clip's name, for the viewing label and the title ("“Interview B”: you and Claude Code both moved it"). */
  readonly clip?: string;
}

/** One side of a Compare card (§9, generalizing the recovery picker). */
export interface CompareSide {
  readonly label: string;
  readonly ref: string;
  readonly at: number;
  readonly author: Actor;
  /** Clips only: a title, a code graphic or a caption is no clip (the schema's `nounOf`, laptop re-check P3-10). */
  readonly clipCount: number;
  /** The timeline's other kinds of item, counted apart ("6 titles"). */
  readonly kinds?: readonly { readonly noun: string; readonly n: number }[];
  /** Seconds. */
  readonly length: number;
}

export interface DiffSummary {
  /** Shots that differ. */
  readonly shots: number;
  /** Seconds that differ. */
  readonly seconds: number;
  /** Length of the longer of the two edits, in seconds. */
  readonly total: number;
}

export interface Comparison {
  readonly a: CompareSide;
  readonly b: CompareSide;
  readonly diff: DiffSummary;
  /**
   * What changed from a to b, one plain-words line each, as History and Fold in word them ("Moved 'Intro' 0:02.0 →
   * 0:04.0"). Optional: a host without it shows only the summary.
   */
  readonly changes?: readonly string[];
  /**
   * How many changes, counted as History, `cb history`, the Fold dialog and WatchTheChanges count them: a record each,
   * a split one (core's `countChanges`; laptop re-check P3-11). Lines in `changes` can be more (a ripple's own line).
   */
  readonly changeCount?: number;
}

/** Credits for one clip: who last changed each part of it, down to the subagent. */
export interface CreditLine {
  /** The part, in editor words: "Added", "Timing", "Color", "Text". */
  readonly what: string;
  readonly author: Actor;
  /** When, if the engine knows (core's credits() returns only the actor today). */
  readonly at?: number;
  readonly versionId?: string;
}

export interface Credits {
  readonly clip: string;
  readonly lines: readonly CreditLine[];
}

/** The newest turn in your undo group (§8): "Undo Director: tighter intro". */
export interface UndoTurn {
  readonly id: string;
  readonly author: Actor;
  /** The turn's label, without the "Undo …:" prefix. */
  readonly label: string;
  readonly at: number;
  /** How many edits the turn made, when known. */
  readonly edits?: number;
}

export interface Published {
  readonly cutId: string;
  readonly cutName: string;
  readonly ref: string;
  readonly versionName?: string;
  readonly at: number;
  /** Versions made on the cut since it was published: > 0 shows "newer edits exist". */
  readonly newerEdits: number;
  readonly url?: string;
}

/** The state the editor shows when it isn't your edit (§9, R2-16). Deprecated: `Viewing` (PLAN 0.5) says the same, with its kind. */
export interface Preview {
  readonly ref: string;
  readonly label: string;
  /** The first edit attempt while viewing sets this (the edit-attempt toast offers "Back to my edit"). */
  readonly blockedEdit?: boolean;
}

/** One change a fold would bring in. Partial accept leaves some out (§5.3, R2-14). */
export interface FoldChange {
  readonly id: string;
  readonly summary: string;
  readonly author: Actor;
  readonly at: number;
  /** Can't be left out on its own (a project-level field): it is folded in with the rest. */
  readonly locked?: boolean;
  /**
   * Left out of an earlier partial fold (UI audit P1-4, "you can fold in the rest later"): that fold's id. Changes with
   * the same id fold in together, or stay left out together.
   */
  readonly leftOut?: string;
}

export interface FoldPlan {
  readonly from: Cut;
  readonly into: Cut;
  readonly changes: readonly FoldChange[];
  readonly conflicts: readonly Conflict[];
  /** Soft-validator warnings on the result: overlaps, gaps, missing media (§4.1). */
  readonly warnings: readonly string[];
  /** False when the changes can't be told apart by record, so the fold is all or nothing. */
  readonly partial?: boolean;
  /**
   * §13: the copy builds on a version this project doesn't have. The text says so plainly; the only ways on are to ask
   * the sender for their copy or to bring it in with every difference as a card (`planFold(…, { allCards: true })`).
   */
  readonly missingBase?: string;
}

export interface FoldResult {
  readonly ok: boolean;
  /** Cards the fold left for the person, if any. */
  readonly conflicts?: readonly Conflict[];
  readonly error?: string;
}

/** A shot of the shot diff (§9): a maximal stretch with the same picture stack. */
export interface Shot {
  readonly start: number;
  readonly end: number;
  /** Content signature: equal signatures are the same shot. */
  readonly sig: number;
  /** Optional poster for the strip. */
  readonly thumb?: string;
  /** Optional name: the top clip's name. */
  readonly label?: string;
}

/** Both edits' shots and the matched pairs (indices into a and b, ascending), from core's shots() + lcs(). */
export interface ShotDiff {
  readonly a: readonly Shot[];
  readonly b: readonly Shot[];
  readonly matches: readonly (readonly [number, number])[];
  readonly aLabel: string;
  readonly bLabel: string;
  /**
   * How many changes from a to b, counted as Compare and History count them (laptop re-check P3-11). WatchTheChanges
   * says it; its counter steps through the sections of the edit that differ, which can be fewer or more.
   */
  readonly changes?: number;
}

export type Topic =
  | "sync"
  | "cuts"
  | "history"
  | "peers"
  | "ghosts"
  | "conflicts"
  | "undo"
  | "published"
  | "preview"
  | "viewing"
  | "working";

/** Everything a component can ask for. Reads that cost real work are async and on demand. */
export interface CartonUi {
  subscribe(topic: Topic, onChange: () => void): () => void;

  sync(): SyncStatus;
  cuts(): readonly Cut[];
  history(): HistorySource;
  peers(): readonly Peer[];
  ghosts(): readonly Ghost[];
  conflicts(): readonly Conflict[];
  undoTurn(): UndoTurn | null;
  published(): Published | null;
  /** Deprecated: `viewing()`. */
  preview(): Preview | null;
  /** The actor for "you", so lists can say "You". */
  me(): Actor;
  /** Look up an actor by key, to show who started a subagent. */
  actor(key: string): Actor | undefined;

  compare(a: string, b: string): Promise<Comparison>;
  credits(itemId: string): Promise<Credits>;
  shotDiff(a: string, b: string): Promise<ShotDiff>;
  planFold(fromCutId: string, intoCutId: string, opts?: { allCards?: boolean }): Promise<FoldPlan>;

  switchCut(cutId: string): Promise<void>;
  newCut(name: string, fromRef: string): Promise<Cut>;
  /** Absent when the engine can't rename cuts yet: the Cuts menu then doesn't offer it. */
  renameCut?(cutId: string, name: string): Promise<void>;
  /** Fold `from` into `into`, leaving out the changes in `leaveOut` (partial accept). */
  fold(fromCutId: string, intoCutId: string, opts: { leaveOut: readonly string[]; choices: Readonly<Record<string, ConflictChoice>>; allCards?: boolean }): Promise<FoldResult>;
  resolve(conflictId: string, choice: ConflictChoice): Promise<void>;
  /** "Fold in the rest" of a partial fold: the changes its inverse version left out. */
  foldRest(versionId: string): Promise<FoldResult>;
  restore(ref: string): Promise<void>;
  nameVersion(versionId: string, name: string): Promise<void>;
  undo(turnId: string): Promise<FoldResult>;
  publish(cutId: string): Promise<void>;
  /**
   * Deprecated alias of `view({ kind: "version", ref, label })` / `view(null)` (PLAN 0.5), kept one release for the
   * components that still call it.
   */
  openPreview(ref: string | null, label?: string): void;
  /** What the editor shows when it isn't your edit (PLAN 0.5), or null: your edit. Topic "viewing" ("preview" fires too). */
  viewing(): Viewing | null;
  /**
   * Show a version, how it was before one, a conflict's side or a teammate's cut on the stage, or come back to your
   * edit (null). Resolves once the state is set; rejects when it can't be loaded ("Couldn't load this version. Try
   * again."), and the editor stays on your edit. The host's `onPreview` is still the one way the editor swaps.
   */
  view(target: ViewTarget | null): Promise<void>;
  /** An agent working on the timeline (PLAN 0.7), or null. Topic "working". */
  working(): Working | null;
  /**
   * Every change from `a` to `b` (PLAN 0.1), in timeline order, as change rows: one per change as `countChanges`
   * counts them, so `.length` is the count shown everywhere. Cached per (a, b). Plain data across `remote.ts`.
   */
  changes(a: string, b: string): Promise<readonly Change[]>;
  /** What one History row did (a turn: all of it), with each change's author and time: the version card's rows. */
  changesIn(versionId: string): Promise<readonly Change[]>;
  /**
   * Undo one agent turn (PLAN 0.6): takes out only that turn's changes, any turn, not only the newest; later edits
   * stay. A later change to the same thing becomes a conflict card (`conflicts`). PLAN 0.6's `ui.undoTurn(versionId)`,
   * named apart from the `undoTurn()` getter (your undo group's newest turn), which keeps its meaning.
   */
  undoTurnOf(versionId: string): Promise<FoldResult>;
  /**
   * The versions that touched one clip (PLAN 0.8), from the per-version index written at save: History's "Only “clip”"
   * filter (`{ item }`). Never diffs every version.
   */
  clipVersions(itemId: string): Promise<ClipVersions>;
  /**
   * "See it": a ref of the cut with one side of a card kept, for openPreview (the side shown now is head itself; the
   * other a held state with that side applied). Null when the card is gone. Optional: a host without it shows no
   * Preview.
   */
  conflictRef?(conflictId: string, side: ConflictChoice): Promise<string | null>;
  /** The host saw an edit attempt while viewing: the stage then explains and offers "Back to my edit". */
  blockEdit(): void;
}
