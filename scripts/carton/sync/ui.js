// The Share panel (Invite to edit, Join, who is here, the status words; PLAN §0.1, §12): bundled into carton-ui.js by
// scripts/carton/build.js, so it runs on the editor's own React, and opened by the "Share" button at the stage's top-right (scripts/carton/ui.js). It
// talks to the library worker's live services through the pages' bridge (carton:call liveStatus, liveShare,
// liveInvite, liveJoin) and follows `{kind: "carton", topic: "live"}` events. Editors' words only: Share, Invite to
// edit, Join, Syncing · Up to date · Offline: N edits waiting.
import { createElement as h, useEffect, useState } from "react";
import { Button, words, initials, actorColor } from "@carton/react";
import { injectCardboardSkin } from "@carton/react/skin/cardboard";

const field = (label, props) => h("label", { className: "flex flex-col gap-1 text-xs text-muted-foreground" }, label, h("input", { className: "h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground", ...props }));
const statusWords = (s) => (s.status === "up-to-date" && !s.pending ? words.upToDate : s.status === "offline" || s.status === "stopped" ? words.offline(s.pending ?? 0) : words.syncing);
const errText = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function useAction(fn) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const run = async (...a) => {
    setBusy(true);
    setError(null);
    try { return await fn(...a); } catch (e) { setError(errText(e)); return null; } finally { setBusy(false); }
  };
  return [run, busy, error];
}

// A teammate as Live.view() sends one (sync/live.js peerActor): an actor with a text `key`, `id` and `name`, and text or
// no activity. Any other entry is skipped, said once in the activity log with none of its text: one bad entry never
// takes the editor down (UI audit P1-1).
let skippedPeer = false;
function shownPeers(sent) {
  const text = (s) => typeof s === "string";
  const ok = Array.isArray(sent) ? sent.filter((p) => text(p?.actor?.key) && text(p.actor.id) && text(p.actor.name) && (p.activity == null || text(p.activity))) : [];
  if (ok.length < (sent?.length ?? 0) && !skippedPeer) {
    skippedPeer = true;
    window.__cbLog?.("error", { msg: "[carton] the Share panel skipped a teammate entry it can't show", src: "carton-ui.js" });
  }
  return ok;
}

function Peers({ peers: sent }) {
  const peers = shownPeers(sent);
  if (!peers?.length) return h("p", { className: "text-xs text-muted-foreground" }, "Nobody else is here right now.");
  return h("ul", { className: "flex flex-col gap-1.5" }, peers.map((p) => h("li", { key: p.actor.key, className: "flex items-center gap-2 text-sm", style: { opacity: p.idle ? 0.55 : 1 } },
    h("span", { className: "carton-avatar", style: { ["--carton-actor"]: actorColor(p.actor, () => undefined), width: 22, height: 22, fontSize: 9 } }, h("span", { className: "carton-avatar-initials" }, initials(p.actor.name ?? p.actor.id))),
    h("span", null, p.actor.name ?? p.actor.id),
    p.activity ? h("span", { className: "text-xs text-muted-foreground" }, p.activity) : null,
  )));
}

function Invite({ projectId, bridge }) {
  const [role, setRole] = useState("editor"), [link, setLink] = useState(null), [copied, setCopied] = useState(false);
  const [make, busy, error] = useAction(async () => setLink((await bridge.call("liveInvite", [{ projectId, role }])).link));
  return h("section", { className: "flex flex-col gap-2" },
    h("h3", { className: "text-sm font-medium" }, "Invite to edit"),
    h("div", { className: "flex items-center gap-2" },
      h("select", { className: "h-8 rounded-md border border-border bg-background px-2 text-sm", value: role, onChange: (e) => setRole(e.target.value) },
        h("option", { value: "editor" }, "Can edit"), h("option", { value: "commenter" }, "Can comment"), h("option", { value: "viewer" }, "Can watch")),
      h(Button, { onClick: () => make(), busy, variant: "primary" }, "Create link")),
    link ? h("div", { className: "flex items-center gap-2" },
      h("input", { className: "h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs", readOnly: true, value: link, onFocus: (e) => e.target.select() }),
      h(Button, { onClick: () => navigator.clipboard?.writeText(link).then(() => setCopied(true), () => {}) }, copied ? "Copied" : "Copy")) : null,
    error ? h("p", { className: "text-xs text-destructive", role: "alert" }, error) : null);
}

