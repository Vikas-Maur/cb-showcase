// Seed a demo project on a host (PLAN §17): generated sample clips (never anyone's footage) uploaded as media, the
// "Weekend reel" document made from them, its Main cut handed to the host (§5.3 hand-off), the project descriptor
// joiners read, and the invite links: Alice's (owner: she can invite and publish) and an editor's (Bob's).
//   node scripts/seed.ts --url http://127.0.0.1:8787 --admin-token <token> [--project <id>] [--no-media]
// Prints one JSON line: {projectId, alice, bob} (the links). Works against server-node and the Worker alike: it only
// speaks the hosts' HTTP API and the sync protocol.

import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Carton, hashDoc, type CutRecord } from "@carton/core";
import type { BlobStore } from "@carton/core/plugins";
import { cardboardAdapter } from "@carton/cardboard";
import { createMemoryStore } from "@carton/store-memory";
import { webSocketTransport } from "../src/ws-transport.ts";
import { demoDoc, type SampleMedia } from "../src/demo-doc.ts";
import { DESCRIPTOR_KEY, joinHash, type ProjectDescriptor } from "../src/descriptor.ts";
import { putBlob } from "../src/project.ts";
import { Session, memoryKeys } from "../src/session.ts";

export interface SeedResult {
  projectId: string;
  /** Alice's invite link (owner). */
  alice: string;
  /** An editor's invite link (Bob, and the Director bot). */
  bob: string;
  descriptor: ProjectDescriptor;
}

async function adminInvite(baseUrl: string, adminToken: string, projectId: string, role: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/admin/projects/${projectId}/invites`, { method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ role }) });
  if (!r.ok) throw new Error(`admin invite: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { invite: string }).invite;
}

/** Media for the seed: generated and uploaded (default), given, or none (protocol tests that need no playback). */
export type SeedMedia = { generate: { clipsDir: string } } | { given: SampleMedia[] } | "none";

export async function seedDemo(o: { baseUrl: string; adminToken: string; projectId?: string; name?: string; media?: SeedMedia; log?: (s: string) => void }): Promise<SeedResult> {
  const log = o.log ?? (() => {});
  const projectId = o.projectId ?? `demo-${[...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const session = await Session.join({ baseUrl: o.baseUrl, projectId, invite: await adminInvite(o.baseUrl, o.adminToken, projectId, "owner"), account: "seed", keys: memoryKeys() });
  let media: SampleMedia[] = [];
  const m = o.media ?? { generate: { clipsDir: join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "clips") } };
  if (m !== "none" && "given" in m) media = m.given;
  else if (m !== "none") {
    // the media slice (ffmpeg, the HTTP blob store) is loaded only when media are generated
    const { httpBlobStore } = await import("../src/http-blobs.ts");
    const { makeSampleClips } = await import("./clips.ts");
    const { uploadSampleMedia } = await import("./upload-media.ts");
    const blobs: BlobStore = httpBlobStore({ baseUrl: o.baseUrl, projectId, token: () => session.token() });
    log("generating sample clips");
    const clips = await makeSampleClips(m.generate.clipsDir);
    log(`uploading ${clips.length} clips`);
    const up = await uploadSampleMedia({ store: blobs, clips });
    media = up.map((u, i) => ({ id: `media-${i + 1}`, name: clips[i]!.name, hash: u.hash, size: u.size, duration: u.duration, poster: u.poster, filmstrip: u.filmstrip }));
  }

  const doc = demoDoc(media, o.name);
  const carton = await Carton.open({
    adapter: cardboardAdapter,
    store: createMemoryStore(),
    init: { doc, projectId, cutName: "Main cut" },
    actor: { kind: "system", id: "seed", name: "Carton" },
    name: "Alice",
    sync: { transport: webSocketTransport(), url: session.wsUrl, token: () => session.token() },
  });
  await carton.share();
  let cut: CutRecord | undefined;
  for (let i = 0; i < 200; i++) {
    cut = (await carton.cuts()).find((c) => c.id === carton.cut);
    if (cut?.sequencer.kind === "server") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (cut?.sequencer.kind !== "server") throw new Error("the host didn't take the Main cut (hand-off timed out)");
  const doc0 = await carton.checkout(`${cut.id}@0`);
  const descriptor: ProjectDescriptor = { v: 1, projectId, name: String(doc.name), cut, doc0, rootHash: hashDoc(doc0, cardboardAdapter.schema), media: Object.fromEntries(media.map((x) => [x.id, x])) };
  await putBlob(session, DESCRIPTOR_KEY, new TextEncoder().encode(JSON.stringify(descriptor)), "application/json");
  await carton.close();
  const link = (invite: string) => `${o.baseUrl}/${joinHash(projectId, invite)}`;
  return { projectId, alice: link(await session.invite("owner")), bob: link(await session.invite("editor")), descriptor };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (k: string, d?: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const r = await seedDemo({
    baseUrl: arg("--url", "http://127.0.0.1:8787")!,
    adminToken: arg("--admin-token", process.env.CARTON_ADMIN_TOKEN ?? "")!,
    ...(arg("--project") ? { projectId: arg("--project")! } : {}),
    media: args.includes("--no-media") ? "none" : { generate: { clipsDir: resolve(arg("--clips", join(process.env.HOME ?? ".", "gfv-scratch", "carton", "web-demo", "clips"))!) } },
    log: (s) => console.error(s),
  });
  console.log(JSON.stringify({ projectId: r.projectId, alice: r.alice, bob: r.bob }));
}
