// Every word the Comments panel and the timeline markers show, in the editor's words (PLAN §0.1, §2.6: never git's).
// A host passes its own copy for another language (`<CommentsPanel words>`); missing keys fall back to these.

import { duration } from "../format.ts";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const commentWords = {
  comments: "Comments",
  filters: { open: "Open", resolved: "Resolved", all: "All" } as Record<"open" | "resolved" | "all", string>,
  filterCount: (label: string, n: number) => `${label} ${n}`,
  empty: "No comments yet. A comment is pinned to a moment of the version you're watching, and follows it as the edit changes.",
  emptyResolved: "No resolved comments.",
  placeholder: "Add a comment…",
  placeholderAt: (at: string) => `Comment at ${at}…`,
  replyPlaceholder: "Reply…",
  comment: "Comment",
  reply: "Reply",
  save: "Save",
  cancel: "Cancel",
  edit: "Edit",
  delete: "Delete",
  resolve: "Resolve",
  reopen: "Reopen",
  resolvedBy: (name: string) => `Resolved by ${name}`,
  you: "You",
  forAgent: (person: string, agent: string) => `${agent} for ${person}`,
  edited: "edited",
  deleted: "Comment deleted",
  justNow: "just now",
  replies: (n: number) => plural(n, "reply", "replies"),
  /** A timecode on the timeline: "0:12.4", or a range "0:12.4–0:15.0". */
  at: (range: readonly [number, number]) => (range[1] - range[0] > 0.05 ? `${duration(range[0])}–${duration(range[1])}` : duration(range[0])),
  seekTo: (at: string) => `Go to ${at}`,
  // Esc on a reply or comment with text in it keeps it the first time (UI audit P2-1: it was silently discarded)
  escAgain: "Press Esc again to discard it.",
  wholeVersion: "Whole version",
  // where a thread sits on the version shown (§9: "may be outdated")
  status: {
    exact: "",
    moved: "Moved",
    outdated: "May be outdated",
    trimmed: "Trimmed away",
    removed: "Clip removed",
    general: "",
  },
  statusHint: {
    moved: "The clip moved; the comment followed it.",
    outdated: "What's there changed since this comment was made.",
    trimmed: "The moment this comment was on was trimmed out of the clip.",
    removed: "The clip this comment was on was removed.",
  },
  madeOn: (seq: number) => `On version ${seq}`,
  pending: "Waiting to sync",
  pendingHint: "This comment reaches your teammates once you're online.",
  // the sharing status line
  syncWaiting: (n: number) => `Comments waiting to sync: ${n}`,
  unsupported: "This server doesn't carry comments yet. They stay on this computer.",
  readOnly: "You can read comments here but not write them.",
  dismiss: "Dismiss",
  markers: "Comments on the timeline",
  marker: (n: number, at: string) => (n > 1 ? `${n} comments at ${at}` : `Comment at ${at}`),
  threadLabel: (who: string, at: string) => `${who}'s comment at ${at}`,
  actions: "Comment actions",
};

export type CommentWords = typeof commentWords;
