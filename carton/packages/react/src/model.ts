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

// ------------------------------------------------------------ Carton UX v2 (N0): find, landmarks, bring back, compare

/**
 * What a Find hit matched, by weight (DESIGN-V2 §2.3): a clip's name, title or caption text, an agent's request, a
 * version's name or landmark words, a person, a day.
 */
export type FindField = "clip" | "text" | "prompt" | "name" | "person" | "day";

/** One version Find matched (`CartonUi.find`). */
export interface FindHit {
  /** History's row id (`Version.id`; a version of another cut: its ref) and the version's ref. */
  readonly versionId: string;
  readonly ref: string;
  /** The cut it is on (another cut's with "Search every cut"). */
  readonly cutId: string;
  readonly at: number;
  readonly author: Actor;
  /** The best thing it matched, and all of them (the meta line says why: "Caption text · Leo", "Prompt · 4 changes"). */
  readonly field: FindField;
  readonly fields: readonly FindField[];
  /** A short piece of what matched (about 80 characters at most, `…` where cut), never an id. */
  readonly snippet: string;
  /** Where each word matched in `snippet` ([lo, hi), UTF-16), for the highlight. */
  readonly hits: readonly (readonly [number, number])[];
  /** A clip or text match: the clip's id on the timeline and its name ("Intro"), and where it was ("was 0:00–0:06 here"). */
  readonly itemId?: string;
  readonly clipName?: string;
  readonly span?: { readonly start: number; readonly end: number };
  /** Its landmarks, if it is any. */
  readonly landmarks?: readonly LandmarkKind[];
}
export interface FindHits {
  /** "A clip first": the clips the words name, best first ("“Intro”, the clip" with Only this clip). */
  readonly clips: readonly { readonly itemId: string; readonly name: string; readonly cutId: string; readonly deleted?: boolean }[];
  /** Newest first. */
  readonly hits: readonly FindHit[];
  /** How many versions matched in all. */
  readonly total: number;
  /** How many versions were searched. */
  readonly versions: number;
}

/** The versions people remember (core's `landmarks.ts`, DESIGN-V2 §2.1). */
export type LandmarkKind = "exported" | "sent" | "named" | "turn" | "start" | "before";
export interface Landmark {
  /** Stable key. */
  readonly id: string;
  readonly kind: LandmarkKind;
  /** History's row id for its version, and its ref. */
  readonly versionId: string;
  readonly ref: string;
  readonly at: number;
  readonly by: Actor | null;
  /** Words given with it: an export's preset ("1080p for the client"), whom it was sent to ("Leo"), a turn's prompt, a name. */
  readonly label?: string;
  /** A Before landmark: what came right after it ("Before restoring the 11:02 am version"), and that version's ref. */
  readonly before?: "restore" | "fold" | "undo-turn" | "bring-back";
  readonly after?: string;
  /** Start and Before: only you see it ("Only you see this"). */
  readonly personal: boolean;
  /** Kept on this computer only (Exported and Sent, until the sync server carries them; Start and Before always). */
  readonly local: boolean;
  /** Its picture's key (`landmarkPicture`), one per version. */
  readonly picture: string;
}

/** A page of another cut's History (`CartonUi.cutHistory`). */
export interface CutHistoryPage {
  readonly cutId: string;
  /** Newest first. */
  readonly versions: readonly Version[];
  /** The next (older) page's cursor; absent: this page reaches the cut's start. */
  readonly before?: number;
  /** That cut's landmarks (the first page only). */
  readonly landmarks?: readonly Landmark[];
}

