// The web client's entry (PLAN §17): what a share link opens. Routes on the URL fragment (so links never reach a
// server log and neither host needs SPA routing):
//   #join=<project>.<invite>  → ask the person's name, join, open the project (the invite then leaves the URL)
//   #p=<project>              → reopen with this install's saved session
//   #new                      → New project: a name, the person's name; the browser becomes its owner (a host with
//                               open creation only)
//   (nothing)                 → the landing page: New project, and the projects this browser made or joined
// It mounts a Preact root (`react` is aliased to preact/compat at build time) with @carton/react on the cardboard skin.
// index.html paints a static shell first (no script needed), then this small entry replaces it.

import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { injectCardboardSkin } from "@carton/react/skin/cardboard";
import { parseJoinHash } from "./descriptor.ts";
import { knownProjects, rememberProject, roleWords } from "./projects.ts";
import { Session, type KeyStore } from "./session.ts";
import { appCss } from "./styles.ts";
import { Btn } from "./ui.ts";

// The editor (core, the panels, the timeline) is a separate chunk: the join screen paints without it, and it is
// fetched at once in the background, so it is usually there by the time the person presses Join.
const editor = import("./boot.ts");
const boot = async (session: Session, name: string) => (await editor).boot({ session, name, root, keys, baseUrl, message });

const keys: KeyStore = { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v) };
const baseUrl = location.origin;

injectCardboardSkin(document);
const style = document.createElement("style");
style.id = "carton-web-css";
style.textContent = appCss;
document.head.append(style);
document.documentElement.classList.add("dark");

const root = createRoot(document.getElementById("root")!);

const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "guest";
/**
 * The account this install joins a project as: the name's slug plus a random suffix, made once per install and
 * project. The account is the actor id and the undo group (§8), so two people who type the same name (or names with
 * no Latin letters) must never share it; the name people see is kept apart, as the actor's display name.
 */
function accountFor(projectId: string, name: string): string {
  const k = `carton.account.${projectId}`;
  let a = keys.get(k);
  if (!a) {
    a = `${slug(name)}-${[...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    keys.set(k, a);
  }
  return a;
}

function Card(p: { title: string; children?: unknown }) {
  return h("div", { className: "cb-gate", "data-carton-skin": "cardboard" }, h("div", { className: "cb-gate-card" }, h("h1", null, p.title), p.children as never));
}

function JoinScreen({ onJoin }: { onJoin: (name: string) => Promise<void> }) {
  const [name, setName] = useState(localStorage.getItem("carton.name") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem("carton.name", name.trim());
      await onJoin(name.trim());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return h(
    Card,
    { title: "You're invited to edit" },
    h("p", { className: "cb-dim" }, "Edit this cut live with the people and agents already on it. Your edits sync as you make them, and keep working offline."),
    h(
      "form",
      { onSubmit: submit, className: "cb-gate-form" },
      h("label", { className: "cb-field" }, h("span", null, "Your name"), h("input", { className: "cb-input", value: name, autoFocus: true, "data-testid": "join-name", onInput: (e: Event) => setName((e.target as HTMLInputElement).value), placeholder: "Alice" })),
      h(Btn, { type: "submit", disabled: busy || !name.trim(), "data-testid": "join" }, busy ? "Joining…" : "Join"),
    ),
    error ? h("p", { className: "cb-error", role: "alert" }, error) : null,
  );
}

function message(title: string, text: string) {
  root.render(h(Card, { title }, h("p", { className: "cb-dim" }, text)));
}

/** What this host allows (open creation, the largest upload); a host from before them allows neither. */
async function hostInfo(): Promise<{ openCreate: boolean; maxUploadBytes: number | null }> {
  try {
    const r = await fetch(`${baseUrl}/api/host`);
    const d = r.ok ? ((await r.json()) as { openCreate?: boolean; maxUploadBytes?: number | null }) : {};
    return { openCreate: d.openCreate === true, maxUploadBytes: typeof d.maxUploadBytes === "number" ? d.maxUploadBytes : null };
  } catch {
    return { openCreate: false, maxUploadBytes: null };
  }
}

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(ms).toLocaleDateString();
};

function Landing({ openCreate }: { openCreate: boolean }) {
  const list = knownProjects(keys);
  return h(
    Card,
    { title: "Carton" },
    h("p", { className: "cb-dim" }, openCreate ? "Edit video together, live. Start a project and invite people, or open one you've been invited to." : "Open an invite link to edit a project, or a share link to watch one."),
    openCreate ? h("div", { className: "cb-gate-actions" }, h(Btn, { variant: "primary", "data-testid": "new-project", onClick: () => (location.hash = "#new") }, "New project")) : null,
    list.length
      ? h(
          "section",
          { className: "cb-projects", "data-testid": "project-list" },
          h("h2", null, "Your projects"),
          h(
            "ul",
            null,
            list.map((p) =>
              h(
                "li",
                { key: p.projectId },
                h("a", { href: `#p=${p.projectId}`, "data-testid": "project-open" }, h("span", { className: "cb-project-name" }, p.name), h("span", { className: "cb-dim" }, `${roleWords[p.role] ?? ""} · ${ago(p.at)}`)),
              ),
            ),
          ),
        )
      : null,
    h("p", { className: "cb-gate-more" }, h("a", { href: "/changelog/" }, "See what we’ve built →")),
  );
}

