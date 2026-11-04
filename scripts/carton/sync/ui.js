// Share and Join (Carton UX redesign PLAN 8.1, 8.2; DESIGN §6.6): bundled into carton-ui.js by scripts/carton/build.js,
// so it runs on the editor's own React.
// - ShareDialog: opened by the title bar's Share icon (or, in a narrow window, the History panel's head; or the stage's
//   Offline chip), in place of the side panel's Share tab, as a dialog in Cardboard's look. Not shared yet: the sharing
//   server (remembered once used, then one line with Change), your name (asked once), Share project, and an invite
//   code only when the server asks for one. Shared: its status by the title, People (You, then everyone here, with what
//   they're doing and their role, each with their agents under them), and, for the owner, Invite (who can do what, the
//   link, made as the dialog opens, Copy link). Offline: an amber line saying your changes are kept and sent later; the
//   invite says when it can be made. Sync failing for another reason: that amber line says why instead.
// - Join: the Dashboard's "Join a shared project" (scripts/carton/ui.js JoinDialog): the invite link, who you join as,
//   and one button, Join and open, which joins and opens the project in its tab.
// Both talk to the library worker's live services through the pages' bridge (carton:call liveStatus, liveShare,
// liveInvite, liveJoin, liveHostInfo) and follow `{kind: "carton", topic: "live"}` events. Editors' words only (in
// @carton/react's words.ts: Share and Join). Never "Carton", "host", "token" or a raw error (UI audit P1-8,
// P2-8): the server is the "sharing server", a failure says what to do, at the field it is about (shareProblem).
import { createElement as h, useEffect, useRef, useState } from "react";
import { Avatar, Button, CartonProvider, Dialog, Icon, MenuButton, MenuItem, words, actorLabel } from "@carton/react";
import { injectCardboardSkin } from "@carton/react/skin/cardboard";

// "Share “Weekend reel”" (a project with no name known: "Share this project")
export const shareTitle = (name) => (name ? words.shareTitle(name) : words.shareThisProject);
// A text field in Cardboard's look (the skin's carton-field: Cardboard's own stylesheet has no invalid or focus border
// for these: AUDIT R3), with its own inline message (never the browser's "Please fill out this field").
function Field({ label, hint, error, id, ...props }) {
  const msg = error ? id + "-msg" : hint ? id + "-hint" : undefined;
  return h("div", { className: "carton-field" },
    h("label", { htmlFor: id, className: "carton-field-label" }, label),
    h("input", { id, className: "carton-input", "aria-invalid": error ? true : undefined, "aria-describedby": msg, ...props }),
    error ? h("p", { id: msg, className: "carton-field-error", role: "alert" }, error)
      : hint ? h("p", { id: msg, className: "carton-field-hint" }, hint) : null);
}
const errText = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const isOffline = (st) => st?.status === "offline" || st?.status === "stopped";
// An address as people say it ("share.northlight.studio") is the https one.
export const hostAddress = (v) => {
  const t = String(v ?? "").trim();
  return !t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : "https://" + t;
};
const shownAddress = (v) => String(v ?? "").replace(/^https:\/\//i, "").replace(/\/$/, "");

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

// One run at a time (review of feat/ux-2-8 #4: Enter in a field submitted again while the button showed busy): the guard
// is synchronous, so the button, the form and the keyboard can't start a second run before the first renders busy.
function useAction(fn, where) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  const running = useRef(false);
  const run = async (...a) => {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setError(null);
    try { return await fn(...a); } catch (e) { setError(shareProblem(errText(e), where)); return null; } finally { running.current = false; setBusy(false); }
  };
  return [run, busy, error, setError];
}
// A failure under the button, the raw text in its tooltip for support: any the form has no field for (`fields`: the
// ones it shows; Invite and Open show none, so theirs always show here: review finding 3).
const Problem = ({ error, fields = [] }) => (error && !fields.includes(error.field) ? h("p", { className: "carton-field-error", role: "alert", title: error.raw }, error.text) : null);
const fieldError = (error, field) => (error?.field === field ? error.text : null);

