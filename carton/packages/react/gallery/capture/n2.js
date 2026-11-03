// The capture page's states for Carton UX v2, History (N2: docs/carton-ux/v2 DESIGN-V2 §2–§4): landmarks, search,
// Go back…, Bring back one clip, the Compare button, pick mode and hold to peek. Kept apart from entry.js (one line
// there adds them). Gallery code only: nothing here ships.

/** Add the scenarios to entry.js's table `S`, from its own builders. */
export function addN2(S, { ux }) {
  // History's story (after/history-*.png), with the mock's landmarks: the fold an hour ago was exported (1080p for the
  // client), "Sent to client" was shared with Leo, each day's first version is its start, the restore's safety point
  S["n2-history"] = ux((ui) => ui.setLandmarks(true));
  // The same with nothing selected on the timeline (Go back… then opens with nothing picked)
  S["n2-noclip"] = () => ({ ...ux((ui) => ui.setLandmarks(true))(), clip: null });
}
