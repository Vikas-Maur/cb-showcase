// The web client's entry (PLAN §17): what a share link opens. Routes on the URL fragment (so links never reach a
// server log and neither host needs SPA routing):
//   #join=<project>.<invite>  → ask the person's name, join, open the project (the invite then leaves the URL)
//   #p=<project>              → reopen with this install's saved session
//   (nothing)                 → how to get in
// It mounts a Preact root (`react` is aliased to preact/compat at build time) with @carton/react on the cardboard skin.
// index.html paints a static shell first (no script needed), then this small entry replaces it.

import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { injectCardboardSkin } from "@carton/react/skin/cardboard";
import { parseJoinHash } from "./descriptor.ts";
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
  // the landing card links the changelog: a static page in public/changelog/, no part of this bundle
  root.render(
    h(
      Card,
      { title: "Carton web demo" },
      h("p", { className: "cb-dim" }, "Open an invite link to edit a project, or a share link to watch one."),
      h("p", { className: "cb-gate-more" }, h("a", { href: "/changelog/" }, "See what we’ve built →")),
    ),
  );
}

addEventListener("hashchange", () => location.reload());
route().catch((e) => message("Something went wrong", (e as Error).message));