/** A row of "Choose a clip…" (DESIGN-V2 §3.2; core's BringBackChoice). Seconds; `text` a title's or caption's. */
export interface BringBackChoice {
  readonly itemId: string;
  readonly name: string;
  readonly noun?: string;
  readonly then?: { readonly start?: number; readonly end?: number; readonly text?: string };
  readonly now?: { readonly start?: number; readonly end?: number; readonly text?: string };
  /** Deleted since: by whom and when; not there yet: who added it and when. */
  readonly by?: Actor | null;
  readonly at?: number;
  /**
   * The clip as it is now (N0b): pass it back as `restoreClip`'s `expect`, so a clip that changed again since the
   * confirmation showed is refused ("“Intro” just changed again"), never brought back over the newer edit.
   */
  readonly token: string;
  /** What bringing it back would do (N0b), for the confirmation's line: where it goes, and what else moves. */
  readonly place?: BringBackPlace;
  readonly ripple?: BringBackRipple | null;
}
/**
 * Where a brought-back clip goes (DESIGN-V2 §3.2): its own place, or (`new-track`) a new track just above its own at the
 * same time, its place being taken now by `takenBy` ("Its place is taken by “Drone shot”, so it goes on a new track
 * above, at 0:06"). It never lands on top of another clip.
 */
export interface BringBackPlace {
  readonly placed: "same" | "new-track";
  readonly trackId?: string;
  readonly takenBy?: readonly { readonly itemId: string; readonly name: string }[];
}
/**
 * What else moves (DESIGN-V2 §3.2): deleted with a ripple, the rest of its track moves back `later` ("Everything after it
 * moves 3 s later"); added with one, taking it out moves the rest `earlier`. By `by` seconds from `at`; `moved` clips.
 * Null: nothing else moves.
 */
export interface BringBackRipple {
  readonly direction: "later" | "earlier";
  readonly by: number;
  readonly at: number;
  readonly moved: number;
}
export interface BringBackChoices {
  readonly changed: readonly BringBackChoice[];
  readonly deleted: readonly BringBackChoice[];
  readonly added: readonly BringBackChoice[];
  /** "14 other clips are the same as now." */
  readonly same: number;
}

/**
 * The clip-by-clip match between two versions, in one cut or across cuts (DESIGN-V2 §1.15 `ui.align`): one entry per
 * clip on either side, matched by identity (cuts share ids from the cut they were made from). Seconds. It drives in
 * step by shot, the strip, the jumps and the cut sentences.
 */
export interface AlignEntry {
  readonly item: string;
  readonly name?: string;
  readonly aStart?: number;
  readonly aEnd?: number;
  readonly bStart?: number;
  readonly bEnd?: number;
  /** Its track (b's, else a's). */
  readonly track?: string;
}

/** Bring back one clip's answer (`CartonUi.restoreClip`). */
export interface BringBack extends ActionResult {
  /** `same`: it already was as it was then, nothing made. */
  readonly how: "changed" | "added" | "removed" | "same";
  /** The clip's name ("Intro"). */
  readonly clipName: string;
  /** Where it went and what else moved (N0b), as `BringBackChoice` previewed them. */
  readonly place?: BringBackPlace;
  readonly ripple?: BringBackRipple | null;
}

/**
 * An agent asked the editor to open Compare (`cb compare <a> [b] --show`). The worker sends it to the pages as a
 * `carton:event`: `{ kind: "carton", id: <projectId>, topic: "compare", compare: OpenCompare }`. N1's `openCompare`
 * takes it. A page shows each `request` once, and answers it with the worker's `compareAnswer({ projectId, request,
 * status, why? })`: `opened`, `offered` (a note with Open: the person was busy, `why: "busy" | "viewing" | "playing"`),
 * or `refused` (`why: "not-here"`: a side hasn't reached this computer). DESIGN-V2 §1.13, §5.3.
 */
export interface OpenCompare {
  /**
   * The left and right sides (DESIGN-V2 §1.12: the cut you're on is on the right), refs as History's (`Version.ref`):
   * versions of any two cuts; a cut id is that cut's head ("now"; the current cut's: your edit now).
   */
  readonly from: string;
  readonly to: string;
  /** "versions" (one cut) or "cuts" (two cuts: differences, "Only in …"). */
  readonly between: "versions" | "cuts";
  /** Who asked, as core records it, and in words ("Director", "Claude Code"). */
  readonly by: { readonly kind: string; readonly id: string; readonly name?: string };
  readonly byName: string;
  readonly at: number;
  readonly request: string;
}

