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
  /** Display name: "Alice", "Director", "Claude Code (terminal)". */
  readonly name: string;
  /** Key of the actor that started this one. */
  readonly parent?: string;
  /** Subagent type from the Claude Code hook (`agent_type`), e.g. "Explore". */
  readonly subagentType?: string;
  /** Presence colour; derived from the key when absent. */
  readonly color?: string;
  /** True for the local person and the agents acting for them. */
  readonly isYou?: boolean;
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
  /** One plain sentence: describe()'s first line, e.g. "Trimmed 'Intro' end 6.0 s → 5.0 s". */
  readonly summary: string;
  /** describe()'s other lines, shown on demand. */
  readonly details?: readonly string[];
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
}

/** Which rows History shows. */
export type HistoryFilter = "all" | "named" | "turns";

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
  /** Why a card instead of a merge, when it isn't plain: "The result would end before it starts". */
  readonly reason?: string;
  /** The choice already shown in the edit while undecided (§7: provisional = your side). */
  readonly provisional?: ConflictChoice;
  /** A fingerprint of both sides' values: a pick made on the card holds only while it still matches. */
  readonly sig?: string;
}

/** One side of a Compare card (§9, generalizing the recovery picker). */
export interface CompareSide {
  readonly label: string;
  readonly ref: string;
  readonly at: number;
  readonly author: Actor;
  readonly clipCount: number;
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

/** Read-only preview mode (§9, R2-16): Compare, A/B or a version opened from History. */
export interface Preview {
  readonly ref: string;
  readonly label: string;
  /** The first edit attempt in a preview sets this, and the banner offers "Return to current to edit". */
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
  | "preview";

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
  /** Open a read-only preview of a ref, or close it with null. */
  openPreview(ref: string | null, label?: string): void;
  /** The host saw an edit attempt during a preview: the banner then explains and offers "Return to current to edit". */
  blockEdit(): void;
}
