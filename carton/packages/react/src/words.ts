// Every word the components show, in one place. They are the editor words the user chose for Carton (PLAN §0.1),
// never git's. A host can pass its own copy (for another language) to <CartonProvider words>.

import { duration, seconds } from "./format.ts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const words = {
  // §0.1 nouns
  history: "History",
  version: "Version",
  cut: "Cut",
  cuts: "Cuts",
  mainCut: "Main cut",
  directorsCut: "Director's cut",
  publishedCut: "Published cut",
  credits: "Credits",
  live: "Live",
  you: "You",

  // History panel
  historyFilters: { all: "All", named: "Named", turns: "Director turns" } as Record<"all" | "named" | "turns", string>,
  historyEmpty: "No versions yet. A version is saved after every edit and every Director turn.",
  historyEmptyNamed: "No named versions yet. Name one to find it again.",
  historyEmptyTurns: "No Director turns yet.",
  checkpoint: "Checkpoint",
  turnEdits: (n: number) => plural(n, "edit", "edits"),
  provisional: "Waiting to sync",
  provisionalHint: "This version gets its final place in History once it reaches the server.",
  restore: "Restore",
  preview: "Preview",
  create: "Create",
  restoreHint: "Restoring saves this version as a new version. Nothing is lost.",
  compareWithCurrent: "Compare with current",
  nameVersion: "Name this version",
  nameVersionPlaceholder: "Sent to client, Monday",
  rename: "Rename",
  save: "Save",
  cancel: "Cancel",
  close: "Close",
  more: "More",
  versionActions: (label: string) => `Actions for ${label}`,
  published: "Published",

  // Cuts menu
  newCutFromHere: "New cut from here",
  newCutName: "Name of the new cut",
  newCutPlaceholder: "30s Instagram cut",
  switchTo: (name: string) => `Switch to ${name}`,
  renameCut: "Rename cut",
  foldInto: (into: string) => `Fold into ${into}`,
  foldInHere: (from: string) => `Fold “${from}” in here`,
  readOnlyCut: "From someone else's copy. You can watch it and fold it in.",
  currentCut: "Current cut",
  qualified: (owner: string, name: string) => `${owner}'s ${name}`,
  offlineCut: (date: string) => `Offline edits (${date})`,

  // Fold in dialog
  foldTitle: (from: string, into: string) => `Fold “${from}” into “${into}”`,
  foldAll: "Fold in",
  foldSome: (n: number, of: number) => `Fold in ${n} of ${of}`,
  foldSomeOfIt: "Fold in some of it",
  foldNothing: "Nothing to fold in. The cuts are the same.",
  foldAllOrNothing: "These changes can only be folded in together.",
  foldAllCards: "Bring it in with every difference shown as a card",
  foldRestLater: "You can fold in the rest later.",
  foldRest: "Fold in the rest",
  foldChangedSince: "Something changed since you looked. Pick on the cards below, then fold in.",
  foldLocked: "Comes with the rest: it can't be left out on its own.",
  foldChanges: (n: number) => plural(n, "change", "changes"),
  foldConflicts: (n: number) => `${plural(n, "conflict card", "conflict cards")} to pick`,
  foldWarnings: "Check after folding in",
  folding: "Folding in…",
  foldDone: "Folded in",
  selectAll: "Select all",
  selectNone: "Select none",

  // Conflict cards
  conflictCard: "Conflict card",
  conflictLead: "Two different edits. Pick one.",
  // Each choice says whose edit and, in a fold, which cut, so "mine" never has to be guessed: the cut I'm in, or the
  // clip's author? (PLAN §2.6 "Keep mine/theirs/both", made explicit.)
  keepYours: (where?: string) => (where ? `Keep yours (${where})` : "Keep yours"),
  keepOf: (name: string, where?: string) => `Keep ${name}'s${where ? ` (${where})` : ""}`,
  keepBoth: "Keep both",
  // Two sides by the same person (two of your own edits): told apart by order, never two identical buttons.
  earlierEdit: (who: string | null, at?: string) => `${who ? `${who}'s` : "Your"} earlier edit${at ? ` (${at})` : ""}`,
  laterEdit: (who: string | null, at?: string) => `${who ? `${who}'s` : "Your"} later edit${at ? ` (${at})` : ""}`,
  keepEarlier: "Keep earlier",
  keepLater: "Keep later",
  showingNow: "Showing now",
  // "See it" (a card's sides on the timeline): a read-only preview with that side kept, or the clip selected
  seePreview: "Preview",
  yourEdit: "Your edit",
  theirEdit: (name: string) => `${name}'s edit`,
  seePreviewOf: (side: string) => `Preview: ${side}`,
  showOnTimeline: "Show on timeline",
  // The floating stack of cards: collapsed to a pill; a card set aside stays reachable from it, never decided
  conflictsPill: (n: number) => plural(n, "conflict", "conflicts"),
  hideConflicts: "Hide conflicts",
  setAside: "Not now",
  setAsideHint: "Set aside for now. It stays open, under the conflicts pill.",
  setAsideList: (n: number) => `Set aside (${n})`,
  showAgain: "Show again",
  conflictsWaiting: (n: number) => `${plural(n, "conflict card", "conflict cards")} waiting`,

  // Compare card
  compare: "Compare",
  watchTheChanges: "Watch the changes",
  clips: (n: number) => plural(n, "clip", "clips"),
  length: (s: number) => duration(s),
  differ: (shots: number, s: number, total: number) =>
    shots === 0 ? "No shots differ" : `${plural(shots, "shot", "shots")} / ${seconds(s)} of ${seconds(total)} differ`,
  current: "Current",
  factWhen: "When",
  factWho: "Who",
  factClips: "Clips",
  factLength: "Length",

  // Credits
  creditsFor: (clip: string) => `Credits for ${clip}`,
  creditsEmpty: "No changes recorded for this clip yet.",
  startedBy: (name: string) => `started by ${name}`,

  // Undo turn (§8)
  undoTurn: "Undo turn",
  undoLabel: (who: string, label: string) => `Undo ${who}: ${label}`,
  undoNothing: "Nothing of yours to undo",
  undoConflict: "Someone changed this since. Pick on the conflict card.",

  // Published cut
  publishedAs: (name: string) => `Published: ${name}`,
  newerEdits: "Newer edits exist",
  newerEditsCount: (n: number) => `${plural(n, "newer version", "newer versions")} not published`,
  newerEditsHint: "The share link shows an earlier version of this cut.",
  upToDatePublished: "The share link shows the newest version",
  publishAgain: "Publish again",
  publish: "Publish",
  openShareLink: "Open share link",
  notPublished: "Not published",

  // Presence
  hereNow: (n: number) => `${n} here now`,
  idle: "Idle",
  more_: (n: number) => `+${n}`,
  dragging: (name: string) => `${name} is moving this`,

  // Sync status words (§0.1, §13): status words only, never push/pull
  syncing: "Syncing",
  upToDate: "Up to date",
  offline: (n: number) => (n === 0 ? "Offline" : `Offline: ${plural(n, "edit", "edits")} waiting`),
  syncingHint: "Your edits are on this computer and are being sent.",
  upToDateHint: "Everyone on this cut sees the same edit.",
  offlineHint: "Keep editing. Your edits are saved here and sent when you're back online.",

  // Watch the changes (§9)
  before: "Before",
  after: "After",
  playChanges: "Play changes",
  pause: "Pause",
  unchangedShots: (n: number) => `${plural(n, "unchanged shot", "unchanged shots")}`,
  removed: "Removed",
  added: "Added",
  changed: "Changed",
  changeOf: (i: number, n: number) => `Change ${i} of ${n}`,
  nextChange: "Next change",
  previousChange: "Previous change",
  noChanges: "No changes to watch. The two versions look the same.",
  // What differs, in the same unit as the "Change 1 of N" counter beside it: changes and seconds, never shots.
  watchSummary: (changes: number, s: number, total: number) =>
    changes === 0 ? "No differences" : `${plural(changes, "change", "changes")} · ${seconds(s)} of ${seconds(total)}`,
  // The host shows the side in its own player (Cardboard: the editor's preview, read-only), so the panel says so.
  shownInPlayer: "Shown in the player, read-only",
  noPicture: "Preview not available here",

  // Read-only preview (§9, R2-16)
  // Mid-sentence, "Your edit" / "Your earlier edit" read lower-case: "Previewing your edit".
  previewing: (label: string) => `Previewing ${label.replace(/^Your\b/, "your")}`,
  // A version as the banner names it (UI audit P2-7): "the version from 12:41 (Claude Code)".
  versionFrom: (time: string, who: string) => (who ? `the version from ${time} (${who})` : `the version from ${time}`),
  readOnly: "Read-only",
  returnToCurrent: "Return to current to edit",
  previewBlocked: "This is a preview, so edits don't apply here.",

  // Times
  justNow: "just now",
  loading: "Loading…",
  failed: "Something went wrong. Try again.",
};

export type Words = typeof words;
