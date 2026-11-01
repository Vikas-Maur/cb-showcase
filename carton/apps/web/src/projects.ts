// The projects this browser has made or joined, for the landing page's list: name, role and when it was last opened,
// kept in this browser only (localStorage). Opening one goes to `#p=<id>`, which resumes its saved session.

import type { KeyStore } from "./session.ts";

export interface KnownProject {
  projectId: string;
  name: string;
  role: "owner" | "editor" | "commenter" | "viewer";
  /** Last opened (ms epoch). */
  at: number;
}

const KEY = "carton.projects";

export function knownProjects(keys: KeyStore): KnownProject[] {
  try {
    const list = JSON.parse(keys.get(KEY) ?? "[]") as KnownProject[];
    return Array.isArray(list) ? list.filter((p) => typeof p?.projectId === "string" && typeof p.name === "string").sort((a, b) => b.at - a.at) : [];
  } catch {
    return [];
  }
}

export function rememberProject(keys: KeyStore, p: Omit<KnownProject, "at">): void {
  const list = knownProjects(keys).filter((x) => x.projectId !== p.projectId);
  keys.set(KEY, JSON.stringify([{ ...p, at: Date.now() }, ...list].slice(0, 100)));
}

/** A role in an editor's words. */
export const roleWords: Record<KnownProject["role"], string> = { owner: "Owner", editor: "Can edit", commenter: "Can comment", viewer: "Can watch" };
