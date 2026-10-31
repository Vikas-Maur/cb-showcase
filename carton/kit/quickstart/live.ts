// Quickstart: live editing, two people on one shared cut through the host from host.ts.
//   node kit/quickstart/live.ts <bundle> <host data dir> [http://127.0.0.1:8787]
// Alice owns <bundle> (made by import.ts). She shares its current cut and invites Bob as an editor. Bob joins from
// nothing: an empty history of his own, the invite's cut record and root state, and every row from the host. Both edit
// at once, each sees the other's edit, then Bob goes offline, edits, and comes back. Bob's history goes in a new
// folder next to the bundle, `Bob-XXXXXX/`.
import { mkdtempSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Carton, hashDoc, type Actor, type CutRecord, type Doc, type JoinInit, type Rec } from "@carton/core";
import { cardboardAdapter } from "@carton/cardboard";
import { nodeHasher, readProjectId } from "@carton/local";
import { webSocketTransport } from "@carton/server-node/transport";
import { openProjectStore, openSqliteStore } from "@carton/store-sqlite";

const [bundleArg, hostDir, origin = "http://127.0.0.1:8787"] = process.argv.slice(2);
if (!bundleArg || !hostDir) throw new Error("usage: node kit/quickstart/live.ts <bundle> <host data dir> [http://127.0.0.1:8787]");
const bundle = resolve(bundleArg);
const projectId = readProjectId(bundle);
const { adminToken } = JSON.parse(readFileSync(join(resolve(hostDir), "secrets.json"), "utf8")) as { adminToken: string };

// A session for one person, as a client gets it: an invite (here from the admin token), then join with an
// install key, the device's own secret (kept in the OS keychain or app data, never in the bundle).
async function session(account: string, role: "owner" | "editor"): Promise<string> {
  const post = async (path: string, body: unknown, auth?: string) => {
    const r = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return r.json() as Promise<Record<string, string>>;
  };
  const { invite } = await post(`/api/admin/projects/${projectId}/invites`, { role }, adminToken);
  return (await post(`/api/projects/${projectId}/join`, { invite, account, installKey: crypto.randomUUID() })).token;
}

const wsUrl = `${origin.replace(/^http/, "ws")}/api/projects/${projectId}/ws`;
// `join`: open a shared cut on a device that holds nothing of the project (an invite)
const open = async (store: Awaited<ReturnType<typeof openSqliteStore>>, actor: Actor, token: string, join?: JoinInit) =>
  Carton.open({ adapter: cardboardAdapter, store, hasher: nodeHasher, actor, ...(join ? { init: { join } } : {}), sync: { transport: webSocketTransport(), url: wsUrl, token } });
const until = async (what: string, ok: () => Promise<boolean>, ms = 10_000) => {
  for (const end = Date.now() + ms; !(await ok()); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error(`timed out: ${what}`);
};
const clip = (doc: Doc, name: string) => (doc.timelineItems as Rec[]).find((i) => i.name === name)!;
// documents are values: replace the record you change
const edit = (doc: Doc, name: string, fields: Record<string, unknown>): Doc => ({ ...doc, timelineItems: (doc.timelineItems as Rec[]).map((i) => (i.name === name ? { ...i, ...fields } : i)) });

const alice: Actor = { kind: "human", id: "alice", name: "Alice", group: "alice@laptop" };
const bob: Actor = { kind: "human", id: "bob", name: "Bob", group: "bob@desk" };

// Alice shares her cut: the host sequences it from now on
const aliceStore = (await openProjectStore({ bundleDir: bundle, projectId })).store;
const a = await open(aliceStore, alice, await session("alice", "owner"));
await a.share();
await until("the host to take the cut", async () => (await a.cuts()).find((c) => c.id === a.cut)!.sequencer.kind === "server");
console.log(`Alice shared "${(await a.cuts()).find((c) => c.id === a.cut)!.name}": ${a.sync!.state().label}`);

// What the invite carries to Bob besides the session: the shared cut's record and its root state (with its hash)
const cut = (await a.cuts()).find((c) => c.id === a.cut)! as CutRecord;
const doc0 = await a.checkout(`${cut.id}@0`);
const invite: JoinInit = { projectId, cut, doc0, rootHash: hashDoc(doc0, a.schema) };
// Bob joins from nothing: an empty carton.db of his own; the host sends him every row
const bobDir = mkdtempSync(join(dirname(bundle), "Bob-"));
const bobStore = await openSqliteStore(join(bobDir, "carton.db"));
const b = await open(bobStore, bob, await session("bob", "editor"), invite);
await until("Bob to connect", async () => b.sync!.status === "up-to-date");
console.log(`Bob joined: ${b.sync!.state().label}`);

// both edit at once: Alice the intro, Bob the outro; `wait` waits up to 5 s for the host's answer, as `cb` does
const [ra, rb] = await Promise.all([
  a.commit({ doc: edit((await a.head()).doc, "Intro", { textContent: "Hello" }), wait: 5000 }),
  b.commit({ doc: edit((await b.head()).doc, "Outro", { textContent: "Bye" }), wait: 5000 }),
]);
console.log(`Alice's edit: ${ra.status}, Bob's edit: ${rb.status}`);
await until("each to see the other's edit", async () => clip((await a.head()).doc, "Outro").textContent === "Bye" && clip((await b.head()).doc, "Intro").textContent === "Hello");
console.log(`Alice sees Bob's outro: "${clip((await a.head()).doc, "Outro").textContent}"; Bob sees Alice's intro: "${clip((await b.head()).doc, "Intro").textContent}"`);

// Bob goes offline and keeps editing; his edit waits, then syncs when he is back
await b.sync!.disconnect();
const offline = await b.commit({ doc: edit((await b.head()).doc, "Middle", { color: "#ff0000" }) });
console.log(`Bob offline: ${offline.status} (${b.sync!.state().label})`);
await b.sync!.connect();
await until("Bob's edit to reach Alice", async () => clip((await a.head()).doc, "Middle").color === "#ff0000");
console.log(`Bob back online: ${b.sync!.state().label}; Alice sees his edit`);
console.log(`History on Alice's side: ${(await a.log({ limit: 3 })).map((v) => `@${v.ref.seq} ${v.author?.name ?? v.author?.id ?? "?"}`).join(", ")}`);

await a.close();
await b.close();
await aliceStore.close();
await bobStore.close();
