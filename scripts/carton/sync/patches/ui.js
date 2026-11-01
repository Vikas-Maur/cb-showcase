// The Share panel (Invite to edit, Join, who is here, the status words) opens from the "Share" button at the stage's
// top-right (patch-carton.js's layer, scripts/carton/ui.js): scripts/carton/sync/ui.js is bundled into carton-ui.js
// and sets window.__cartonSyncUi, and the layer shows the button only when it is there. This adds the person's
// presence while the editor is open (__cbCartonPresence, which the layer's stage host calls): at most once a second
// while they click or type, nothing after 30 s idle (§12), and only for a shared project.
const PREAMBLE = String.raw`function __cbCartonPresence(projectId) {
  const bridge = window.__carton;
  if (!bridge?.on || !projectId) return undefined;
  let shared = false, last = 0, stopped = false, timer = null;
  const send = (state) => bridge.call("livePresence", [{ projectId, state }]).catch(() => {});
  bridge.call("liveStatus", [{ projectId }]).then((s) => { shared = !!s?.shared; }, () => {});
  const off = bridge.onEvent((ev) => { if (ev?.id === projectId && ev.topic === "live") shared = !!ev.live?.shared; });
  const act = () => {
    if (!shared || stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { last = 0; send(null); }, 30000);
    const now = Date.now();
    if (now - last < 1000) return;
    last = now;
    send({ activity: "Editing" });
  };
  const kinds = ["pointerdown", "keydown", "wheel"];
  for (const k of kinds) window.addEventListener(k, act, { passive: true, capture: true });
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (typeof off === "function") off();
    for (const k of kinds) window.removeEventListener(k, act, { capture: true });
    if (last) send(null);
  };
}
`;

module.exports = {
  app({ editor }) {
    editor.prepend(PREAMBLE);
  },
};
