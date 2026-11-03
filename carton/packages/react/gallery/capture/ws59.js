// The capture page's states for UX redesign workstreams 5 and 9 (docs/carton-ux PLAN 5.x, 9.x): the toasts with Undo
// and the Comments panel. Kept apart from entry.js (one line there adds them), so the workstreams that add states to
// the rig at the same time don't edit the same lines. Gallery code only: nothing here ships.

/** Add the scenarios to entry.js's table `S`, from its own builders (`ux`, `hist`, `stage`) and the mocks' people. */
export function addWs59(S, { ux, hist, stage, people, createMockComments }) {
  // History's story (after/history-*.png), for the restore, new cut and Undo this turn toasts
  S["ws59-history"] = ux();
  // A conflict card over the stage (after/conflict-card.png's): you and Claude Code both moved “Interview B”, yours shown
  const now = Date.now() - 20_000;
  S["ws59-pick"] = stage((ui) => {
    ui.setConflicts([{
      id: "c-interview-b", title: "'Interview B' timing", clip: "Interview B", item: "item-interview-b", canKeepBoth: false, provisional: "mine",
      mine: { author: people.alice, summary: "starts at 0:18", text: "Moved it to start at 0:18", what: "move", did: "moved it", at: now - 2 * 60_000 },
      theirs: { author: people.terminal, summary: "starts at 0:20", text: "Moved it to start at 0:20", what: "move", did: "moved it", at: now },
    }]);
    return {};
  });
  // Comments (after/comments-384.png): nothing resolved (so no Open/Resolved/All), a reply, a moment that changed
  // since, a note on the whole video
  S["ws59-comments"] = () => {
    const comments = createMockComments({});
    for (const t of comments.threads()) if (t.resolved) void comments.resolve(t.id, false);
    return { ...hist()(), comments };
  };
  // A toast while offline (after/editor-toast-offline.png): the toast above the offline chip, never over it
  S["ws59-offline"] = () => ({ ...ux()(), live: { shared: true, host: "https://share.example.com", account: "alice", name: "Alice Moreau", role: "owner", status: "offline", pending: 3, label: "Offline", holder: true, peers: [], problem: null } });
}