// ------------------------------------------------------------ Carton UX v2 (N1): Compare in the editor

/** How the stage shows the two sides (DESIGN-V2 §1.3): two players, a wipe, or a flip (hold B). */
export type CompareMode = "side" | "wipe" | "flip";

/**
 * One side of a comparison, named once (DESIGN-V2 §1.7: the chip, the players' labels and the panel's range line say
 * the same). `left` is the other version or the other cut; `right` is what the editor's timeline shows (your edit, or
 * the cut you're on, whenever it is one of the two).
 */
export interface CompareEnd {
  /** The state (History's `Version.ref`, of any cut). */
  readonly ref: string;
  /** In a sentence: "“Sent to client”", "your edit", "Main cut", "“30s Instagram cut”", "Leo's Main cut". */
  readonly label: string;
  /** Its player's bold part and what follows: "Sent to client" · "yesterday at 4:10 pm"; "Your edit now". */
  readonly title: string;
  readonly detail?: string;
  /** The cut it is on (`Cut.id`), when known. */
  readonly cutId?: string;
  /** Your edit now: the newest state of the cut you're on (the editor shows it, read-only while comparing). */
  readonly you?: boolean;
  /** History's row, when it is one of the current cut's versions. */
  readonly versionId?: string;
}

/** What is being compared (`CartonUi.comparing()`): its two sides, the mode shown, and who opened it. */
export interface Comparing {
  readonly left: CompareEnd;
  readonly right: CompareEnd;
  readonly mode: CompareMode;
  /** The two sides are on different cuts: the count says "differences", the sentences where a clip is (§1.12). */
  readonly acrossCuts: boolean;
  /** An agent opened it (`OpenCompare.byName`): its toast named it, and History closes again on exit if it opened it. */
  readonly by?: string;
}

/** `openCompare`'s options. */
export interface OpenCompareOptions {
  /** Start in this mode (else the one last picked; the stage's width rule wins, §1.3). */
  readonly mode?: CompareMode;
  /** Put both players here: seconds on the right side's time (a card's ⇆ Side by side, at the spot it was playing). */
  readonly at?: number;
  /** Start Play both once it is open (a card's ⇆ Side by side while its Play runs: "still playing"). */
  readonly play?: boolean;
  /** Opened from the Fold in dialog: the change list's footer offers Back to Fold in…, which reopens it with `fold`'s pair. */
  readonly back?: "fold";
  readonly fold?: { readonly from: string; readonly into: string };
  /** An agent's request (`OpenCompare`): who asked, in words; the page opens it only when the person is idle (§1.13). */
  readonly by?: string;
  /** An agent's request id: each is shown once. */
  readonly request?: string;
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
  /** Who made its newest version (the cuts menu's "Director · 2 h ago", DESIGN §6.3), when known. */
  readonly updatedBy?: Actor;
  /**
   * Its colour dot (DESIGN §4.1): every cut but Main has one, the same in the title bar's chip, the cuts menu and the
   * History cut bar. None for Main cut. A host that leaves it out gets `cutColor()`'s (cuts.ts) from the id.
   */
  readonly color?: string;
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
  /** When that earlier partial fold left it out (ms since the epoch): "Left out on Oct 30". */
  readonly leftOutAt?: number;
  /**
   * The change as a change row (PLAN 0.1, DESIGN §6.4): its place in the edit, the kind of clip and what happened, for
   * the Fold dialog's rows. `summary` stays the sentence; without this the row shows the sentence alone.
   */
  readonly change?: Change;
}

/** How the two cuts of a fold are related (DESIGN §6.4's line): one was made from the other, at `at`. */
export interface FoldMade {
  /** "from": the cut folded in was made from the cut it goes into; "into": the other way round. */
  readonly which: "from" | "into";
  /** When it was made (ms since the epoch). */
  readonly at: number;
}

