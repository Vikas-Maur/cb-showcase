// Catch-up pages by bytes as well as rows: many large changes reach a joiner over several pages, in order, with
// nothing lost; every reply is at most the budget plus one row, and no page loads much more than it sends.
import test from "node:test";
import assert from "node:assert/strict";
import type { SqlValue } from "@carton/core/plugins";
import type { sync } from "@carton/core";
import { BRANCH, clip, doc, fakeConn, memoryBlobs, push, set, sqliteStorage, verdict, world } from "./helpers.ts";

const KiB = 1024, MiB = 1024 * KiB;
const utf8 = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** node:sqlite storage that records the most row bytes one catch-up row query loaded. */
function metered() {
  const st = sqliteStorage();
  const exec = st.exec.bind(st);
  let maxLoaded = 0;
  st.exec = (<R>(sql: string, ...params: SqlValue[]): R[] => {
    const rows = exec<Record<string, SqlValue>>(sql, ...params);
    if (/^SELECT seq, id, hash, author/.test(sql)) {
      let n = 0;
      for (const r of rows) for (const v of Object.values(r)) n += v instanceof Uint8Array ? v.byteLength : typeof v === "string" ? v.length : 8;
      maxLoaded = Math.max(maxLoaded, n);
    }
    return rows as unknown as R[];
  }) as typeof st.exec;
  return { storage: st, maxLoaded: () => maxLoaded };
}

for (const archived of [false, true]) test(`catch-up pages by bytes${archived ? " (half the rows archived in blob segments)" : ""}: 4 MiB pages, at least one row each, in order, nothing lost, never much more loaded than sent`, async (t) => {
  const d0 = doc([clip("c0", 0, 5), clip("c1", 5, 10), clip("c2", 10, 15)]);
  const m = metered();
  const { seq } = await world(d0, { storage: m.storage, blobs: memoryBlobs() });
  const writer = fakeConn("writer/1");
  // 36 inline changes of 300 KiB, three of 1.5 MiB (bodies in the blob store), one of 6 MiB (over the budget alone)
  const sizes: number[] = [];
  for (let i = 0; i < 40; i++) sizes.push(i === 20 ? 6 * MiB : i % 12 === 5 ? 1.5 * MiB : 300 * KiB);
  const ids: string[] = [];
  for (const [i, n] of sizes.entries()) {
    const r = await push(seq, writer, d0, [set(`c${i % 3}`, "name", `${i}:`.padEnd(n, "x"))]);
    assert.equal(verdict(r), "ack");
    ids.push((r as sync.AckMsg).id);
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  assert.ok(total > 5 * 4 * MiB, "well over the budget in all");
  if (archived) assert.equal(await seq.archive(BRANCH, { keep: 20, segmentRows: 8 }), 16, "rows 1..16 in two segments");

  // a fresh joiner (have: -1: the root keyframe, then the rows), paging while `more`
  const joiner = fakeConn("joiner/1");
  const got: { seq: number; id: string; name: string }[] = [];
  const pages: { rows: number; bytes: number; biggestRow: number }[] = [];
  let have = -1;
  for (;;) {
    joiner.inbox.length = 0;
    await seq.handle(joiner, { type: "hello", branchId: BRANCH, have, pending: [], rids: [], schemaVersion: 1 });
    const w = joiner.inbox.find((x) => x.type === "hello") as sync.WelcomeMsg;
    assert.ok(w, `a welcome for have ${have}`);
    pages.push({ rows: w.rows.length, bytes: utf8(w), biggestRow: Math.max(0, ...w.rows.map(utf8)) });
    for (const r of w.rows) got.push({ seq: r.seq, id: r.id, name: String((r.ops[0] as { value: unknown }).value) });
    have = w.rows.length ? w.rows[w.rows.length - 1]!.seq : (w.keyframe?.seq ?? have);
    if (!w.more) break;
    assert.ok(pages.length < 100, "pages make progress");
  }
  assert.deepEqual(got.map((g) => g.seq), sizes.map((_, i) => i + 1), "every row, in order, once");
  assert.deepEqual(got.map((g) => g.id), ids);
  for (const [i, g] of got.entries()) assert.ok(g.name.length === sizes[i] && g.name.startsWith(`${i}:`), `row ${i + 1} intact`);
  // the 6 MiB row fills a page alone; the rest needs at least ceil(rest / 4 MiB) pages
  assert.ok(pages.length >= 1 + Math.ceil((total - 6 * MiB) / (4 * MiB)), `several pages (${pages.length})`);
  t.diagnostic(`pages [rows, KiB]: ${JSON.stringify(pages.map((p) => [p.rows, Math.round(p.bytes / KiB)]))}; most loaded by one row query: ${Math.round(m.maxLoaded() / KiB)} KiB`);
  for (const [i, p] of pages.entries()) {
    assert.ok(p.rows >= 1 || i === 0, `page ${i} makes progress`);
    assert.ok(p.bytes <= 4 * MiB + p.biggestRow, `page ${i}: ${p.bytes} bytes ≤ the budget plus one row`);
    if (p.rows > 1) assert.ok(p.bytes <= 4 * MiB + 4 * KiB, `page ${i} of ${p.rows} rows stays within the budget`);
  }
  assert.ok(pages.some((p) => p.rows === 1 && p.biggestRow > 6 * MiB), "the 6 MiB row comes alone, in its own page");
  // big bodies come from the blob store one at a time; SQL holds inline ones (at most 1 MiB): budget plus one row
  assert.ok(m.maxLoaded() <= 4 * MiB + 1.1 * MiB, `one page's row query loaded ${m.maxLoaded()} bytes: the budget plus one row at most`);
});

test("catch-up pages by bytes: a client reading envelopes gets each big page as one, and still every row in order", async () => {
  const d0 = doc([clip("c0", 0, 5)]);
  const blobs = memoryBlobs();
  const { seq } = await world(d0, { blobs, catchupBytes: 1 * MiB });
  const writer = fakeConn("writer/2");
  for (let i = 0; i < 12; i++) assert.equal(verdict(await push(seq, writer, d0, [set("c0", "name", `${i}:`.padEnd(400 * KiB, "y"))])), "ack");
  const joiner = fakeConn("joiner/2");
  const seqs: number[] = [];
  let have = 0, pages = 0;
  for (;;) {
    joiner.inbox.length = 0;
    await seq.handle(joiner, { type: "hello", branchId: BRANCH, have, pending: [], rids: [], schemaVersion: 1, envelopes: true });
    const m = joiner.inbox[0]!;
    const w = (m.type === "blob" ? await import("@carton/core").then(({ sync: s }) => s.unseal(m.ref, blobs, { from: "server", maxBytes: 1 << 30 })) : m) as sync.WelcomeMsg;
    pages++;
    seqs.push(...w.rows.map((r) => r.seq));
    have = seqs.at(-1) ?? have;
    if (!w.more) break;
  }
  assert.deepEqual(seqs, Array.from({ length: 12 }, (_, i) => i + 1));
  assert.ok(pages >= 4, `${pages} pages of at most 1 MiB plus a row`);
});
