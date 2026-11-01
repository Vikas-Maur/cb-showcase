// The sequencer's blobs and the media API's blobs live in separate scopes of the host's store: a media upload, even
// one named like a keyframe, can never overwrite the sequencer's records.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHmacAuth } from "@carton/server";
import { createFsBlobStore } from "@carton/blob-fs";
import type { sync } from "@carton/core";
import { startNodeHost, webSocketTransport, type NodeHost } from "../src/index.ts";
import { scratch } from "./scratch.ts";

const SECRET = "test-only-secret-test-only-secret-0123";
let host: NodeHost | null = null;
after(() => host?.close());

test("media uploads land under projects/<p>/media/, the sequencer's keyframes under projects/<p>/seq/", async () => {
  const dir = scratch("scopes");
  const auth = createHmacAuth({ secret: SECRET });
  const blobs = createFsBlobStore({ root: join(dir, "blobs") });
  host = await startNodeHost({ dataDir: join(dir, "data"), auth, secret: SECRET, blobs, durability: "normal" });
  const token = await auth.issue({ account: "e", credential: "e/dev", role: "owner", projectId: "p", ttlMs: 60_000 });

  // the sequencer stores the shared cut's starting state as a keyframe blob
  const c = await webSocketTransport({ keepaliveMs: 0 }).connect(host.urlFor("p"), { token });
  const adopted = new Promise((ok) => c.onMessage((m) => m.type === "adopted" && ok(m)));
  const doc0 = { tracks: [{ id: "V1" }], timelineItems: [] };
  c.send({ type: "adopt", branchId: "b1", n: 0, stateHash: "", rows: [], rec: { id: "b1", name: "main", forkOf: null, owner: "e", kind: "main", sequencer: { kind: "server", since: 0 } }, doc0, closure: [] } as unknown as sync.ClientMessage);
  await adopted;
  c.close();
  const seqKeys = (await blobs.list("projects/p/seq/")).blobs.map((b) => b.key);
  assert.ok(seqKeys.length > 0, "the sequencer wrote its keyframe blob");

  // an editor signs a PUT for a media key named exactly like a sequencer key
  const name = seqKeys[0]!.slice("projects/p/seq/".length);
  const r = await fetch(`${host.httpUrl}/api/projects/p/blobs/sign`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ key: name, method: "PUT" }) });
  const { url } = (await r.json()) as { url: string };
  assert.ok((await fetch(url, { method: "PUT", body: "overwrite attempt" })).ok);

  assert.ok(await blobs.head(`projects/p/media/${name}`), "the upload is in the media scope");
  for (const k of seqKeys) assert.notEqual(new TextDecoder().decode((await blobs.get(k))!), "overwrite attempt", `${k} was overwritten`);
  const all = (await blobs.list("projects/p/")).blobs.map((b) => b.key);
  assert.ok(all.every((k) => k.startsWith("projects/p/seq/") || k.startsWith("projects/p/media/")), JSON.stringify(all));
});