export interface FoldPlan {
  readonly from: Cut;
  readonly into: Cut;
  /** How the cuts are related, when one was made from the other ("since it was made from Main cut at 12:20 pm"). */
  readonly made?: FoldMade;
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

export interface FoldResult extends ActionResult {
  readonly ok: boolean;
  /** Cards the fold left for the person, if any. */
  readonly conflicts?: readonly Conflict[];
  readonly error?: string;
}

/**
 * What an action wrote (PLAN 5.3): the versions it made, on the cut it made them on, by their change ids, oldest
 * first. A toast's Undo takes back exactly these, through Ctrl+Z's own path, and only while they are still the newest
 * things Ctrl+Z would take back on that cut (the host checks, where the history is). A fold with what earlier partial
 * folds left out makes more than one.
 */
export interface Made {
  readonly cut: string;
  readonly changes: readonly string[];
  /**
   * The step that takes it back, when it isn't Ctrl+Z's undo: an undo of a whole agent turn is itself an undo (core
   * keeps it off the undo stack), so redo puts the turn back. A toast's Undo then runs redo, the editor's own redo.
   */
  readonly by?: "redo";
}

/**
 * An action's answer (restore, fold, a conflict pick, Undo this turn). `made` is absent when it made no version: a
 * conflict pick of the side already in the timeline commits nothing, so there is nothing of its own to undo (an Undo
 * there would take back an earlier change).
 */
export interface ActionResult {
  readonly made?: Made;
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
  | "working"
  /** Landmarks changed (one recorded: an export, a send; a new version can be one too): read `landmarks()` again. */
  | "landmarks";

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

