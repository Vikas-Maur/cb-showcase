// The capture page's states for Carton UX v2, History (N2: docs/carton-ux/v2 DESIGN-V2 §2–§4): landmarks, search,
// Go back…, Bring back one clip, the Compare button, pick mode and hold to peek (states/README.md). Gallery code only:
// nothing here ships.

/** Add the scenarios to entry.js's table `S`, from its own builders. */
export function addStates(S, { ux, setCuts }) {
  // History's story (after/history-*.png), with the mock's landmarks: the fold an hour ago was exported (1080p for the
  // client), "Sent to client" was shared with Leo, each day's first version is its start, the restore's safety point
  S["n2-history"] = ux((ui) => ui.setLandmarks(true));
  // The same with nothing selected on the timeline (Go back… then opens with nothing picked)
  S["n2-noclip"] = () => ({ ...ux((ui) => ui.setLandmarks(true))(), clip: null });
  // Compare with… on another cut (N2c): 30s Instagram cut with 12,000 versions, read a page at a time
  S["n2c-big"] = () => {
    const r = ux((ui) => ui.setLandmarks(true))();
    setCuts(r.ui, r.ui.cuts().map((c) => (c.id === "cut-ig" ? { ...c, head: "ig@12000" } : c)));
    return { ...r, clip: null };
  };
}
