// @carton/react: headless hooks and unstyled components for Carton (PLAN §9, §10, §12, §13): History, Cuts, Fold
// in, conflict cards, the Changes view with Play and Before, Credits, Undo turn, the published cut, live presence and
// the sync status words. `react` is a peer dependency and everything also runs under `preact/compat` (Cardboard's renderer
// gets a Preact root in our Windows build). The components read a small view model (`CartonUi`, model.ts):
// `fromCarton()` builds it from a real Carton handle, and `@carton/react/mock` makes one for galleries and tests.
// The look comes from a skin: `@carton/react/skin/cardboard` matches Cardboard. Owner: ui.

export type * from "./model.ts";
export { TopicHub } from "./hub.ts";
export { words, type Words } from "./words.ts";
export { duration, seconds, when, exactTime, shortDate, clock, clockOfDay, clockTime, versionLabel, versionShort, shortPrompt, timecode, type LabelContext, type ClockWords } from "./format.ts";
export { actorColor, actorLabel, actorDetail, actorChain, agentOf, firstName, initials } from "./actors.ts";
export { alignRows, diffSummary, mapTime, playlist, segmentAt, rowRange, columns, type Row, type Segment, type Column } from "./shots.ts";
export { VirtualList, windowRange, type VirtualListProps } from "./virtual.ts";
export { Icon, type IconName } from "./icons.ts";
export {
  CartonProvider,
  useCartonUi,
  useWords,
  useLocale,
  useTopic,
  useTopicSelector,
  useSyncStatus,
  useCuts,
  useCurrentCut,
  usePeers,
  useGhosts,
  useConflicts,
  useUndoTurn,
  usePublished,
  usePreview,
  useViewing,
  useWorking,
  useHistoryCount,
  useVersionAt,
  useNow,
  useAsync,
  useAction,
  type CartonProviderProps,
  type AsyncState,
} from "./hooks.ts";
export { Avatar, ActorName, HoverMore, Button, Dialog, MenuButton, MenuItem, MenuList, MenuSeparator, MenuLabel, InlineName } from "./components/ui.ts";
export { HistoryPanel, VERSION_ROW_HEIGHT, CHILD_ROW_HEIGHT, WORKING_ROW_HEIGHT, type HistoryPanelProps } from "./components/HistoryPanel.ts";
// The redesign's version card and the shared change row and map (docs/carton-ux PLAN 3.3; Workstreams 4 and 6 import them)
export { VersionCard, CARD_ROWS, CARD_ROWS_MAX, type VersionCardProps, type PlayRequest, type PlayState, type CardMode } from "./components/VersionCard.ts";
export { ChangeRow, ChangeList, setChangeProgress, CLIP_ICON, type ChangeRowProps, type ChangeListProps } from "./components/ChangeRow.ts";
export { ChangeMap, moveMapPlayhead, mapLength, type ChangeMapProps } from "./components/ChangeMap.ts";
export { CutsMenu, CutDot, TeammateCutActions, useTeammateCut, type CutsMenuProps, type TeammateCutActionsProps } from "./components/CutsMenu.ts";
// The cuts' shared parts (PLAN 6.1, 2.2): colours, names in sentences, the queued switch, and opening the menu from the chip
export {
  CUT_COLORS,
  cutColor,
  cutColors,
  cutRef,
  isMainCut,
  homeCut,
  rememberHome,
  switchWhenDone,
  queuedSwitch,
  queuedSwitchError,
  subscribeQueuedSwitch,
  cancelQueuedSwitch,
  openCutsMenu,
  type QueuedSwitch,
} from "./cuts.ts";
export { FoldInDialog, type FoldInDialogProps, type FoldTicks } from "./components/FoldInDialog.ts";
export { ConflictCard, ConflictList, type ConflictCardProps } from "./components/ConflictCard.ts";
export { ConflictStack, type ConflictStackProps } from "./components/ConflictStack.ts";
export { cardSentences, conflictWords, keptText, pickUndoneText, type CardSentences, type CardValueWords, type ConflictCardWords, type SideSentence } from "./conflict-words.ts";
export { SyncStatusWords, PublishedStatus, UndoTurnButton, CreditsPopover, PreviewBanner, ViewingFrame, useEscapeBack } from "./components/status.ts";
export type { ViewingFrameProps } from "./components/status.ts";
export { PresenceAvatars, GhostLayer, groupPeers, type PresenceProps, type GhostLayerProps } from "./components/Presence.ts";
export { SpanPlayer, playSteps, stepFor, changeSpan, litAt, hasPlace, nothingToPlay, PLAY_CONTEXT, PLAY_MAX_SPAN, PLAY_FLASH_MS, PLAY_ASK_MS, PLAY_ASKS, type PlayStep, type StepOptions, type SpanState, type Clock, type Transport } from "./player.ts";
// The Changes view, Play and Before (docs/carton-ux PLAN 4): in place of History's list, and for a version's card.
export { ChangesView, longLabel, CHANGES_VIRTUAL_OVER, type ChangesViewProps } from "./components/ChangesView.ts";
export { usePlayChanges, PlayAllButton, BeforeButton, playKeys, HOLD_MS, type PlayHost, type PlayTarget, type PlayOptions, type Playback, type PlayStatus, type BeforeControl } from "./components/Play.ts";
// Compare in the editor (docs/carton-ux v2 DESIGN-V2 §1, N1): the stage view, the change list, the timeline marks.
export { playSchedule, playLength, storyAt, sidesAt, HOLD_BACK, type PlayStretch, type SideAt, followTime, leadTime, compareMarks, stripOf, stepAt, clipDiff, clipShots, clipName, removedAt, stillAt, COMPARE_MODES, type CompareDoc, type CompareItem, type TimelineMark, type MarkKind, type StripBar } from "./compare.ts";
export { CompareRowDetail, CompareStageView, CompareBar, CompareList, CompareMarks, CompareStrip, CompareStripLabel, CompareLegend, Glyph, COMPARE_CSS, compareModesFor, compareModeShown, SIDE_MIN, COMPACT_UNDER, FLIP_ONLY_UNDER, type CompareSideInfo, type CompareStageViewProps, type CompareBarProps, type CompareListProps, type TrackRow } from "./components/CompareView.ts";
export { fromCarton, toUiActor, cardOps, splitPathKey, defaultDescribeCard, defaultClipKind, sideNoun, type FromCartonOptions, type CartonUiHandle } from "./from-carton.ts";
export { serveUi, remoteUi, type ServerMessage, type ClientMessage } from "./remote.ts";
export { itemFilter, type ItemFilter } from "./item-filter.ts";
// Comments (PLAN §9 anchors, C6): the panel, timeline markers and their view model. New files owned by `comments`.
export * from "./comments/index.ts";
// Carton UX v2, History (N2: DESIGN-V2 §2–§4): Go back… and Bring back one clip, search, landmarks, hold to peek,
// Compare with… and the Compare button
export { GoBack, clipChoices, fromBringBack, bringBackLine, type GoBackChoice, type GoBackProps, type ClipChoice } from "./components/GoBack.ts";
export { SearchBox, useFind, highlight, snippetOf, searchable, FIND_DEBOUNCE_MS, FIND_LIMIT, type Found, type SearchBoxHandle } from "./components/SearchBox.ts";
export { LandmarkTag, LandmarkTile, landmarkTitle, indexLandmarks, useLandmarks, forgetPicture, LANDMARK_TONE, type LandmarkIndex } from "./components/LandmarkRow.ts";
export { CompareButton, PickLine, openCompareVia, type CompareTo, type Picking } from "./components/CompareMenu.ts";
export { usePeek, PEEK_HOLD_MS, PEEK_PREFETCH_MS, type PeekOptions } from "./components/peek.ts";
export { historyV2Css } from "./skin/history-v2.ts";
export { CutPicker, CUT_PAGE } from "./components/CutPicker.ts";
