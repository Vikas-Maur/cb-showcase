// The Share panel (Invite to edit, Join, who is here, the status words; PLAN §0.1, §12): bundled into carton-ui.js by
// scripts/carton/build.js, so it runs on the editor's own React, and opened by the title bar's Share icon (scripts/carton/ui.js). It
// talks to the library worker's live services through the pages' bridge (carton:call liveStatus, liveShare,
// liveInvite, liveJoin) and follows `{kind: "carton", topic: "live"}` events. Editors' words only: Share, Invite to
// edit, Join, Syncing · Up to date · Offline: N edits waiting. Never "Carton", "host", "token" or a raw error (UI audit
// P1-8, P2-8): the server is the "sharing server", a failure says what to do, at the field it is about.
import { createElement as h, useEffect, useState } from "react";
import { Button, Icon, MenuButton, MenuItem, words, initials, actorColor } from "@carton/react";
import { injectCardboardSkin } from "@carton/react/skin/cardboard";

const INPUT = "h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none transition-colors focus-visible:border-white/30 aria-[invalid=true]:border-destructive/70";
// A text field in Cardboard's look, with its own inline message (never the browser's "Please fill out this field").
function Field({ label, hint, error, id, ...props }) {
  const msg = error ? id + "-msg" : hint ? id + "-hint" : undefined;
  return h("div", { className: "flex flex-col gap-1" },
    h("label", { htmlFor: id, className: "text-xs text-muted-foreground" }, label),
    h("input", { id, className: INPUT, "aria-invalid": error ? true : undefined, "aria-describedby": msg, ...props }),
    error ? h("p", { id: msg, className: "text-xs text-destructive", role: "alert" }, error)
      : hint ? h("p", { id: msg, className: "text-xs text-muted-foreground" }, hint) : null);
}
const statusWords = (s) => (s.status === "up-to-date" && !s.pending ? words.upToDate : s.status === "offline" || s.status === "stopped" ? words.offline(s.pending ?? 0) : words.syncing);
const errText = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const isOffline = (st) => st?.status === "offline" || st?.status === "stopped";

/**
 * What went wrong, in plain words, and which field it is about (`host`, `secret`, `link`, `name` or none). The
 * worker's errors come over IPC as text only, so they are told apart by their words (scripts/carton/sync/host.js's,
 * worker.js's, and Node's own network errors). The raw text stays for the tooltip (support), never the message.
 */
