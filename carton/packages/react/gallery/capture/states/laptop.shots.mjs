// The shots for the laptop's findings (states/laptop.js), for before/after pairs: the timeline's marks and strip on a
// content diff that matched nothing (P2-2, P3-8), the words of a comparison with an unnamed version of yours (P3-7).
// Flip's side (P3-9) is n1.shots.mjs's n1-flip. Steps that wait for what the change brings go on without it, so the
// same shots run on a build without it (before).
export function shots({ ED }) {
  const W = (name, s, how, steps, o = {}) => ({ name, s, how, steps, target: "window", perWidth: false, viewport: ED, ...o });
  const open = async (p) => { await p.locator(".carton-compare").waitFor(); await p.locator(".carton-compare-list .carton-change").first().waitFor({ timeout: 4000 }).catch(() => {}); await p.waitForTimeout(500); };
  return [
    W("laptop-marks", "laptop-content", "Compare on “Sent to client” where core's shot diff matched nothing (a music bed under the cut): the removed caption's mark and the pier's, and the strip of the left side.", open),
    W("laptop-words", "laptop-words", "Compare with an earlier version of yours that has no name: the chip, the players' labels and the list's head.", open),
  ];
}
