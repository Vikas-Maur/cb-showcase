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
  // Every agent's turns (UI audit P1-10): the Director's and your Claude Code's are both named turns, and an agent's
  // versions with no turn recorded are its turn too
  historyFilters: { all: "All", named: "Named", turns: "Agent turns" } as Record<"all" | "named" | "turns", string>,
  historyEmpty: "No versions yet. A version is saved after every edit and every Director turn.",
  historyEmptyNamed: "No named versions yet. Name one to find it again.",
  historyEmptyTurns: "No agent turns yet.",
  checkpoint: "Checkpoint",
  // Day headers in a long History (UI audit P2-17)
  today: "Today",
  yesterday: "Yesterday",
  dayCount: (n: number) => plural(n, "version", "versions"),
  dayFolded: (n: number, named: number) => `${plural(n, "version", "versions")}${named ? ` · ${named} named` : ""}`,
  // A version of several changes: its list, on expand (UI audit P1-5)
  versionChanges: (n: number) => plural(n, "change", "changes"),
  showChanges: (n: number) => (n === 1 ? "Show the change" : `Show all ${n} changes`),
  hideChanges: (n: number) => (n === 1 ? "Hide the change" : "Hide the changes"),
  turnEdits: (n: number) => plural(n, "edit", "edits"),
  provisional: "Waiting to sync",
  provisionalHint: "This version gets its final place in History once it reaches the server.",
  restore: "Restore",
  preview: "Preview",
  create: "Create",
  restoreHint: "Restoring saves this version as a new version. Nothing is lost.",
  emptyVersionHint: "The history starts here, before the project was added. There's nothing to restore.",
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
  // A change an earlier "fold in some of it" left out (UI audit P1-4): offered again; one fold's come in together
  foldLeftOutEarlier: "Left out earlier",
  foldLeftOutTogether: "Left out together earlier, so they fold in together.",
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
  // Compare's clip count with the other kinds of item apart (laptop re-check P3-10): "1 clip, 6 titles"
  clipsAnd: (clips: number, kinds: readonly { noun: string; n: number }[]) =>
    [...(clips || !kinds.length ? [plural(clips, "clip", "clips")] : []), ...kinds.map((k) => plural(k.n, k.noun, `${k.noun}s`))].join(", "),
  length: (s: number) => duration(s),
  // The Compare card's summary (UI audit P2-5): changes and seconds, as Watch the changes counts them; never shots.
  compareSummary: (changes: number | null, s: number, total: number) =>
    changes === 0 || (changes == null && s <= 0) ? "No differences" : `${changes == null ? "" : `${plural(changes, "change", "changes")} · `}${seconds(s)} of ${seconds(total)} differ`,
  compareChanges: "What changed",
  compareMore: (n: number) => `Show ${n} more`,
  compareLess: "Show fewer",
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
  // The counter steps through the sections of the edit that differ, not the changes (laptop re-check P3-11: "2 changes ·
  // Change 1 of 2" beside Compare's "3 changes"): one section can hold several changes, and a change can show nowhere.
  changeOf: (i: number, n: number) => `Section ${i} of ${n}`,
  nextChange: "Next section",
  previousChange: "Previous section",
  noChanges: "No changes to watch. The two versions look the same.",
  // What differs: changes, counted as Compare and History count them, and seconds; never shots.
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
  returnToCurrentKey: "Return to current (Esc)",
  previewBlocked: "This is a preview, so edits don't apply here.",

  // Times
  justNow: "just now",
  loading: "Loading…",
  failed: "Something went wrong. Try again.",

  // ------------------------------------------------------------------------------------------------------------------
  // The redesign's words (DESIGN §8, PLAN 0.3). Counted in "changes" everywhere; "version" only for a folded day.
  // A version is named by versionLabel() (format.ts) and a moment by clock(): these take their results.

  // Title bar
  backToMyEdit: "Back to my edit",
  backToMyEditKey: "Back to my edit (Esc)",
  versionHistory: "Version history (Ctrl+Shift+H)",
  share: "Share",
  hereNames: (names: readonly string[]) => `${names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`} ${names.length === 1 ? "is" : "are"} here`,
  offlineNotSent: (n: number) => (n ? `Offline: ${plural(n, "change", "changes")} not sent yet` : "Offline"),

  // Cuts menu
  fromTeammates: "From teammates",
  viewOnly: "View only",
  cutWho: (who: string, when: string) => `${who} · ${when}`,
  now: "now",
  workingNow: "working now",
  newCutFromYourEdit: "New cut from your edit",
  foldInFromCut: "Fold in changes from a cut…",
  renameCutNamed: (name: string) => `Rename “${name}”`,
  openHistory: "Open History",
  agentsWorkHere: "Agents work on the cut you're on.",
  workingOnCut: (agent: string, cut: string) => `${agent} is working on ${cut}, and agents work on the cut you're on.`,
  switchWhenDone: "Switch when it finishes",
  switchNow: "Switch now",

  // History head and filter
  comments: "Comments",
  show: "Show",
  filters: { all: "All versions", named: "Named versions", turns: "Agent turns", mine: "Your changes" } as Record<"all" | "named" | "turns" | "mine", string>,
  onlyClip: (clip: string) => `Only “${clip}”`,
  onlyClipHint: "The clip selected on the timeline",
  removeFilter: "Show all versions",
  clipSince: (when: string) => `Versions since ${when} only`,
  filterEmpty: { all: "No versions yet.", named: "No named versions yet. Name one to find it again.", turns: "No agent turns yet. When an agent edits, its turn shows here.", mine: "No changes of yours yet." } as Record<"all" | "named" | "turns" | "mine", string>,
  clipEmpty: (clip: string) => `No versions changed “${clip}” yet.`,

  // Rows
  nowRow: "Now",
  viewingMark: "Viewing",
  working: "Working",
  changes: (n: number) => plural(n, "change", "changes"),
  changesOf: (n: number, of: number) => `${n} of ${plural(of, "change", "changes")}`,
  namedBy: (who: string) => `Named by ${who}`,
  notSentYet: "Not sent yet",
  notSentHint: "This version gets its final place in History once it's sent.",
  availableOnceSent: "Available once it's sent",
  projectCreated: "Project created",
  historyStartsHere: "History starts here",
  startOn: (title: string, day: string) => `${title} · ${day}`,
  groupOpen: (n: number) => `Show these ${plural(n, "change", "changes")}`,

  // Days
  dayVersions: (n: number, named: number) => `${plural(n, "version", "versions")}${named ? ` · ${named} named` : ""}`,
  newest: "Newest",

  // An agent working
  changesSoFar: (n: number) => `${plural(n, "change", "changes")} so far`,
  keepEditing: (agent: string) => `Keep editing. ${agent} sees your changes when its turn ends.`,

  // Empty and loading
  historyEmptyTitle: "Your edit's history starts here",
  historyEmptyBody: "Every change, yours or an agent's, is saved as a version. Look back at any of them, play what changed, or restore one. Nothing is lost.",
  cutStarted: (cut: string, when: string) => `${cut} · started ${when}`,
  todayAt: (time: string) => `today at ${time}`,

  // Version card
  changesSince: (n: number) => `Your edit has ${plural(n, "change", "changes")} since this`,
  seeThem: "See them",
  andMore: (n: number) => `and ${n} more`,
  playAll: "Play all",
  playThisChange: "Play this change",
  beforeHint: "Hold to see how it was before (or press B)",
  restoreEllipsis: "Restore…",
  undoThisTurn: "Undo this turn",
  undoThisTurnHint: (n: number) => `Takes out only ${n === 1 ? "this change" : `these ${n} changes`}. Later changes stay.`,
  changesIn: (label: string) => `Changes in ${label}`,
  noPosition: "—",
  // A change row's kind chip, for screen readers ("Title, added"): the chip itself is colour and a corner mark
  clipKinds: { video: "Video", title: "Title", caption: "Caption", audio: "Audio", image: "Image", code: "Code graphic", project: "Project" } as Record<"video" | "title" | "caption" | "audio" | "image" | "code" | "project", string>,
  changeKinds: { add: "added", remove: "removed", change: "changed" } as Record<"add" | "remove" | "change", string>,
  changeChip: (clip: string, kind: string) => `${clip}, ${kind}`,
  // A change's who and when, under its sentence when a list mixes authors: "Claude Code · 12:48 pm"
  changeWho: (who: string, when: string) => (who ? `${who} · ${when}` : when),
  // An older version whose state your edit still has: no "N changes since"
  sameSinceThis: "Your edit is the same as this version",
  // A card's list of changes that is long: the rest in the Changes view
  seeAll: (n: number) => `See all ${n}`,
  showLess: "Show fewer",
  loadingChanges: "Reading what changed",
  noChangesInVersion: "Nothing in the edit changed.",
  // An action that failed, in its card, with the reason in its tooltip (DESIGN §6.1 Errors)
  undoTurnFailed: "Couldn't undo this turn. Try again.",
  newCutFailed: "Couldn't make the cut. Try again.",
  // The live row of an agent working: its mark ringed in green, for screen readers
  agentWorking: (agent: string) => `${agent} is working`,
  // The credits of the clip History is filtered to (PLAN 0.8, 9.2): "Added by You on Oct 30 · trimmed by Director"
  creditVerb: { Added: "added", Timing: "retimed", Text: "text changed", Color: "color changed", Volume: "volume changed", Name: "renamed" } as Record<string, string>,
  creditPart: (verb: string, who: string, when: string) => `${verb} by ${who}${when ? ` ${when}` : ""}`,
  creditOn: (day: string) => `on ${day}`,
  creditAt: (time: string) => `at ${time}`,
  // Group rows (DESIGN §6.1): the chevron that lists a person's run of changes, one by one
  groupClose: (n: number) => `Hide these ${plural(n, "change", "changes")}`,
  // History list's live region and keys
  historyKeys: "Enter opens a version, Space plays it, F2 names it",
  cardRegion: (label: string) => `Changes in ${label}`,

  // Row menu
  playItsChanges: "Play its changes",
  compareWithYourEdit: "Compare with your edit",
  renameEllipsis: "Rename…",
  newCutFromVersion: "New cut from this version…",
  restoreMenuHint: "Go back to this version. Later changes stay in History.",

  // Restore confirmation
  restoreQuestion: (label: string) => `Restore ${label}?`,
  restoreBody: (n: number) =>
    n
      ? `Your edit goes back to how it was then. The ${plural(n, "change", "changes")} made since ${n === 1 ? "is" : "are"} undone. ${n === 1 ? "It stays" : "They stay"} in History, and Ctrl+Z brings ${n === 1 ? "it" : "them"} back.`
      : "Your edit goes back to how it was then. Ctrl+Z brings it back.",
  seeThe: (n: number) => `See the ${n}`,

  // Name and new cut
  newCutTitle: "New cut from this version",
  newCutSwitch: (cut: string) => `You'll switch to it. ${cut} stays as it is.`,
  makeCut: "Make cut",

  // Changes view
  changesSinceTitle: (when: string) => `Changes since ${when}`,
  changesFromTo: (from: string, to: string) => `From ${from} to ${to}`,
  changesBetween: (from: string, to: string) => `Changes from ${from} to ${to}`,
  yourEditNow: "your edit now",
  changesLength: (n: number, length: string) => `${plural(n, "change", "changes")} · ${length}`,
  noChangesSince: (when: string) => `No changes since ${when}`,
  sameAs: (label: string) => `Your edit is the same as ${label}.`,
  restoreThisVersion: "Restore this version…",
  backToHistory: "History",

  // Viewing
  beforeOf: (label: string) => `Before ${label}`,
  ownedCut: (owner: string, cut: string) => `${owner}'s ${cut}`,
  sideOf: (who: string, what: string, clip: string) => `${who}'s ${what} of “${clip}”`,
  yourSideOf: (what: string, clip: string) => `Your ${what} of “${clip}”`,
  lookingAt: (label: string) => `You're looking at ${label}.`,
  lookingAtAnnounce: (label: string) => `Looking at ${label}. Esc to go back.`,
  backAnnounce: "Back to your edit",
  backToExport: "Back to your edit to export it.",
  loadFailed: "Couldn't load this version. Try again.",
  readOnlyRole: "You can watch and comment on this project, not edit it.",

  // Conflict card
  bothDid: (clip: string, other: string, verb: string) => `“${clip}”: you and ${other} both ${verb} it`,
  pickLead: "Pick the one to keep. Until you pick, yours is in the timeline.",
  yours: "Yours",
  theirs: (name: string) => `${name}'s`,
  both: "Both",
  yourEarlier: "Your earlier change",
  yourLater: "Your later change",
  seeIt: "See it",
  seeingIt: "Seeing it",
  keepTheirs: (name: string) => `Keep ${name}'s`,
  onTimeline: "On timeline",
  notNow: "Not now",
  conflictsToPick: (n: number) => `${plural(n, "conflict", "conflicts")} to pick`,
  stillWorking: (agent: string) => `${agent} is still working. Pick now, or when it's done.`,
  changedAgain: (agent: string) => `${agent} changed it again. Pick again.`,

  // Fold dialog
  foldInChanges: "Fold in changes",
  foldFrom: "From",
  foldIntoWord: "into",
  youreOnIt: "you're on it",
  foldWhat: (into: string, from: string, made: string) => `${into} gets what changed on “${from}” since it was made from ${made}.`,
  cantLeaveOut: "Can't be left out: it's a setting for the whole project",
  leftOutOn: (day: string) => `Left out on ${day}`,
  leftOutTogether: "These were left out together, so they come in together.",
  bothCutsDid: (verb: string, clip: string) => `Both cuts ${verb} “${clip}”. Pick one:`,
  pickOneFor: (clip: string) => `Pick one for “${clip}”`,
  leftOutLine: (n: number, from: string) => `${plural(n, "change is", "changes are")} left out. ${n === 1 ? "It stays" : "They stay"} on “${from}”, and you can fold ${n === 1 ? "it" : "them"} in later.`,
  foldUndoLine: "Ctrl+Z takes the whole fold back.",
  foldInN: (n: number) => `Fold in ${plural(n, "change", "changes")}`,
  alreadyHas: (into: string, from: string) => `${into} already has everything from “${from}”.`,

  // Toasts (DESIGN §6.7)
  undo: "Undo",
  redo: "Redo",
  restoredToast: (label: string) => `Restored ${label}. Later changes are in History.`,
  foldedToast: (n: number, from: string, into: string) => `Folded ${plural(n, "change", "changes")} from “${from}” into ${into}.`,
  switchToCut: (cut: string) => `Switch to ${cut}`,
  onCutNow: (cut: string) => `You're on “${cut}” now.`,
  cutUnchanged: (cut: string) => `${cut} is unchanged.`,
  switchBackTo: (cut: string) => `Switch back to ${cut}`,
  keptToast: (label: string) => `Kept ${label}.`,
  tookOutToast: (label: string, n: number) => `Took out ${label} (${plural(n, "change", "changes")}).`,
  restoreUndone: "Restore undone.",
  foldUndone: "Fold undone.",
  saveFailed: "Your last change wasn't saved. Do it again, or reopen the project.",
  restoreFailed: "Couldn't restore this version. Try again.",

  // Share and Join
  shareTitle: (project: string) => `Share “${project}”`,
  shareLead: "Edit together, live, with the whole history. Teammates get preview copies of your video; the originals stay on this computer.",
  sharingServer: "Sharing server",
  sharingServerHint: "The address whoever runs your sharing server gave you.",
  change: "Change",
  yourName: "Your name",
  yourNameHint: "Teammates see this beside your changes.",
  shareProject: "Share project",
  people: "People",
  roles: { owner: "Owner", editor: "Can edit", commenter: "Can comment", viewer: "Can watch" } as Record<"owner" | "editor" | "commenter" | "viewer", string>,
  hereNowLine: "Here now",
  lastHereYesterday: "Last here yesterday",
  invite: "Invite",
  copyLink: "Copy link",
  copied: "Copied",
  anyoneCanJoin: "Anyone with this link can join and edit.",
  sending: (n: number) => `Sending ${plural(n, "change", "changes")}`,
  offlineLine: (n: number) => `You're offline. Keep editing: ${plural(n, "change is", "changes are")} saved here and ${n === 1 ? "is" : "are"} sent when you're back.`,
  joinTitle: "Join a shared project",
  joinLead: "Paste the invite link a teammate sent you. The project comes with its history; its footage arrives as their computer sends it.",
  inviteLink: "Invite link",
  joinAs: (name: string) => `You'll join as ${name}.`,
  joinAndOpen: "Join and open",

  // Stage
  offlineChip: (n: number) => `Offline · ${plural(n, "change", "changes")} not sent yet`,
  clipsOnTheirWay: (n: number, from: string) => `${plural(n, "clip is", "clips are")} still on ${n === 1 ? "its" : "their"} way from ${from}`,
  clipsOfflineUntil: (names: string) => `${names} show as Offline until they arrive. Nothing was removed.`,
};

export type Words = typeof words;