export function shareProblem(raw, where = "share") {
  const m = String(raw ?? "");
  const r = (text, field = null) => ({ text, field, raw: m });
  // The server's daily limit (429) first: its words mention "your network", which isn't a network failure.
  if (/no more new projects|answered 429|daily limit|limit reached/i.test(m)) return r("This sharing server has reached its limit for today. Try again tomorrow, or use another server.", where === "share" ? "host" : null);
  if (/fetch failed|Failed to fetch|Couldn't reach|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|socket hang up|NetworkError|network error/i.test(m))
    return r("Can't reach this address. Check it, and your internet connection, and that the sharing server is running.", where === "join" ? "link" : "host");
  if (/certificate|SSL|TLS/i.test(m)) return r("This address's security certificate isn't valid. Check the address.", where === "join" ? "link" : "host");
  if (/isn't an invite link/i.test(m)) return r("That isn't an invite link. Paste the whole link you were sent; it ends in #join=…", "link");
  if (/Invalid URL/i.test(m)) return where === "join" ? r("That isn't an invite link. Paste the whole link you were sent; it ends in #join=…", "link") : r("That isn't a web address. It looks like https://share.example.com", "host");
  if (/didn't accept the invite or session|refused this computer/i.test(m)) return r("This invite isn't valid, or it has expired. Ask for a new one.", where === "join" ? "link" : "secret");
  if (/invite doesn't allow that/i.test(m)) return r(where === "invite" ? "Only the project's owner can invite people." : "This invite doesn't allow that. Ask the owner for an invite that can edit.", where === "join" ? "link" : where === "invite" ? null : "secret");
  if (/needs an owner invite or its admin token/i.test(m)) return r("This sharing server asks for an invite code. Ask whoever runs it for one.", "secret");
  if (/already shared on that host/i.test(m)) return r("This project is already shared on that server. Ask its owner for an invite.", "host");
  if (/already in your library/i.test(m)) return r("This project is already in your library. Open it from there.", "link");
  if (/no share data|share data (is unreadable|names another)/i.test(m)) return r("This project isn't ready to join yet. Ask its owner to share it again.", "link");
  if (/answered 413|too big|too large/i.test(m)) return r("This project is too big for this sharing server.");
  if (/answered 5\d\d|had a problem|busy/i.test(m)) return r("The sharing server is busy or having trouble. Try again in a minute.");
  if (/doesn't issue invite links/i.test(m)) return r("This sharing server doesn't make invite links.");
  if (/Share this project first/i.test(m)) return r("Share this project first.");
  if (/History isn't available|can't share a project yet|Live sync didn't start|library folder isn't known/i.test(m)) return r("Sharing isn't available for this project right now. Close it, open it again, and try again.");
  return r(words.failed);
}

function useAction(fn, where) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const run = async (...a) => {
    setBusy(true);
    setError(null);
    try { return await fn(...a); } catch (e) { setError(shareProblem(errText(e), where)); return null; } finally { setBusy(false); }
  };
  return [run, busy, error, setError];
}
// A failure under the button, the raw text in its tooltip for support: any the form has no field for (`fields`: the
// ones it shows; Invite and Open show none, so theirs always show here: review finding 3).
const Problem = ({ error, fields = [] }) => (error && !fields.includes(error.field) ? h("p", { className: "text-xs text-destructive", role: "alert", title: error.raw }, error.text) : null);
const fieldError = (error, field) => (error?.field === field ? error.text : null);

// The name teammates see, asked once (an app setting): shown as a line with "Change" once it is known.
function useName() {
  const [name, setName] = useState(() => globalThis.localStorage?.getItem("carton.name") ?? "");
  const save = (v) => { try { globalThis.localStorage?.setItem("carton.name", v); } catch {} };
  return [name, setName, save];
}
function NameField({ id, name, setName, error, known }) {
  const [editing, setEditing] = useState(!known);
  if (!editing && name.trim())
    return h("p", { className: "flex items-center gap-1 text-xs text-muted-foreground" }, "Teammates see you as ", h("span", { className: "font-medium text-foreground" }, name.trim()), ".",
      h("button", { type: "button", className: "ml-1 cursor-pointer rounded-sm text-xs text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-white/30", onClick: () => setEditing(true) }, "Change"));
  return h(Field, { id, label: "Your name", hint: "Teammates see this next to your edits.", error, value: name, autoComplete: "name", onChange: (e) => setName(e.target.value) });
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

const ROLES = [["editor", "Can edit"], ["commenter", "Can comment"], ["viewer", "Can watch"]];
// Who the link is for: Cardboard's own kind of picker (a menu, as its "16:9 ⌄" and model pickers), not an OS <select>.
function RolePicker({ role, setRole }) {
  return h(MenuButton, {
    label: "Who can do what",
    triggerClassName: "flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none transition-colors hover:bg-white/[0.04] focus-visible:ring-2 focus-visible:ring-white/30",
    trigger: [h("span", { key: "r" }, ROLES.find(([v]) => v === role)?.[1] ?? ROLES[0][1]), h(Icon, { key: "c", name: "caretDown", size: 12 })],
    children: (close) => ROLES.map(([v, label]) => h(MenuItem, { key: v, checked: role === v, onSelect: () => { setRole(v); close(); } }, label)),
  });
}

function Invite({ projectId, bridge, offline }) {
  const [role, setRole] = useState("editor"), [link, setLink] = useState(null), [copied, setCopied] = useState(false);
  const [make, busy, error] = useAction(async () => { setCopied(false); setLink((await bridge.call("liveInvite", [{ projectId, role }])).link); }, "invite");
  return h("section", { className: "flex flex-col gap-2" },
    h("h3", { className: "text-sm font-medium" }, "Invite to edit"),
    h("p", { className: "text-xs text-muted-foreground" }, "Anyone with the link can join with the role you pick."),
    h("div", { className: "flex items-center gap-2" },
      h(RolePicker, { role, setRole }),
      // Offline the server can't make a link: say so instead of failing after a wait.
      h(Button, { onClick: () => make(), busy, variant: "primary", disabled: offline, description: offline ? "Available when you're back online." : undefined }, "Create link")),
    offline ? h("p", { className: "text-xs text-muted-foreground" }, "You can create a link when you're back online.") : null,
    link ? h("div", { className: "flex items-center gap-2" },
      h("input", { className: INPUT + " min-w-0 flex-1 text-xs", readOnly: true, value: link, "aria-label": "Invite link", onFocus: (e) => e.target.select() }),
      h(Button, { onClick: () => navigator.clipboard?.writeText(link).then(() => setCopied(true), () => {}) }, copied ? "Copied" : "Copy")) : null,
    h(Problem, { error }));
}

function ShareForm({ projectId, bridge, onShared }) {
  const [hostUrl, setHost] = useState(localStorage.getItem("carton.host") ?? ""), [secret, setSecret] = useState("");
  const [name, setName, saveName] = useName();
  const [known] = useState(() => !!name.trim());
  const [checked, setChecked] = useState(null); // what is known about the address: null (not yet), "open", "invite", "unreachable", "bad"
  const [missing, setMissing] = useState(null);
  // A server with open creation needs only its address and a name. The invite code shows only when the server asks for
  // one. An address that can't be reached says so at the address, never by asking for a code (P1-8).
  useEffect(() => {
    setChecked(null);
    const v = hostUrl.trim();
    if (!v) return undefined;
    let url;
    try { url = new URL(v); } catch { return undefined; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    let live = true;
    const t = setTimeout(() => bridge.call("liveHostInfo", [{ host: url.origin }]).then((i) => live && setChecked(i?.openCreate ? "open" : "invite"), () => live && setChecked("unreachable")), 400);
    return () => { live = false; clearTimeout(t); };
  }, [hostUrl, bridge]);
  const [share, busy, error, setError] = useAction(async () => {
    localStorage.setItem("carton.host", hostUrl.trim());
    saveName(name.trim());
    // An owner invite from the server, or its admin token (used once to make one; never kept); neither for a server
    // with open creation.
    const s = secret.trim();
    const r = await bridge.call("liveShare", [{ projectId, host: hostUrl.trim(), name: name.trim(), ...(s ? (s.startsWith("ct1.") ? { invite: s } : { adminToken: s }) : {}) }]);
    onShared(r);
  }, "share");
  const submit = () => {
    const miss = !hostUrl.trim() ? "host" : !name.trim() ? "name" : checked === "invite" && !secret.trim() ? "secret" : null;
    setMissing(miss);
    setError(null);
    if (!miss) share();
  };
  const hostError = missing === "host" ? "Enter the sharing server's address." : fieldError(error, "host") ?? (checked === "unreachable" ? "Can't reach this address. Check it, and that the sharing server is running." : null);
  // The code field: when the server asks for one, or when sharing said it was wrong.
  const askSecret = checked === "invite" || error?.field === "secret";
  return h("form", { className: "flex flex-col gap-3", noValidate: true, onSubmit: (e) => { e.preventDefault(); submit(); } },
    h("h3", { className: "text-sm font-medium" }, "Share this project"),
    h("p", { className: "text-xs text-muted-foreground" }, "Teammates you invite edit it with you, live, with its history. They get preview copies of your video, whose originals stay on this computer; audio and still images go as they are."),
    h(Field, { id: "carton-share-host", label: "Sharing server", hint: "The address you were given, like https://share.example.com", error: hostError, value: hostUrl, inputMode: "url", spellCheck: false, onChange: (e) => setHost(e.target.value), placeholder: "https://share.example.com" }),
    askSecret ? h(Field, { id: "carton-share-secret", label: "Invite code", hint: "This server asks for one. Ask whoever runs it.", error: missing === "secret" ? "Enter the invite code." : fieldError(error, "secret"), value: secret, onChange: (e) => setSecret(e.target.value), type: "password", "data-carton-secret": "" }) : null,
    h(NameField, { id: "carton-share-name", name, setName, known, error: missing === "name" ? "Enter your name." : fieldError(error, "name") }),
    h("div", { className: "flex" }, h(Button, { type: "submit", busy, variant: "primary" }, busy ? "Sharing…" : "Share")),
    h(Problem, { error, fields: askSecret ? ["host", "secret"] : ["host"] }));
}

// `startOpen`: the form at once (the Dashboard's Join dialog); `onOpened`: after Open, so a dialog can close.
function Join({ bridge, startOpen = false, onOpened, onCancel }) {
  const [open, setOpen] = useState(startOpen);
  const [link, setLink] = useState(""), [done, setDone] = useState(null), [missing, setMissing] = useState(null);
  const [name, setName, saveName] = useName();
  const [known] = useState(() => !!name.trim());
  const [join, busy, error, setError] = useAction(async () => {
    saveName(name.trim());
    setDone(await bridge.call("liveJoin", [{ link: link.trim(), name: name.trim() }]));
    setLink("");
  }, "join");
  const [openIt, opening, openError] = useAction(async () => { await bridge.openProject(done.projectId); onOpened?.(); }, "open");
  const top = startOpen ? "" : " border-t border-white/[0.06] pt-4";
  if (!open && !done)
    return h("section", { className: "flex flex-col gap-1 border-t border-white/[0.06] pt-4" },
      h("p", { className: "text-xs text-muted-foreground" }, "Got an invite link from a teammate?"),
      h("div", { className: "flex" }, h(Button, { variant: "ghost", icon: "link", onClick: () => setOpen(true) }, "Join a shared project")));
  if (done)
    // Joined: the way on is to open it, not a form left filled in.
    return h("section", { className: "flex flex-col gap-2" + top, role: "status" },
      h("p", { className: "text-sm" }, `“${done.name}” is in your library now.`),
      h("p", { className: "text-xs text-muted-foreground" }, "Its footage arrives while your teammate's computer sends it: video as preview copies."),
      h("div", { className: "flex gap-2" },
        bridge.openProject ? h(Button, { variant: "primary", busy: opening, onClick: () => openIt() }, "Open") : null,
        h(Button, { variant: "ghost", onClick: () => { setDone(null); setOpen(startOpen); if (startOpen) onCancel?.(); } }, "Done")),
      h(Problem, { error: openError }));
  const submit = () => {
    const miss = !link.trim() ? "link" : !name.trim() ? "name" : null;
    setMissing(miss);
    setError(null);
    if (!miss) join();
  };
  return h("form", { className: "flex flex-col gap-3" + top, noValidate: true, onSubmit: (e) => { e.preventDefault(); submit(); } },
    startOpen ? null : h("h3", { className: "text-sm font-medium" }, "Join a shared project"),
    h(Field, { id: "carton-join-link", label: "Invite link", error: missing === "link" ? "Paste the invite link you were sent." : fieldError(error, "link"), value: link, spellCheck: false, onChange: (e) => setLink(e.target.value), placeholder: "https://…/#join=…", autoFocus: true }),
    h(NameField, { id: "carton-join-name", name, setName, known, error: missing === "name" ? "Enter your name." : fieldError(error, "name") }),
    h("div", { className: "flex gap-2" }, h(Button, { type: "submit", busy, variant: "primary" }, busy ? "Joining…" : "Join"), h(Button, { variant: "ghost", onClick: () => { setOpen(startOpen); setMissing(null); setError(null); if (startOpen) onCancel?.(); } }, words.cancel)),
    h(Problem, { error, fields: ["link"] }));
}

// The "Live" section of a shared project: status words, why sync fails when it does, who is here.
export function LiveStatus({ st }) {
  // A problem's own words say it once; the server's message adds to them only when it says more than the words (an
  // update the server needs: its own "up to N"), else it is the tooltip (P2-12: no second sentence saying the same).
  const detailShown = st.problem?.detail && st.problem.detail !== st.problem.words && st.problem.code !== "unreachable";
  return h("section", { className: "flex flex-col gap-2" },
    h("div", { className: "flex items-center justify-between" },
      h("h3", { className: "text-sm font-medium" }, "Live"),
      h("span", { className: "carton-sync text-xs", role: "status", "aria-live": "polite", "data-state": st.status }, statusWords(st))),
    // Why sync stopped (core's sync-error): plain words for the reason, then the server's own message when it adds to
    // them (H-SV's "…newer than this server accepts (up to N): update the server"), so nobody is left at "Syncing".
    st.problem
      ? h("div", { className: "carton-sync-problem flex flex-col gap-1 text-xs", role: "alert", "data-code": st.problem.code, title: detailShown ? undefined : st.problem.detail ?? undefined },
          h("p", { className: "text-destructive" }, st.problem.words),
          detailShown ? h("p", { className: "carton-sync-detail text-muted-foreground" }, st.problem.detail) : null)
      : null,
    h("p", { className: "text-xs text-muted-foreground", title: st.host }, `Teammates see you as ${st.name}.`),
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
    st.shared && st.role === "owner" ? h(Invite, { projectId, bridge, offline: isOffline(st) }) : null,
    // Joining is for a project you don't have yet: not offered inside one that is already shared or joined.
    st.shared ? null : h(Join, { bridge }));
}

window.__cartonSyncUi = { SharePanel, LiveStatus, shareProblem, ShareForm, Join, Invite, Problem };
