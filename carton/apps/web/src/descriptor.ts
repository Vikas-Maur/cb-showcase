// What an invite needs beyond the token: the shared cut a joiner opens (`Carton.open({init: {join}})`) and the
// media the timeline shows. The sharer writes it once into the project's media scope; joiners read it with their
// session. The root is checked against its hash by Carton before anything is stored.
//
// Links carry the host, project and invite in the URL fragment, so they never reach a server log:
//   /#join=<projectId>.<invite>            Invite to edit (§0.1)
//   /watch.html#p=<projectId>&c=<cutId>&src=<cutId>&at=<seq>&i=<viewer invite>   the Published cut's watch page

import type { CutRecord, Doc } from "@carton/core";
import type { SampleMedia } from "./demo-doc.ts";

export const DESCRIPTOR_KEY = "carton/project.json";

export interface ProjectDescriptor {
  v: 1;
  projectId: string;
  name: string;
  /** The shared Main cut as the host knows it after the hand-off (sequencer "server"). */
  cut: CutRecord;
  doc0: Doc;
  rootHash: string;
  /** Media record id → its content hash and T1 extras. */
  media: Record<string, SampleMedia>;
}

export function parseDescriptor(text: string): ProjectDescriptor {
  const d = JSON.parse(text) as ProjectDescriptor;
  if (d?.v !== 1 || typeof d.projectId !== "string" || !d.cut?.id || d.cut.sequencer?.kind !== "server" || typeof d.rootHash !== "string" || !d.doc0) throw new Error("this project's share data is unreadable");
  return d;
}

export interface JoinLink {
  projectId: string;
  invite: string;
}
/** `#join=<projectId>.<invite>`: the project id has no dots (host-http's id alphabet allows them, our seed never uses them). */
export function parseJoinHash(hash: string): JoinLink | null {
  const m = /^#join=([A-Za-z0-9_~-]{1,128})\.(.+)$/.exec(hash);
  return m ? { projectId: m[1]!, invite: m[2]! } : null;
}
export const joinHash = (projectId: string, invite: string) => `#join=${projectId}.${invite}`;

export interface WatchLink {
  projectId: string;
  /** The Published cut. */
  cut: string;
  /** The cut it was published from, and the version (seq) published. */
  source: string;
  at: number;
  invite: string;
}
export function parseWatchHash(hash: string): WatchLink | null {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  const projectId = q.get("p"), cut = q.get("c"), source = q.get("src"), at = Number(q.get("at")), invite = q.get("i");
  if (!projectId || !cut || !source || !Number.isInteger(at) || !invite) return null;
  return { projectId, cut, source, at, invite };
}
export const watchHash = (l: WatchLink) => `#${new URLSearchParams({ p: l.projectId, c: l.cut, src: l.source, at: String(l.at), i: l.invite })}`;