// The name teammates see, asked once (an app setting): shown as a line with "Change" once it is known.
function useName() {
  const [name, setName] = useState(() => globalThis.localStorage?.getItem("carton.name") ?? "");
  const save = (v) => { try { globalThis.localStorage?.setItem("carton.name", v); } catch {} };
  return [name, setName, save];
}
const ChangeLink = ({ onClick }) => h("button", { type: "button", className: "carton-link", onClick }, words.change);
// The sentence that says the name ("Teammates see you as Vikas.", Join's "You'll join as Leo."), the name in bold.
const teammatesSee = (name) => `Teammates see you as ${name}.`;
function NameField({ id, name, setName, error, known, line = teammatesSee }) {
  const [editing, setEditing] = useState(!known);
  if (!editing && name.trim() && !error) {
    const said = line(name.trim()), at = said.lastIndexOf(name.trim());
    return h("p", { className: "carton-known" }, said.slice(0, at), h("span", { className: "carton-known-value" }, name.trim()), said.slice(at + name.trim().length) + " ", h(ChangeLink, { onClick: () => setEditing(true) }));
  }
  return h(Field, { id, label: words.yourName, hint: words.yourNameHint, error, value: name, autoComplete: "name", onChange: (e) => setName(e.target.value) });
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
// "Editing captions" reads "here now · editing captions" after a dot; a name or an acronym keeps its capital.
const lower = (s) => (typeof s === "string" && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const upFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// "You're offline. Keep editing: …": the first sentence in bold, the rest as it is.
const firstSentence = (line) => { const i = line.indexOf(". "); return i < 0 ? [line] : [h("strong", { key: "b" }, line.slice(0, i + 1)), line.slice(i + 1)]; };
// What someone may do, in words ("Can edit"); nothing for a role that isn't known.
const roleWords = (r) => (typeof r === "string" && Object.hasOwn(words.roles, r) ? words.roles[r] : null);
const RING = "0 0 0 2px var(--cb-dialog), 0 0 0 3.5px var(--cb-ok)";
/**
 * One row of People: the avatar as History draws the same actor (@carton/react's Avatar: You are "Y" before and after a
 * share, an agent its own mark: QA G11), with the green ring of a person here and not idle (an agent's mark has none:
 * its person's says it); the name, what they're doing, and their role. An agent sits under its person, smaller (QA G3).
 */
function Person({ actor, name, sub, role, here, idle, you, under }) {
  return h("li", { className: "carton-share-person", "data-you": you ? "" : undefined, "data-under": under ? "" : undefined, style: { ...(idle ? { opacity: 0.55 } : null), ...(under ? { marginLeft: 36, minHeight: 40 } : null) } },
    h("span", { "data-here": here && !idle ? "" : undefined, style: { display: "inline-flex", flex: "none", borderRadius: 999, boxShadow: here && !idle ? RING : undefined } }, h(Avatar, { actor, size: under ? 20 : 24, named: true })),
    h("span", { className: "carton-share-who" }, h("span", { className: "carton-share-name" }, name), sub ? h("span", { className: "carton-share-sub" }, sub) : null),
    role ? h("span", { className: "carton-share-role" }, role) : null);
}

/**
 * People: You (with the name teammates see and your role), then everyone here now, with what they're doing and their
 * role, each followed by their agents ("Leo's Director · Working on “Add a title card”": an agent's `parent` is its
 * person's key). An agent whose person isn't here is named by its `owner` all the same, never as a bare "Director".
 */
export function People({ st }) {
  const peers = shownPeers(st.peers);
  const me = { key: "human/you", kind: "human", id: "you", name: st.name ?? "", isYou: true };
  const offline = isOffline(st);
  const people = peers.filter((p) => p.actor.kind === "human");
  const byKey = new Map(people.map((p) => [p.actor.key, p.actor])), here = new Set(byKey.keys());
  const under = new Map(), alone = [];
  for (const p of peers) {
    if (p.actor.kind === "human") continue;
    const parent = typeof p.actor.parent === "string" ? p.actor.parent : null, owner = p.actor.owner;
    if (parent && !byKey.has(parent) && typeof owner?.name === "string") byKey.set(parent, { key: parent, kind: "human", id: owner.id, name: owner.name });
    if (parent && here.has(parent)) under.set(parent, [...(under.get(parent) ?? []), p]);
    else alone.push(p);
  }
  // actorLabel and the Avatar look an agent's person up here: "Leo's Director", in Leo's colour
  const ui = { actor: (k) => byKey.get(k) };
  const agent = (p) => h(Person, { key: p.actor.key, under: under.has(p.actor.parent), actor: p.actor, name: actorLabel(p.actor, ui.actor, words.you), sub: p.activity ? upFirst(p.activity) : words.hereNowLine, idle: p.idle });
  return h(CartonProvider, { ui },
    h("section", { className: "carton-share-section" },
      h("h3", { className: "carton-share-heading" }, words.people),
      h("ul", { className: "carton-share-people" },
        h(Person, { key: "you", you: true, actor: me, name: words.you, sub: offline ? st.name : words.youHereNow(st.name), role: roleWords(st.role), here: !offline }),
        ...people.flatMap((p) => [
          h(Person, { key: p.actor.key, actor: p.actor, name: p.actor.name ?? p.actor.id, sub: p.idle && !p.activity ? words.hereNotEditing : p.activity ? `${words.hereNowLine} · ${lower(p.activity)}` : words.hereNowLine, role: roleWords(p.role), here: true, idle: p.idle }),
          ...(under.get(p.actor.key) ?? []).map(agent),
        ]),
        ...alone.map(agent)),
      peers.length ? null : h("p", { className: "carton-share-none" }, words.nobodyElseHere)));
}

const ROLES = [["editor", words.roles.editor], ["commenter", words.roles.commenter], ["viewer", words.roles.viewer]];
// Who the link is for: Cardboard's own kind of picker (a menu, as its "16:9 ⌄" and model pickers), not an OS <select>.
function RolePicker({ role, setRole }) {
  return h(MenuButton, {
    label: words.whoCanDoWhat,
    ariaLabel: `${words.whoCanDoWhat}: ${ROLES.find(([v]) => v === role)?.[1] ?? ROLES[0][1]}`,
    triggerClassName: "carton-share-role-pick",
    trigger: [h("span", { key: "r" }, ROLES.find(([v]) => v === role)?.[1] ?? ROLES[0][1]), h(Icon, { key: "c", name: "caretDown", size: 12 })],
    children: (close) => ROLES.map(([v, label]) => h(MenuItem, { key: v, checked: role === v, onSelect: () => { setRole(v); close(); } }, label)),
  });
}

// The invite links made, by bridge, project, sharing server and role. One being made is shared (the dialog's opening and
// a Copy link pressed meanwhile make one invite, not two). A link made is kept for the next openings only while it
// surely works: an hour at most, and until a minute before it expires (liveInvite's `expiresAt`: a server may give its
// invites a short life); one whose expiry isn't known is made again at the next opening (review of fix/ux2-b). A failed
// one is made again when next asked.
const madeLinks = new WeakMap();
const LINK_MS = 3_600_000, LINK_MARGIN_MS = 60_000;
function linkFor(bridge, projectId, host, role) {
  let m = madeLinks.get(bridge);
  if (!m) madeLinks.set(bridge, (m = new Map()));
  const k = [projectId, host ?? "", role].join("\n"), had = m.get(k);
  if (had && (had.pending || Date.now() < had.until)) return had.p;
  const e = { pending: true, until: 0, p: null };
  e.p = Promise.resolve().then(() => bridge.call("liveInvite", [{ projectId, role }])).then((r) => {
    if (typeof r?.link !== "string") throw new Error("no invite link");
    e.until = typeof r.expiresAt === "number" ? Math.min(Date.now() + LINK_MS, r.expiresAt - LINK_MARGIN_MS) : 0;
    return r.link;
  });
  e.p.then(() => { e.pending = false; }, () => { e.pending = false; if (m.get(k) === e) m.delete(k); });
  m.set(k, e);
  return e.p;
}

/**
 * Invite (owners): who can do what, the link and Copy link. Online, the link for the role picked is made as the dialog
 * opens (QA G24: never an empty field that reads as disabled), and copied from there; a link that couldn't be made then
 * is made again by Copy link, which says why if it fails again. Offline the server can't make one: Copy link is off and
 * says when it can.
 */
export function Invite({ projectId, bridge, host, offline }) {
  const [role, setRole] = useState("editor"), [links, setLinks] = useState({}), [copied, setCopied] = useState(null);
  const field = useRef(null);
  const link = links[role] ?? null;
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  useEffect(() => {
    if (offline || link) return undefined;
    let live = true;
    linkFor(bridge, projectId, host, role).then((l) => { if (live) setLinks((m) => ({ ...m, [role]: l })); }, () => {});
    return () => { live = false; };
  }, [offline, link, role, projectId, host, bridge]);
  const [copy, busy, error] = useAction(async () => {
    let l = link;
    if (!l) {
      l = await linkFor(bridge, projectId, host, role);
      setLinks((m) => ({ ...m, [role]: l }));
    }
    // a clipboard that refuses (no focus) leaves the link selected in its field, to copy by hand
    const done = await Promise.resolve(globalThis.navigator?.clipboard?.writeText(l)).then(() => true, () => false);
    if (done) setCopied(role);
    else requestAnimationFrame(() => field.current?.select());
  }, "invite");
  return h("section", { className: "carton-share-section carton-share-invite" },
    h("h3", { className: "carton-share-heading" }, words.invite),
    h("div", { className: "carton-share-invite-row" },
      h(RolePicker, { role, setRole: (r) => { setRole(r); setCopied(null); } }),
      h("input", { ref: field, className: "carton-input carton-share-link", readOnly: true, value: link ?? "", "aria-label": words.inviteLink, "aria-busy": !link && !offline ? true : undefined, onFocus: (e) => e.target.select() }),
      h(Button, { icon: copied === role ? "check" : "link", onClick: () => copy(), busy, disabled: offline, description: offline ? words.inviteWhenOnline : undefined }, copied === role ? words.copied : words.copyLink)),
    h("p", { className: "carton-field-hint" }, offline ? words.inviteWhenOnline : words.anyoneCanJoinTo(role)),
    h(Problem, { error }));
}

// The status by the title: Up to date, Sending N changes, Offline.
function StatusWord({ st }) {
  const offline = isOffline(st), sending = !offline && (st.status !== "up-to-date" || st.pending);
  const state = offline ? "offline" : sending ? "syncing" : "upToDate";
  const text = offline ? words.offline(0) : sending ? (st.pending ? words.sending(st.pending) : words.syncing) : words.upToDate;
  return h("span", { className: "carton-sync carton-share-status", role: "status", "aria-live": "polite", "data-state": state },
    h(Icon, { name: offline ? "cloudSlash" : sending ? "syncing" : "cloudCheck", size: 14 }), text);
}

/**
 * A shared project, below the title: one amber line (QA G9) that says why sync fails when it does, or, offline, that
 * your changes are kept and sent later (an unreachable server while offline is that line), then People. The server's
 * own message is that line's tooltip, for support, never its text (P2-12, H-SV).
 */
export function LiveStatus({ st }) {
  const offline = isOffline(st);
  const problem = st.problem && !(offline && st.problem.code === "unreachable") ? st.problem : null;
  const line = problem ? problem.words : st.pending ? words.offlineLine(st.pending) : words.offlineLineNone;
  return h("div", { className: "carton-share-live" },
    problem || offline
      ? h("div", { className: "carton-share-offline", role: problem ? "alert" : "status", "data-code": problem?.code, title: st.problem?.detail ?? undefined },
          h(Icon, { name: problem ? "warning" : "cloudSlash", size: 16 }),
          h("p", null, ...firstSentence(line)))
      : null,
    h(People, { st }));
}

/**
 * Not shared yet: share it. A server with open creation needs only its address and a name; the invite code shows only
 * when the server asks for one. An address that can't be reached says so at the address, never by asking for a code
 * (P1-8). The address once used is remembered, and shown as one line with Change.
 */
export function ShareForm({ projectId, bridge, title, onClose, onShared }) {
  const [saved] = useState(() => globalThis.localStorage?.getItem("carton.host") ?? "");
  const [hostUrl, setHost] = useState(saved), [secret, setSecret] = useState("");
  const [editHost, setEditHost] = useState(!saved);
  const [name, setName, saveName] = useName();
  const [known] = useState(() => !!name.trim());
  const [checked, setChecked] = useState(null); // what is known about the address: null (not yet), "open", "invite", "unreachable"
  const [missing, setMissing] = useState(null);
  useEffect(() => {
    setChecked(null);
    const v = hostAddress(hostUrl);
    if (!v) return undefined;
    let url;
    try { url = new URL(v); } catch { return undefined; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    let live = true;
    const t = setTimeout(() => bridge.call("liveHostInfo", [{ host: url.origin }]).then((i) => live && setChecked(i?.openCreate ? "open" : "invite"), () => live && setChecked("unreachable")), 400);
    return () => { live = false; clearTimeout(t); };
  }, [hostUrl, bridge]);
  const [share, busy, error, setError] = useAction(async () => {
    const host = hostAddress(hostUrl);
    try { globalThis.localStorage?.setItem("carton.host", host); } catch {}
    saveName(name.trim());
    // An owner invite from the server, or its admin token (used once to make one; never kept); neither for a server
    // with open creation.
    const s = secret.trim();
    const r = await bridge.call("liveShare", [{ projectId, host, name: name.trim(), ...(s ? (s.startsWith("ct1.") ? { invite: s } : { adminToken: s }) : {}) }]);
    onShared(r);
  }, "share");
  const submit = () => {
    const miss = !hostUrl.trim() ? "host" : !name.trim() ? "name" : checked === "invite" && !secret.trim() ? "secret" : null;
    setMissing(miss);
    setError(null);
    if (miss === "host") setEditHost(true);
    if (!miss) share();
  };
  const hostError = missing === "host" ? "Enter the sharing server's address." : fieldError(error, "host") ?? (checked === "unreachable" ? shareProblem("Couldn't reach", "share").text : null);
  // The code field: when the server asks for one, or when sharing said it was wrong.
  const askSecret = checked === "invite" || error?.field === "secret";
  const fields = askSecret ? ["host", "secret", "name"] : ["host", "name"];
  return h(Dialog, {
    title, onClose, className: "carton-share-dialog",
    footer: [
      h("div", { key: "p", className: "carton-share-foot-note" }, h(Problem, { error, fields })),
      h(Button, { key: "c", variant: "secondary", size: "md", onClick: onClose }, words.cancel),
      h(Button, { key: "s", variant: "primary", size: "md", busy, onClick: submit }, busy ? words.sharingNow : words.shareProject),
    ],
  },
    // Enter in any field shares, as the button does (a form of several fields has no implicit submit)
    h("form", { className: "carton-share-form", noValidate: true, onSubmit: (e) => { e.preventDefault(); submit(); }, onKeyDown: (e) => { if (e.key === "Enter" && e.target?.tagName === "INPUT") { e.preventDefault(); submit(); } } },
      h("p", { className: "carton-share-lead" }, words.shareLead),
      editHost || hostError
        ? h(Field, { id: "carton-share-host", label: words.sharingServer, hint: words.sharingServerHint, error: hostError, value: hostUrl, inputMode: "url", spellCheck: false, autoComplete: "url", onChange: (e) => setHost(e.target.value), placeholder: words.sharingServerPlaceholder })
        : h("div", { className: "carton-field" }, h("span", { className: "carton-field-label" }, words.sharingServer), h("p", { className: "carton-known" }, h("span", { className: "carton-known-value" }, shownAddress(hostUrl)), " ", h(ChangeLink, { onClick: () => setEditHost(true) }))),
      askSecret ? h(Field, { id: "carton-share-secret", label: "Invite code", hint: "This server asks for one. Ask whoever runs it.", error: missing === "secret" ? "Enter the invite code." : fieldError(error, "secret"), value: secret, onChange: (e) => setSecret(e.target.value), type: "password", "data-carton-secret": "" }) : null,
      h(NameField, { id: "carton-share-name", name, setName, known, error: missing === "name" ? "Enter your name." : fieldError(error, "name") })));
}

/** The status of a project's sharing: the worker's liveStatus, then its live events. Null until it answers. */
function useShareStatus(projectId, bridge) {
  const [st, setSt] = useState(null);
  const refresh = () => bridge.call("liveStatus", [{ projectId }]).then(setSt, (e) => setSt({ shared: false, error: errText(e) }));
  useEffect(() => {
    let live = true;
    bridge.call("liveStatus", [{ projectId }]).then((s) => live && setSt(s), (e) => live && setSt({ shared: false, error: errText(e) }));
    const off = bridge.onEvent((ev) => { if (live && ev?.id === projectId && ev.topic === "live") setSt((s) => ({ ...s, ...ev.live })); });
    return () => { live = false; if (typeof off === "function") off(); };
  }, [projectId, bridge]);
  return [st, refresh];
}

/** Share, as a dialog over the editor (PLAN 8.1). `name`: the project's, for its title. */
export function ShareDialog({ projectId, bridge, name, onClose }) {
  useEffect(() => { injectCardboardSkin(document); }, []);
  const [st, refresh] = useShareStatus(projectId, bridge);
  const title = shareTitle(name);
  if (!st) return h(Dialog, { title, onClose, className: "carton-share-dialog" }, h("div", { className: "carton-share-wait", "aria-busy": true }));
  if (!st.shared) return h(ShareForm, { key: "form", projectId, bridge, title, onClose, onShared: () => void refresh() });
  return h(Dialog, { key: "shared", title, onClose, className: "carton-share-dialog", aside: h(StatusWord, { st }) },
    h(LiveStatus, { st }),
    // Only the owner can invite (the server checks too)
    st.role === "owner" ? h(Invite, { projectId, bridge, host: st.host, offline: isOffline(st) }) : null);
}

/**
 * Join a shared project (PLAN 8.2): the invite link and who you join as, then one button, Join and open: the project
 * comes into the library and opens in its tab, and the dialog closes. If it can't open (the tab couldn't be made), the
 * dialog says the project is in the library, with Open to try again. Shown by the Dashboard's host (sync/patches/ui.js),
 * which stays mounted while the library's view changes under it (final re-check N1).
 */
export function Join({ bridge, onOpened, onCancel: cancel }) {
  const [link, setLink] = useState(""), [done, setDone] = useState(null), [missing, setMissing] = useState(null);
  // Cancel (or the dialog going away) while the join is answered: the project still comes into the library, but nothing
  // opens it afterwards (review of feat/ux-2-8 #5: a dismissed Join opened a tab when its answer came).
  const dismissed = useRef(false);
  useEffect(() => () => { dismissed.current = true; }, []);
  const onCancel = () => { dismissed.current = true; cancel?.(); };
  const [name, setName, saveName] = useName();
  const [known] = useState(() => !!name.trim());
  const [openIt, opening, openError] = useAction(async (d) => {
    if (!bridge.openProject) return;
    await bridge.openProject(d.projectId);
    onOpened?.();
  }, "open");
  const [join, busy, error, setError] = useAction(async () => {
    saveName(name.trim());
    const d = await bridge.call("liveJoin", [{ link: link.trim(), name: name.trim() }]);
    if (dismissed.current) return;
    setDone(d);
    await openIt(d);
  }, "join");
  if (done) {
    const still = opening || busy;
    return h(Dialog, {
      title: words.joinTitle, onClose: onCancel, className: "carton-join-dialog",
      footer: [
        h("div", { key: "p", className: "carton-share-foot-note" }, h(Problem, { error: openError })),
        h(Button, { key: "d", variant: "secondary", size: "md", onClick: onCancel, disabled: still }, "Done"),
        bridge.openProject ? h(Button, { key: "o", variant: "primary", size: "md", busy: still, onClick: () => openIt(done) }, still ? words.openingNow : words.openIt) : null,
      ],
    }, h("div", { className: "carton-join-done", role: "status" },
      h("p", null, words.inYourLibrary(done.name)),
      h("p", { className: "carton-share-lead" }, "Its footage arrives while your teammate's computer sends it: video as preview copies.")));
  }
  const submit = () => {
    const miss = !link.trim() ? "link" : !name.trim() ? "name" : null;
    setMissing(miss);
    setError(null);
    if (!miss) join();
  };
  return h(Dialog, {
    title: words.joinTitle, onClose: onCancel, className: "carton-join-dialog",
    footer: [
      h("div", { key: "p", className: "carton-share-foot-note" }, h(Problem, { error, fields: ["link", "name"] })),
      h(Button, { key: "c", variant: "secondary", size: "md", onClick: onCancel }, words.cancel),
      h(Button, { key: "j", variant: "primary", size: "md", busy, onClick: submit }, busy ? words.joiningNow : words.joinAndOpen),
    ],
  },
    h("form", { className: "carton-share-form", noValidate: true, onSubmit: (e) => { e.preventDefault(); submit(); }, onKeyDown: (e) => { if (e.key === "Enter" && e.target?.tagName === "INPUT") { e.preventDefault(); submit(); } } },
      h("p", { className: "carton-share-lead" }, words.joinLead),
      h(Field, { id: "carton-join-link", label: words.inviteLink, error: missing === "link" ? "Paste the invite link you were sent." : fieldError(error, "link"), value: link, spellCheck: false, onChange: (e) => setLink(e.target.value), placeholder: "https://…/#join=…" }),
      h(NameField, { id: "carton-join-name", name, setName, known, line: words.joinAs, error: missing === "name" ? "Enter your name." : fieldError(error, "name") })));
}

window.__cartonSyncUi = { ShareDialog, LiveStatus, People, shareProblem, ShareForm, Join, Invite, Problem, hostAddress, shareTitle, linkFor };
