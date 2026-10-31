// Damage reports (e2e S5-5), append-only: nothing here deletes, so they work through any BlobStore with put, get and
// HEAD (a Carton host's HTTP API has no DELETE, and won't get one: it would widen what a client may do).
//
//   bad/<id>       a reader found bytes that never verify (id: a media hash, or a stream id). Each report is a new body
//                  (a random nonce), so a later report never looks like an earlier one.
//   repaired/<id>  an upload replaced the object: names the exact report it answered (the report's bytes, as hex).
//
// A report counts until a repair names it. A report written after the repair started is a different body, so it still
// counts: the next upload replaces the object again (conservative; no clocks compared, so skew between machines can't
// hide a report). Stream ids are never reused (a takeover makes a new stream), so their reports are never answered.

import { isMediaHash, toHex } from "./bytes.ts";
import type { BlobStore } from "./contracts.ts";
import { damagedKey } from "./keys.ts";

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export const repairedKey = (id: string): string => {
  if (!isMediaHash(id)) throw new TypeError(`not a media hash or stream id: ${id}`);
  return `repaired/${id}`;
};

/** Writes a new damage report for `id`. Best effort: a store that refuses (a read-only role) just gets no report. */
export async function reportDamage(store: BlobStore, id: string, what: Record<string, unknown> = {}): Promise<void> {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(8)));
  const body = utf8.encode(JSON.stringify({ ...what, at: Date.now(), nonce }));
  await store.put(damagedKey(id), body, { contentType: "application/json" }).catch(() => {});
}

/** The report that counts for `id` now (its bytes), or null: none, or one a repair has answered. */
export async function openReport(store: BlobStore, id: string): Promise<Uint8Array | null> {
  const report = await store.get(damagedKey(id));
  if (!report) return null;
  const answer = await store.get(repairedKey(id));
  if (answer) {
    try {
      const v = JSON.parse(fromUtf8.decode(answer)) as { report?: unknown };
      if (v.report === toHex(report)) return null;
    } catch {
      // an unreadable answer answers nothing
    }
  }
  return report;
}

export async function isDamaged(store: BlobStore, id: string): Promise<boolean> {
  return (await openReport(store, id)) !== null;
}

/** Records that `report` (as read before the repair) is answered: the object was replaced since. */
export async function markRepaired(store: BlobStore, id: string, report: Uint8Array): Promise<void> {
  await store.put(repairedKey(id), utf8.encode(JSON.stringify({ report: toHex(report), at: Date.now() })), { contentType: "application/json" });
}
