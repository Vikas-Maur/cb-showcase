// The title bar chip's cuts menu (Carton UX redesign PLAN 2.2 version 2, after/titlebar-cuts-menu.png): the chip drops
// the cuts menu down under itself; History stays closed. The mockup's cuts: Main cut (you, now), 30s Instagram cut (the
// Director, 2 h ago, amber), Client review (you, yesterday, cyan). Shots in chipmenu.shots.mjs. Gallery code only.

/** Adds the scenarios to the capture page's table (see README.md here for `ctx`). */
export function addStates(S, { ux, people, setCuts, cut, newest, MIN }) {
  const cuts = (head) => {
    const now = Date.now();
    return [
      cut({ id: "cut-main", name: "Main cut", label: "Main cut", kind: "main", head, current: true, shared: true, updatedAt: now - 20_000, updatedBy: people.alice }),
      cut({ id: "cut-ig", name: "30s Instagram cut", label: "30s Instagram cut", head: "ig@41", updatedAt: now - 125 * MIN, updatedBy: people.director, color: "#f59e0b" }),
      cut({ id: "cut-client", name: "Client review", label: "Client review", head: "cr@9", updatedAt: now - 26 * 60 * MIN, updatedBy: people.alice, color: "#22d3ee" }),
    ];
  };
  const chip = (setup = () => {}) => () => {
    const r = ux()();
    setCuts(r.ui, cuts(newest(r.ui)));
    r.ui.setSync({ kind: "upToDate" });
    r.ui.setConflicts([]);
    setup(r.ui);
    return { ...r, panel: null };
  };
  S["chip-cuts"] = chip();
  // Claude Code's turn holds Main cut: another cut opens in place with Switch when it finishes / Switch now
  S["chip-cuts-turn"] = chip((ui) => ui.setWorking({ actor: people.terminal, label: "Tighten the intro and add a lower third", edits: 2, since: Date.now() - 90_000, cutId: "cut-main" }));
}
