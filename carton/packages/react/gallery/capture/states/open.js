// fix/ux2-open (the last open items of Carton UX v2, and the Windows check of b14f8a4e): Back to Fold in… with the
// ticks kept, the newest day read as a story when nothing happened today, and History's landmark and group rows.
export function addStates(S, { ux, mock, now0 }) {
  // Fold in with a conflict (Workstream 6's mockup plan), and Compare's stand-ins, so See them side by side opens it
  // and Back to Fold in… comes back to the dialog
  S["open-fold"] = () => ({ ...S["ws6-fold-conflict"](), n1: { from: null, open: false, mode: "side", player: true, agent: null } });
  // nothing happened today: the story's newest day is yesterday
  S["open-yesterday"] = () => ({ ui: mock({ versions: 8, now: now0 - 86_400_000, landmarks: true }), panel: "history" });
  // History's story with its landmarks, and its groups said by what they came to (the view model's netWords: the
  // mock's words, the first change and how many more; the Windows check's "Removed track “Top”… · 19 changes")
  S["open-rows"] = ux((ui) => {
    ui.setLandmarks(true);
    ui.netWords = async (a, b) => {
      const list = await ui.changes(a, b);
      return { summary: list.length > 1 ? `${list[0].text}, and ${list.length - 1} more change${list.length > 2 ? "s" : ""}` : (list[0]?.text ?? ""), changes: list.length };
    };
  });
}
