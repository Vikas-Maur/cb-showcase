// Every word the Comments panel and the timeline markers show, in the editor's words (PLAN §0.1, §2.6: never git's).
// A host passes its own copy for another language (`<CommentsPanel words>`); missing keys fall back to these.

import { timecode } from "../format.ts";

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
  // an agent's note, named as History names it (design QA G27): yours bare ("Director"), a teammate's "Leo's Director"
  forAgent: (person: string | null, agent: string) => (person === null ? agent : `${person}'s ${agent}`),
  edited: "edited",
  deleted: "Comment deleted",
  justNow: "just now",
  replies: (n: number) => plural(n, "reply", "replies"),
  /**
   * A place on the timeline as the editor shows it (DESIGN §6.8, PLAN 9.1: "0:06", not "0:06.0"), or a range
   * "0:31–0:34"; a range within one second reads as its moment.
   */
  at: (range: readonly [number, number]) => {
    const a = timecode(range[0]), b = timecode(range[1]);
    return a === b ? a : `${a}–${b}`;
  },
  seekTo: (at: string) => `Go to ${at}`,
  // Esc on a reply or comment with text in it keeps it the first time (UI audit P2-1: it was silently discarded)
  escAgain: "Press Esc again to discard it.",
  wholeVersion: "Whole version",
  // where a thread sits on the version shown (§9: "may be outdated")
  status: {
    exact: "",
    // said in the note's grey line, as "That moment changed since." is (design QA G26), never as a pill
    moved: "Moved with its clip.",
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
  pending: "Not sent yet",
  pendingHint: "This comment reaches your teammates once you're online.",
  // the sharing status line
  syncWaiting: (n: number) => `Comments not sent yet: ${n}`,
  unsupported: "This server doesn't carry comments yet. They stay on this computer.",
  readOnly: "You can read comments here but not write them.",
  dismiss: "Dismiss",
  markers: "Comments on the timeline",
  marker: (n: number, at: string) => (n > 1 ? `${n} comments at ${at}` : `Comment at ${at}`),
  // for screen readers (design QA G22): `who` null is you ("Your comment at 0:47"), `at` null the whole video
  threadLabel: (who: string | null, at: string | null) => `${who === null ? "Your" : `${who}'s`} comment ${at === null ? "on the whole video" : `at ${at}`}`,
  actions: "Comment actions",
  // The redesign (DESIGN §6.8, §8): the box says where the comment is pinned; times as the editor shows them (0:06)
  // (the box's words as after/comments-*.png has them: a note, pinned at the playhead)
  placeholderAtPlayhead: (at: string) => `Add a note at ${at}…`,
  placeholderWhole: "Add a note…",
  atPlayhead: (at: string) => `At the playhead · ${at}`,
  atSelection: (at: string) => `On the selection · ${at}`,
  wholeVideo: "Whole video",
  changedSince: "That moment changed since.",
  seeAsItWas: "See it as it was",
  // the version a comment was made on, as the stage's frame names it when it isn't a History row
  asItWas: "The version this note was made on",
  seeFailed: "Couldn't show that version. Try again.",
  savedHere: "Saved here, sent when you're back",
};

export type CommentWords = typeof commentWords;