  /**
   * Switch to a cut. `onlyFrom`: only if the cut you're on is still that one (a switch queued behind an agent's turn,
   * cuts.ts switchWhenDone): checked where the cut is known (the worker), so a switch made meanwhile, by hand or by `cb
   * cut switch`, wins; it resolves without switching then.
   */
  switchCut(cutId: string, opts?: { onlyFrom?: string }): Promise<void>;
  newCut(name: string, fromRef: string): Promise<Cut>;
  /** Absent when the engine can't rename cuts yet: the Cuts menu then doesn't offer it. */
  renameCut?(cutId: string, name: string): Promise<void>;
  /**
   * Fold `from` into `into`, leaving out the changes in `leaveOut` (partial accept). `count`: how many changes the
   * person was told it folds in (the Fold dialog's button, Workstream 6's count): its confirmation says the same. The
   * engine doesn't read it.
   */
  fold(fromCutId: string, intoCutId: string, opts: { leaveOut: readonly string[]; choices: Readonly<Record<string, ConflictChoice>>; allCards?: boolean; count?: number }): Promise<FoldResult>;
  /** Keep one side of a card. Says what it made (`made`), if anything: the side already shown makes nothing. */
  resolve(conflictId: string, choice: ConflictChoice): Promise<ActionResult | void>;
  /** "Fold in the rest" of a partial fold: the changes its inverse version left out. */
  foldRest(versionId: string): Promise<FoldResult>;
  /** Restore a version as a new one on top. Says what it made (`made`). */
  restore(ref: string): Promise<ActionResult | void>;
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
   * counts them, so `.length` is the count shown everywhere. Cached per (a, b). Plain data across `remote.ts`. `a` and
   * `b` may be on two cuts; `between: "cuts"` words them as differences (DESIGN-V2 §1.12: "Only in Main cut: “Drone
   * shot”", "“Intro” ends at 0:05 here, 0:03 in “30s Instagram cut”"), `a` the left side.
   */
  changes(a: string, b: string, opts?: { between?: "versions" | "cuts" }): Promise<readonly Change[]>;
  /**
   * What the changes from `a` to `b` came to, in one line as a version's title says it ("Moved “B2” and trimmed
   * “Intro”"), and how many: a person's group of edits in History (from before its oldest to its newest), so its title
   * never states a step the group undid. 0 changes: the group changed nothing in the end. Optional.
   */
  netWords?(a: string, b: string): Promise<{ summary: string; changes: number }>;
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
   * filter (`{ item }`). Never diffs every version. `after` (a version id): only the versions newer than it, for a
   * filter that already holds the rest.
   */
  clipVersions(itemId: string, opts?: { after?: string }): Promise<ClipVersions>;
  /**
   * "See it": a ref of the cut with one side of a card kept, for openPreview (the side shown now is head itself; the
   * other a held state with that side applied). Null when the card is gone. Optional: a host without it shows no
   * Preview.
   */
  conflictRef?(conflictId: string, side: ConflictChoice): Promise<string | null>;
  /** The host saw an edit attempt while viewing: the stage then explains and offers "Back to my edit". */
  blockEdit(): void;

  // Carton UX v2 (N0). Optional: a host without them shows no find box, landmarks or "Bring back".
  /**
   * Find in the current cut's History: names, turn prompts, people, clips by name, title and caption text. Newest
   * first. An empty `text` warms the index and finds nothing (call it when the find box gets focus).
   */
  find?(text: string, opts?: { limit?: number; before?: number; fields?: readonly FindField[]; allCuts?: boolean }): Promise<FindHits>;
  /** The current cut's landmarks, newest first. Topic "landmarks" says when to read them again. */
  landmarks?(opts?: { kinds?: readonly LandmarkKind[]; limit?: number }): Promise<readonly Landmark[]>;
  /**
   * Bring back one clip as it was in version `ref`, as a new version on top (Ctrl+Z takes it back). `remove`: the clip
   * wasn't there then, so bringing it back removes it (only when the person said so: without it, the call rejects
   * with the words that say so).
   */
  restoreClip?(ref: string, itemId: string, opts?: { remove?: boolean; expect?: string }): Promise<BringBack>;
  /** "Choose a clip…" (DESIGN-V2 §3.2): the clips that differ between version `ref` and your edit now. */
  bringBackChoices?(ref: string): Promise<BringBackChoices>;
  /**
   * Another cut's History, a page at a time, newest first (Carton UX v2 N2c: "Compare with…" picks a version on any cut).
   * Its versions are History's rows as the panel shows them (words, author, time); `before`: the next page's cursor
   * (pass it back), absent at the cut's start; `landmarks` on the first page. Read only when asked: never kept.
   */
  cutHistory?(cutId: string, opts?: { before?: number; limit?: number }): Promise<CutHistoryPage>;
  /** The clip-by-clip match between two versions, any two cuts (DESIGN-V2 §1.15). Cached per (a, b). */
  align?(a: string, b: string): Promise<readonly AlignEntry[]>;
  /** A landmark's picture (`Landmark.picture`) as a `data:image/jpeg` URL, or null when none was made yet. */
  landmarkPicture?(key: string): Promise<string | null>;
  /** Keep a landmark's picture (a `data:image/jpeg` URL, at most 64 KB), made from the stage the first time it shows. */
  saveLandmarkPicture?(key: string, jpeg: string): Promise<void>;

  // Carton UX v2 (N1): Compare in the editor. The host's (the app's page: scripts/carton/compare.js), not the worker's:
  // optional, and a host without them keeps the panel's own Changes view.
  /**
   * Compare two states on the stage, the timeline and the panel (DESIGN-V2 §1). `from` and `to` are refs of any cut
   * (History's `Version.ref`; a `Cut.id` is that cut's head; `null`/absent `to` is your edit now). The sides are put
   * the right way round (§1.1): your edit, or the cut you're on, goes right; of two versions of one cut the older goes
   * left. Opening it ends viewing; opening it again replaces the comparison. Resolves once it is shown (the stage
   * swapped); rejects when a side can't be loaded, and nothing changed then.
   */
  openCompare?(from: string, to?: string | null, opts?: OpenCompareOptions): Promise<void>;
  /** Done comparing (Esc, the chip's ✕, ← History): your edit again, on the cut you were on. */
  closeCompare?(): Promise<void>;
  /** What is compared, or null. Its changes: `onCompare`. */
  comparing?(): Comparing | null;
  /** Told when `comparing()` changes. */
  onCompare?(f: () => void): () => void;
}
