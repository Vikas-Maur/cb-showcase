// The design QA's states (docs/carton-ux/qa, 2026-11-03), folded into the rig: Workstream 7's conflict cards, Workstream
// 2+8's Share dialog family and title bar, the compact footage notice, and actions that fail. Their shots are in
// qa.shots.mjs. Gallery code only: nothing here ships.

/** Adds the scenarios to the capture page's table (see README.md here for `ctx`). */
export function addStates(S, { ux, card, CARDS, people, leo, now0, MIN, shared, peer, setCuts, WS6_CUTS, newest, cut, at }) {
  // ------------------------------------------------------------ conflict cards with their sentences (PLAN 7.1)
  const side = (author, when, text, did, what = "edit") => ({ author, summary: text, at: when, text, did, what });
  const CARDS7 = {
    interview: card({ id: "c7-interview", path: "timelineItems/ib/#time", title: "'Interview B' timing", item: "item-ib", clip: "Interview B", provisional: "mine", sig: "18|20",
      mine: side(people.alice, now0 - 2 * MIN, "Moved it to start at 0:18", "moved it", "move"), theirs: side(people.terminal, now0 + 15_000, "Moved it to start at 0:20", "moved it", "move") }),
    tone: card({ id: "c7-tone", path: "timelineItems/tone/mediaItemId", title: "'Tone.mp3' media", item: "item-tone", clip: "Tone.mp3", provisional: "mine", canKeepBoth: true, both: "Leo's music on a new track under yours",
      mine: side(people.alice, now0 - 5 * MIN, "Kept “Tone.mp3” from 0:00", "kept it"), theirs: side(leo, now0 - 3 * MIN, "Replaced it with “Upbeat.wav”", "replaced it") }),
    twice: card({ id: "c7-twice", path: "media/m-w1/data/content", title: "'Summer launch' text", item: "item-summer", clip: "Summer launch", provisional: "theirs",
      mine: side(people.alice, new Date(2026, 10, 3, 10, 5).getTime(), "Changed it to “Summer sale”", "changed its text"), theirs: side(people.alice, new Date(2026, 10, 3, 10, 4).getTime(), "Changed it to “Summer launch”", "changed its text") }),
    size: card({ id: "c7-size", path: "timelineItems/w6/fontSize", title: "'W6' font size", item: "item-w6", clip: "W6", provisional: "mine", sig: "80|120",
      mine: side(people.alice, now0 + 10_000, "Made it smaller (font size 80)", "changed its font size"), theirs: side(people.terminal, now0 + 15_000, "Made it bigger (font size 120)", "changed its font size") }),
  };
  // "See it": the mock has no conflictRef; this one answers a held state for each side
  const see = (ui) => { ui.conflictRef = async (_id, s) => "main@" + (s === "mine" ? 9 : 10); };
  const onStage = (setup) => () => { const r = ux()(); setup(r.ui); return { ...r, panel: null }; };
  S["qa-conflict"] = onStage((ui) => { see(ui); ui.setConflicts([CARDS7.interview, CARDS7.tone]); });
  S["qa-conflict-twice"] = onStage((ui) => { see(ui); ui.setConflicts([CARDS7.twice]); });
  const turn = (ui) => ui.setWorking({ actor: people.terminal, label: "Make the titles bigger", edits: 1, since: now0 - MIN, cutId: "cut-main" });
  S["qa-conflict-turn"] = onStage((ui) => { see(ui); ui.setConflicts([CARDS7.size]); turn(ui); });
  S["qa-conflict-again"] = onStage((ui) => {
    see(ui); ui.setConflicts([CARDS7.size]); turn(ui);
    window.__again = () => ui.setConflicts([{ ...CARDS7.size, sig: "80|150", theirs: side(people.terminal, now0 + 15_000, "Made it bigger (font size 150)", "changed its font size") }]);
  });
  S["qa-conflict-panel"] = () => { const r = ux()(); see(r.ui); r.ui.setConflicts([CARDS7.interview, CARDS7.tone]); return { ...r, panel: "history" }; };
  // cards as the engine words them without sentences (no clip, no did): how the fallbacks read (design QA G30)
  S["qa-conflict-old"] = onStage((ui) => { ui.setConflicts([CARDS.intro, CARDS.w6]); });

  // ------------------------------------------------------------ the stage's footage notice (after/stage-live-media.png)
  S["qa-live-media"] = () => ({ ...ux()(), panel: null, live: shared({ status: "offline", pending: 3, label: "Offline" }), media: { waiting: [{ mediaId: "m1", fileName: "interview-b.mp4" }, { mediaId: "m2", fileName: "broll-03.mp4" }], playable: 3, from: "Leo" } });

  // ------------------------------------------------------------ the Share dialog as the mockups have it: Vikas, Leo here
  // with his Director working, Mia idle
  const leoA = { key: "human/leo", kind: "human", name: "Leo" }, miaA = { key: "human/mia", kind: "human", name: "Mia" };
  const leoDirA = { key: "agent/director-leo", kind: "agent", name: "Director", parent: "human/leo" };
  const VIKAS = shared({ name: "Vikas", account: "vikas", host: "https://share.northlight.studio" });
  const shareUx = (live, extra = {}) => () => ({ ...ux()(), panel: "share", live, ...extra });
  S["qa-share-first"] = shareUx({ shared: false });
  S["qa-share-known"] = shareUx({ shared: false }, { name: "Vikas", host: "https://share.northlight.studio" });
  S["qa-share-code"] = shareUx({ shared: false }, { hostInfo: { openCreate: false }, name: "Vikas" });
  S["qa-share-unreachable"] = shareUx({ shared: false }, { hostInfo: "unreachable", name: "Vikas" });
  S["qa-share-owner"] = shareUx({ ...VIKAS, peers: [peer(leoA, "Editing captions"), peer(leoDirA, "Working on “Add a title card”"), peer(miaA, null, true)] });
  S["qa-share-offline"] = shareUx({ ...VIKAS, status: "offline", pending: 3, label: "Offline", peers: [], problem: { code: "unreachable", words: "The sharing server can't be reached. Your edits wait here and go out when it's back.", detail: "fetch failed: connect ECONNREFUSED 10.0.0.12:443" } });
  S["qa-share-editor"] = shareUx({ ...VIKAS, role: "editor", peers: [peer(leoA, "Watching")] });
  S["qa-share-update"] = shareUx({ ...VIKAS, status: "offline", pending: 1, label: "Offline", problem: { code: "update-server", words: "The sharing server is older than this app. It needs an update before this project can sync.", detail: "This project's history is newer than this server accepts (up to 3): update the server" } });
  // the editor shared, Leo and Mia here (the title bar's avatars), and offline
  S["qa-shared"] = () => ({ ...ux()(), panel: null, live: shared({ peers: [peer(leoA, "Editing captions"), peer(miaA, "Watching")] }) });
  S["qa-offline"] = () => ({ ...ux()(), panel: null, live: shared({ status: "offline", pending: 3, label: "Offline", peers: [peer(leoA, "Editing captions")] }) });

  // ------------------------------------------------------------ cuts
  // a long cut name, on that cut
  S["qa-long-cut"] = () => {
    const r = ux()();
    const long = "Client review: the long version with the drone shot";
    setCuts(r.ui, [...WS6_CUTS(newest(r.ui), "cut-long"), cut({ id: "cut-long", name: long, label: long, head: newest(r.ui), color: "#22d3ee", updatedAt: Date.now() - 4 * MIN, updatedBy: people.alice })].map((c) => ({ ...c, current: c.id === "cut-long" })));
    return { ...r, panel: null };
  };
  S["qa-teammate-window"] = () => ({ ...S["ws6-teammate"](), panel: "history" });
  // one cut only: the chip and the menu with nothing to fold
  S["qa-one-cut"] = () => { const r = ux()(); setCuts(r.ui, WS6_CUTS(newest(r.ui)).slice(0, 1)); return r; };
  // on 30s Instagram cut with History open: the cut bar draws the cut as the chip does, its dot alone (design QA G12)
  S["qa-other-cut-panel"] = () => ({ ...S["ws1-other-cut"](), panel: "history" });

  // ------------------------------------------------------------ errors: an action that fails says so in its card
  S["qa-errors"] = () => {
    const r = ux()();
    r.ui.restore = async () => { throw new Error("EPERM: operation not permitted, rename 'project.json'"); };
    r.ui.undoTurnOf = async () => { throw new Error("worker gone"); };
    return r;
  };

  // ------------------------------------------------------------ authors with no name (design QA G30): a teammate the
  // engine knows only by an empty name, and a version the system made
  S["qa-nameless"] = () => {
    const r = ux()();
    r.ui.addVersion({ at: at(0, 12, 46), author: { key: "human/x-7f3a", kind: "human", name: "" }, kind: "edit" });
    r.ui.addVersion({ at: at(0, 12, 47), author: { key: "system/carton", kind: "system", name: "" }, kind: "edit", summary: "Updated the project to the new format" });
    return r;
  };
}
