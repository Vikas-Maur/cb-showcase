// @carton/react: headless hooks and unstyled components for Carton (PLAN §9, §10, §12, §13): History, Cuts, Fold
// in, conflict cards, Compare, Credits, Undo turn, the published cut, live presence, the sync status words and Watch
// the changes. `react` is a peer dependency and everything also runs under `preact/compat` (Cardboard's renderer
// gets a Preact root in our Windows build). The components read a small view model (`CartonUi`, model.ts):
// `fromCarton()` builds it from a real Carton handle, and `@carton/react/mock` makes one for galleries and tests.
// The look comes from a skin: `@carton/react/skin/cardboard` matches Cardboard. Owner: ui.

export type * from "./model.ts";
export { TopicHub } from "./hub.ts";
export { words, type Words } from "./words.ts";
export { duration, seconds, when, exactTime, shortDate } from "./format.ts";
export { actorColor, actorLabel, actorChain, initials } from "./actors.ts";
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
  useHistoryCount,
  useVersionAt,
  useNow,
  useAsync,
  useAction,
  type CartonProviderProps,
  type AsyncState,
} from "./hooks.ts";
export { Avatar, ActorName, Button, Dialog, MenuButton, MenuItem, MenuList, MenuSeparator, MenuLabel, InlineName } from "./components/ui.ts";
export { HistoryPanel, VERSION_ROW_HEIGHT, type HistoryPanelProps } from "./components/HistoryPanel.ts";
export { CutsMenu, type CutsMenuProps } from "./components/CutsMenu.ts";
export { FoldInDialog, type FoldInDialogProps } from "./components/FoldInDialog.ts";
export { ConflictCard, ConflictList, type ConflictCardProps } from "./components/ConflictCard.ts";
export { CompareCard, type CompareCardProps } from "./components/CompareCard.ts";
export { SyncStatusWords, PublishedStatus, UndoTurnButton, CreditsPopover, PreviewBanner } from "./components/status.ts";
export { PresenceAvatars, GhostLayer, groupPeers, type PresenceProps, type GhostLayerProps } from "./components/Presence.ts";
export { WatchTheChanges, stripLayout, xAt, type WatchTheChangesProps, type Box } from "./components/WatchTheChanges.ts";
export { ChangesPlayer, type PlayerState, type Side, type Clock } from "./player.ts";
export { fromCarton, toUiActor, cardOps, splitPathKey, defaultDescribeCard, type FromCartonOptions, type CartonUiHandle } from "./from-carton.ts";
export { serveUi, remoteUi, type ServerMessage, type ClientMessage } from "./remote.ts";