function ShareForm({ projectId, bridge, onShared }) {
  const [hostUrl, setHost] = useState(localStorage.getItem("carton.host") ?? ""), [secret, setSecret] = useState(""), [name, setName] = useState(localStorage.getItem("carton.name") ?? "");
  // A host with open creation needs only its address and a name; the token field shows only for a host that asks
  // (unknown until the address is checked: shown, but optional, while it is being checked).
  const [needsToken, setNeedsToken] = useState(null);
  useEffect(() => {
    setNeedsToken(null);
    let url;
    try { url = new URL(hostUrl.trim()); } catch { return undefined; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    let live = true;
    const t = setTimeout(() => bridge.call("liveHostInfo", [{ host: url.origin }]).then((i) => live && setNeedsToken(!i.openCreate), () => live && setNeedsToken(true)), 300);
    return () => { live = false; clearTimeout(t); };
  }, [hostUrl, bridge]);
  const [share, busy, error] = useAction(async () => {
    localStorage.setItem("carton.host", hostUrl);
    localStorage.setItem("carton.name", name);
    // An owner invite from the host, or the host's admin token (used once to make one; never kept); neither for a
    // host with open creation.
    const s = secret.trim();
    const r = await bridge.call("liveShare", [{ projectId, host: hostUrl, name, ...(s ? (s.startsWith("ct1.") ? { invite: s } : { adminToken: s }) : {}) }]);
    onShared(r);
  });
  return h("form", { className: "flex flex-col gap-2", onSubmit: (e) => { e.preventDefault(); share(); } },
    h("h3", { className: "text-sm font-medium" }, "Share this project"),
    h("p", { className: "text-xs text-muted-foreground" }, "Teammates you invite edit it with you, live. Its history goes with it; footage stays on this computer until you share it."),
    field("Carton host", { value: hostUrl, onChange: (e) => setHost(e.target.value), placeholder: "https://carton.example.com", required: true }),
    needsToken === false ? null : field(needsToken ? "Owner invite or admin token" : "Owner invite or admin token (if the host asks)", { value: secret, onChange: (e) => setSecret(e.target.value), type: "password", required: !!needsToken, "data-carton-secret": "" }),
    field("Your name", { value: name, onChange: (e) => setName(e.target.value), placeholder: "Alice", required: true }),
    h(Button, { type: "submit", busy, variant: "primary" }, "Share"),
    error ? h("p", { className: "text-xs text-destructive", role: "alert" }, error) : null);
}

function Join({ bridge }) {
  const [link, setLink] = useState(""), [name, setName] = useState(localStorage.getItem("carton.name") ?? ""), [done, setDone] = useState(null);
  const [join, busy, error] = useAction(async () => { localStorage.setItem("carton.name", name); setDone(await bridge.call("liveJoin", [{ link, name }])); });
  return h("form", { className: "flex flex-col gap-2", onSubmit: (e) => { e.preventDefault(); join(); } },
    h("h3", { className: "text-sm font-medium" }, "Join a shared project"),
    field("Invite link", { value: link, onChange: (e) => setLink(e.target.value), placeholder: "https://…/#join=…", required: true }),
    field("Your name", { value: name, onChange: (e) => setName(e.target.value), required: true }),
    h(Button, { type: "submit", busy }, "Join"),
    done ? h("p", { className: "text-xs", role: "status" }, `"${done.name}" is in your library now.`) : null,
    error ? h("p", { className: "text-xs text-destructive", role: "alert" }, error) : null);
}

// The "Live" section of a shared project: status words, why sync fails when it does, who is here.
export function LiveStatus({ st }) {
  return h("section", { className: "flex flex-col gap-2" },
    h("div", { className: "flex items-center justify-between" },
      h("h3", { className: "text-sm font-medium" }, "Live"),
      h("span", { className: "carton-sync text-xs", role: "status", "aria-live": "polite", "data-state": st.status }, statusWords(st))),
    // Why sync stopped (core's sync-error): plain words for the reason, then the host's own message (H-SV's
    // "…newer than this server accepts (up to N): update the server"), so nobody is left at "Syncing".
    st.problem
      ? h("div", { className: "carton-sync-problem flex flex-col gap-1 text-xs", role: "alert", "data-code": st.problem.code },
          h("p", { className: "text-destructive" }, st.problem.words),
          st.problem.detail && st.problem.detail !== st.problem.words ? h("p", { className: "carton-sync-detail text-muted-foreground" }, st.problem.detail) : null)
      : null,
    h("p", { className: "text-xs text-muted-foreground" }, `Shared through ${st.host} as ${st.name}.`),
    h(Peers, { peers: st.peers }));
}

export function SharePanel({ projectId, active, bridge }) {
  const [st, setSt] = useState(null);
  useEffect(() => { injectCardboardSkin(document); }, []);
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    bridge.call("liveStatus", [{ projectId }]).then((s) => live && setSt(s), (e) => live && setSt({ shared: false, error: errText(e) }));
    const off = bridge.onEvent((ev) => { if (live && ev?.id === projectId && ev.topic === "live") setSt((s) => ({ ...s, ...ev.live })); });
    return () => { live = false; if (typeof off === "function") off(); };
  }, [projectId, active, bridge]);
  if (!active || !st) return null;
  return h("div", { className: "carton-share flex h-full flex-col gap-5 overflow-y-auto p-4", "data-carton-skin": "cardboard" },
    st.shared
      ? h(LiveStatus, { st })
      : h(ShareForm, { projectId, bridge, onShared: () => bridge.call("liveStatus", [{ projectId }]).then(setSt) }),
    st.shared && st.role === "owner" ? h(Invite, { projectId, bridge }) : null,
    h(Join, { bridge }));
}

window.__cartonSyncUi = { SharePanel, LiveStatus };
