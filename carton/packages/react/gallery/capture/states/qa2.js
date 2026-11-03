// The capture page's states for the design QA of Carton UX v2 (docs/carton-ux/v2/qa/QA-V2.md): the History states
// N2's own (states/n2.js) don't reach. Gallery code only: nothing here ships.

/** Add the scenarios to entry.js's table `S`, from its own builders (states/README.md). */
export function addStates(S, { ux, setCuts, WS6_CUTS, newest }) {
  // N2's story with landmarks and nothing selected on the timeline, with Workstream 6's cuts (a cut of yours, a
  // teammate's): Compare's Another cut, pick mode's cut button
  S["qa2-cuts"] = () => {
    const r = ux((ui) => ui.setLandmarks(true))();
    setCuts(r.ui, WS6_CUTS(newest(r.ui)));
    return { ...r, clip: null };
  };
}
