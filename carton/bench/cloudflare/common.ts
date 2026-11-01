// What the lab's coordinator and party processes share: the deployed hosts, the secrets (read from outside the repo,
// never printed), the project's schema and first document, the edit generator, and the cut's adoption.
import { readFileSync } from "node:fs";
import { defineSchema, sync, type Doc } from "@carton/core";
import { createHmacAuth } from "@carton/server";
import type { Role } from "@carton/core/plugins";
import { webSocketTransport } from "@carton/server-node";

export const HOSTS = {
  r2: "https://carton-lab-r2.vikasmaur10.workers.dev",
  nor2: "https://carton-lab-nor2.vikasmaur10.workers.dev",
} as const;
export type HostName = keyof typeof HOSTS;
export const SECRETS_FILE = "/home/ubuntu/.config/carton-lab-secrets.json";
export const secrets = (): { AUTH_SECRET: string; ADMIN_TOKEN: string } => JSON.parse(readFileSync(SECRETS_FILE, "utf8"));

/** A session for `account` on `projectId`, signed with the deployment's secret (what join hands out after an invite). */
export async function tokenFor(projectId: string, account: string, role: Role = "editor", ttlMs = 3 * 3600_000): Promise<string> {
  const auth = createHmacAuth({ secret: secrets().AUTH_SECRET });
  return auth.issue({ account, credential: `${account}/lab-${Math.random().toString(36).slice(2, 10)}`, role, projectId, ttlMs });
}
export const wsUrl = (host: HostName, projectId: string) => `${HOSTS[host].replace(/^http/, "ws")}/api/projects/${projectId}/ws`;

// The Cardboard-shaped timeline the conformance live suite uses, with 40 clips on 4 tracks.
const TL = { collection: "timelineItems", lanes: "tracks", lane: "trackId", start: "startTime", end: "endTime", source: "trimStart", sourceEnd: "trimEnd", speed: "playbackSpeed" };
export const schema = defineSchema({
  collections: {
    tracks: { key: "id", seq: true },
    timelineItems: { key: "id", parent: { field: "trackId", collection: "tracks" }, groups: [{ name: "time", fields: ["startTime", "endTime", "trimStart", "trimEnd", "playbackSpeed"] }] },
  },
  timeline: TL,
});
export interface Clip { id: string; trackId: string; startTime: number; endTime: number; trimStart: number; trimEnd: number; opacity: number; name: string }
const clip = (id: string, s: number, e: number, track: string): Clip => ({ id, trackId: track, startTime: s, endTime: e, trimStart: 0, trimEnd: e - s, opacity: 1, name: id });
export const DOC0 = {
  tracks: [{ id: "V1" }, { id: "V2" }, { id: "V3" }, { id: "A1" }],
  timelineItems: Array.from({ length: 40 }, (_, i) => clip(`c${i}`, (i % 10) * 6, (i % 10) * 6 + 5, ["V1", "V2", "V3", "A1"][Math.floor(i / 10)]!)),
} as unknown as Doc;
export const SCHEMA_VERSION = 1;

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
}

/**
 * One edit, as the P9 load test makes them: 60% timing (move, trim in, trim out, frame-accurate; merge policy), 40%
 * opacity (lww). `hot` of the edits go to the first 4 clips, so parties really do edit the same clips at once.
 */
export function genEdit(rand: () => number, head: Doc, hot = 0.3): { ops: sync.CommitInput["ops"]; policy: "merge" | "lww" } | null {
  const items = (head as unknown as { timelineItems: Clip[] }).timelineItems;
  const pool = rand() < hot ? items.slice(0, 4) : items;
  const it = pool[Math.floor(rand() * pool.length)]!;
  const q = (t: number) => Math.round(t * 30) / 30;
  const set = (f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", it.id, f], value: v });
  if (rand() >= 0.6) return { ops: [set("opacity", Math.round(rand() * 100) / 100)], policy: "lww" };
  const k = rand(), sign = rand() < 0.5 ? -1 : 1;
  if (k < 1 / 3) {
    const d = q(sign * (0.1 + rand() * 0.9));
    if (it.startTime + d < 0) return null;
    return { ops: [set("startTime", q(it.startTime + d)), set("endTime", q(it.endTime + d))], policy: "merge" };
  }
  if (k < 2 / 3) {
    const d = q(sign * (0.1 + rand() * 0.4));
    if (!(it.startTime + d >= 0 && it.startTime + d < it.endTime - 0.3 && it.trimStart + d >= 0)) return null;
    return { ops: [set("startTime", q(it.startTime + d)), set("trimStart", q(it.trimStart + d))], policy: "merge" };
  }
  const d = q(sign * (0.1 + rand() * 0.4));
  if (!(it.endTime + d > it.startTime + 0.3)) return null;
  return { ops: [set("endTime", q(it.endTime + d)), set("trimEnd", q(it.trimEnd + d))], policy: "merge" };
}

/** The server adopts the cut (§5.3) from a raw connection, as the hand-off upload does. */
export async function adopt(host: HostName, projectId: string, branch: string): Promise<void> {
  const t = webSocketTransport({ keepaliveMs: 0 });
  const owner = await t.connect(wsUrl(host, projectId), { token: await tokenFor(projectId, "owner", "owner") });
  const adopted = new Promise((ok, no) => {
    owner.onMessage((m) => (m.type === "adopted" ? ok(m) : m.type === "error" ? no(new Error(JSON.stringify(m))) : undefined));
    setTimeout(() => no(new Error("adopt timed out")), 30_000);
  });
  owner.send({ type: "adopt", branchId: branch, n: 0, stateHash: "", rows: [], rec: { id: branch, name: "main", forkOf: null, owner: "owner", kind: "main", sequencer: { kind: "server", since: 0 } }, doc0: DOC0, closure: [] } as unknown as sync.ClientMessage);
  await adopted;
  owner.close();
}

/** Wall-clock ms with sub-ms precision, comparable across processes on one machine. */
export const now = () => performance.timeOrigin + performance.now();

export function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]! : NaN);
  return { n: s.length, p50: p(0.5), p90: p(0.9), p99: p(0.99), max: s.at(-1) ?? NaN, mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN };
}
