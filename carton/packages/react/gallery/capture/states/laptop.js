// The capture page's states for the Windows laptop's findings (fix/ux2-laptop). Gallery code only: nothing ships.
// - laptop-content: n1-side, with core's content shot diff as a real edit gives it under a music bed: nothing matched
//   (the bed's in-point moves under every shot after the trimmed intro), one changed stretch from 0:00. Compare used
//   to line the marks and the strip up on it; the clips' own alignment (the two timelines) is what it goes by now.
// - laptop-words: n1-side against an earlier version of yours that has no name: it is named by its time, once.
export function addStates(S) {
  S["laptop-content"] = () => {
    const r = S["n1-side"]();
    r.ui.shotDiff = async () => ({ a: [{ start: 0, end: 40, sig: 1 }], b: [{ start: 0, end: 36, sig: 2 }], matches: [], aLabel: "Sent to client", bLabel: "Your edit" });
    return r;
  };
  S["laptop-words"] = () => {
    const r = S["n1-side"]();
    const all = r.ui.history().all();
    const mine = [...all].reverse().find((v) => !v.name && !v.turn && v.author?.isYou && v.kind !== "restore" && v !== all.at(-1));
    return { ...r, n1: { ...r.n1, from: mine?.ref ?? r.n1.from } };
  };
}