function NewProjectScreen() {
  const [title, setTitle] = useState("");
  const [name, setName] = useState(localStorage.getItem("carton.name") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!name.trim() || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem("carton.name", name.trim());
      const { emptyDoc, newProjectId, shareNewProject } = await import("./create.ts");
      const { webSocketTransport } = await import("@carton/server-node/transport");
      const projectId = newProjectId();
      const session = await Session.create({ baseUrl, projectId, account: accountFor(projectId, name.trim()), keys });
      keys.set(`carton.name.${projectId}`, name.trim());
      await shareNewProject({ session, doc: emptyDoc(title.trim()), actor: { kind: "human", id: session.account, name: name.trim(), group: session.account }, name: name.trim(), transport: webSocketTransport() });
      rememberProject(keys, { projectId, name: title.trim(), role: "owner" });
      history.replaceState(null, "", `${location.pathname}#p=${projectId}`);
      await boot(session, name.trim());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const field = (label: string, value: string, set: (v: string) => void, testid: string, placeholder: string, autoFocus = false) =>
    h("label", { className: "cb-field" }, h("span", null, label), h("input", { className: "cb-input", value, autoFocus, "data-testid": testid, placeholder, onInput: (e: Event) => set((e.target as HTMLInputElement).value) }));
  return h(
    Card,
    { title: "New project" },
    h("p", { className: "cb-dim" }, "An empty timeline with a video track and a captions track. You'll own it: add video, then invite people to edit, comment or watch."),
    h(
      "form",
      { onSubmit: submit, className: "cb-gate-form" },
      field("Project name", title, setTitle, "new-title", "Weekend reel", true),
      field("Your name", name, setName, "new-person", "Alice"),
      h("div", { className: "cb-gate-actions" }, h(Btn, { type: "button", onClick: () => (location.hash = "") }, "Cancel"), h(Btn, { type: "submit", variant: "primary", disabled: busy || !name.trim() || !title.trim(), "data-testid": "create" }, busy ? "Creating…" : "Create project")),
    ),
    error ? h("p", { className: "cb-error", role: "alert" }, error) : null,
  );
}

async function route(): Promise<void> {
  const join = parseJoinHash(location.hash);
  if (join) {
    root.render(
      h(JoinScreen, {
        onJoin: async (name: string) => {
          const session = await Session.join({ baseUrl, projectId: join.projectId, invite: join.invite, account: accountFor(join.projectId, name), keys });
          keys.set(`carton.name.${join.projectId}`, name);
          history.replaceState(null, "", `${location.pathname}#p=${join.projectId}`);
          await boot(session, name);
        },
      }),
    );
    return;
  }
  const p = /^#p=([A-Za-z0-9_~-]{1,128})$/.exec(location.hash)?.[1];
  if (p) {
    const session = await Session.resume({ baseUrl, projectId: p, keys });
    if (!session) return message("Your session ended", "Open the invite link again to rejoin. Your edits waiting to sync are kept in this browser.");
    return boot(session, keys.get(`carton.name.${p}`) ?? session.account);
  }
  const info = await hostInfo();
  if (location.hash === "#new" && info.openCreate) return void root.render(h(NewProjectScreen));
  // the landing card links the changelog: a static page in public/changelog/, no part of this bundle
  root.render(h(Landing, { openCreate: info.openCreate }));
}

addEventListener("hashchange", () => location.reload());
route().catch((e) => message("Something went wrong", (e as Error).message));
