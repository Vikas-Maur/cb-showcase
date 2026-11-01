// A new project made in the browser (the web demo standing on its own): an empty timeline, its Main cut handed to the
// host (§5.3 hand-off), and the project descriptor joiners read, as the seed script and the desktop app's Share do.
// The person who makes it is its owner: the host's open creation (`POST /api/projects/:p/create`) gave the session.

import { Carton, POS, hashDoc, type Actor, type CutRecord, type Doc } from "@carton/core";
import type { Transport } from "@carton/core/plugins";
import { cardboardAdapter } from "@carton/cardboard";
import { createMemoryStore } from "@carton/store-memory";
import { ITEMS, MEDIA, TRACKS, TRACK_CAPTIONS, TRACK_VIDEO, type SampleMedia } from "./demo-doc.ts";
import { DESCRIPTOR_KEY, type ProjectDescriptor } from "./descriptor.ts";
import { putBlob } from "./project.ts";
import type { Session } from "./session.ts";

/** An empty timeline: a captions track over a video track, as Cardboard starts a project. */
export function emptyDoc(name: string): Doc {
  return {
    name,
    aspectRatio: "16:9",
    [TRACKS]: [
      { id: TRACK_CAPTIONS, name: "Captions", type: "caption", [POS]: "a0" },
      { id: TRACK_VIDEO, name: "Video 1", type: "video", [POS]: "a1" },
    ],
    [ITEMS]: [],
    [MEDIA]: [],
  };
}

/** A project id the host has never seen (open creation claims each id once). */
export const newProjectId = () => `p-${[...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

/**
 * Hand `doc` to the host as the project's Main cut and write its descriptor. A short-lived Carton in memory does the
 * hand-off; the editor then opens the project from the descriptor like any joiner.
 */
export async function shareNewProject(o: { session: Session; doc: Doc; actor: Actor; name: string; transport: Transport; media?: Record<string, SampleMedia> }): Promise<ProjectDescriptor> {
  const { session } = o;
  const carton = await Carton.open({
    adapter: cardboardAdapter,
    store: createMemoryStore(),
    init: { doc: o.doc, projectId: session.projectId, cutName: "Main cut" },
    actor: o.actor,
    name: o.name,
    sync: { transport: o.transport, url: session.wsUrl, token: () => session.token() },
  });
  try {
    await carton.share();
    let cut: CutRecord | undefined;
    for (let i = 0; i < 400; i++) {
      cut = (await carton.cuts()).find((c) => c.id === carton.cut);
      if (cut?.sequencer.kind === "server") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (cut?.sequencer.kind !== "server") throw new Error("The host didn't take the project in time. Check your connection and try again.");
    const doc0 = await carton.checkout(`${cut.id}@0`);
    const descriptor: ProjectDescriptor = { v: 1, projectId: session.projectId, name: String(o.doc.name ?? "Untitled"), cut, doc0, rootHash: hashDoc(doc0, cardboardAdapter.schema), media: o.media ?? {} };
    await putBlob(session, DESCRIPTOR_KEY, new TextEncoder().encode(JSON.stringify(descriptor)), "application/json");
    return descriptor;
  } finally {
    await carton.close();
  }
}
