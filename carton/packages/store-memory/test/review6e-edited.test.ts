// Regressions from Stage F review round 6.5 (GPT 6.1 Sol, high) over de7bf7a, on the reviewer's repros.
// R6-14: `edited` (pendingChanges) compares a pending change's latest ops with those it was committed with, also after
// a restart: the pending row keeps a digest of the committed ops, so a later rebase that brings the ops back reads false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Carton, rippleInsert, rippleDelete, remapSpan, type Actor, type Rec, type RemapChain } from '@carton/core';
import { createMemoryStore } from '../src/index.ts';
import { adapter, doc0, set } from './fixture.ts';
import { until, world } from './world.ts';
const alice: Actor = { kind: 'human', id: 'alice' };
const bob: Actor = { kind: 'human', id: 'bob' };

async function setup(blockPush = false) {
  const w = world();
  const store = createMemoryStore();
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice, sync: w.sync('alice') });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === 'server');
  const baseSync = w.sync('bob', false);
  const sync = blockPush ? { ...baseSync, transport: { connect: async (...args: Parameters<typeof baseSync.transport.connect>) => {
    const c = await baseSync.transport.connect(...args);
    const wrapped: typeof c = { get open() { return c.open; }, onMessage: l => c.onMessage(l), onClose: l => c.onClose(l), close: () => c.close(),
      send: m => { if (m.type !== 'push') c.send(m); } };
    return wrapped;
  } } } : baseSync;
  const b = await Carton.open({ adapter, store, actor: bob, sync });
  const r = await b.commit({ ops: [set('f', 'startTime', 26), set('f', 'endTime', 31)] });
  assert.equal(r.status, 'pending');
  const original = (await store.range<any>('pending', { prefix: [b.cut] }))[0]!.value.ops;
  const ripple = async (chain: RemapChain) => {
    const ops = [];
    for (const it of (await a.head()).doc.items as Rec[]) {
      const mapped = remapSpan(chain, it.startTime as number, it.endTime as number);
      assert.ok(mapped);
      if (mapped[0] !== it.startTime) ops.push(set(it.id as string, 'startTime', mapped[0]), set(it.id as string, 'endTime', mapped[1]));
    }
    assert.equal((await a.commit({ ops, intent: { kind: 'ripple', maps: { t1: chain } }, wait: 5000 })).status, 'confirmed');
  };
  // Inserting a gap at the start changes no content and has a lossless delete inverse.
  await ripple(rippleInsert(0, 5));
  assert.equal((await b.pendingChanges()).changes[0]!.edited, true);
  await b.head();
  const row = (await store.range<any>('pending', { prefix: [b.cut] }))[0]!.value;
  assert.equal(row.edited, true);
  return { w, store, a, b, sync, original, ripple };
}

test('R6-14 edited returns to false when a later inverse rebase restores the committed ops, without restart', async () => {
  const { w, a, b, store, original, ripple } = await setup();
  try {
    await ripple(rippleDelete(0, 5));
    const current = (await b.pendingChanges()).changes[0]!;
    await b.head();
    const row = (await store.range<any>('pending', { prefix: [b.cut] }))[0]!.value;
    assert.deepEqual(row.ops, original);
    assert.equal(current.edited, false);
    assert.equal(row.edited, false);
  } finally { await b.close(); await a.close(); w.host.close(); }
});

test('R6-14 edited returns to false when a later inverse rebase restores the committed ops, with restart', async () => {
  const { w, a, b, store, sync, original, ripple } = await setup();
  let restarted: Carton | undefined;
  try {
    await b.close();
    restarted = await Carton.open({ adapter, store, actor: bob, sync });
    assert.equal((await restarted.pendingChanges()).changes[0]!.edited, true);
    await ripple(rippleDelete(0, 5));
    const current = (await restarted.pendingChanges()).changes[0]!;
    await restarted.head();
    const row = (await store.range<any>('pending', { prefix: [restarted.cut] }))[0]!.value;
    assert.deepEqual(row.ops, original, 'current ops are exactly the committed ops again');
    assert.deepEqual({ reported: current.edited, stored: row.edited }, { reported: false, stored: false },
      'restart must not change the answer for identical current and committed ops');
  } finally { await restarted?.close(); await b.close(); await a.close(); w.host.close(); }
});

test('R6-14 restoring onto a newer head that restores committed ops must clear edited', async () => {
  const { w, a, b, store, sync, original, ripple } = await setup();
  let restarted: Carton | undefined;
  try {
    await b.close();
    await ripple(rippleDelete(0, 5));
    restarted = await Carton.open({ adapter, store, actor: bob, sync });
    const current = (await restarted.pendingChanges()).changes[0]!;
    assert.deepEqual(current.after.items, ((await a.head()).doc.items as Rec[]).map((it) =>
      it.id === 'f' ? { ...it, startTime: 26, endTime: 31 } : it));
    assert.equal(current.edited, false, 'restoreAll rebases stored ops back to their original values');
  } finally { await restarted?.close(); await b.close(); await a.close(); w.host.close(); }
});

test('edited remains true when a fence rebuilds the same handle queue from its stored row', async () => {
  const { w, a, b, store } = await setup(true);
  try {
    const stopped = new Promise<void>(r => b.on(e => { if (e.type === 'sync' && e.status === 'stopped') r(); }));
    // The queued row has edited=true. A settlement under a lost lease discards the in-memory queue.
    await store.write([{ table: 'lease', key: ['review-holder'], value: 'new' }]);
    await b.sync!.connect({ nonce: 'old', conditions: [{ table: 'lease', key: ['review-holder'], expect: { equals: 'old' } }] });
    await stopped;
    const current = (await b.pendingChanges()).changes[0]!;
    assert.ok(current, 'the pending row is restored after the fence');
    assert.equal(current.edited, true);
    assert.equal((await store.range<any>('pending', { prefix: [b.cut] }))[0]!.value.edited, true);
  } finally { await b.close(); await a.close(); w.host.close(); }
});

// Rows stored before the digest (cardboard-adapter 893976c kept only the boolean): their committed ops are unknown.
// One that says `edited` stays edited until it settles; one that doesn't takes its stored ops as the committed ones.
test('R6-14 a row from before the digest: edited stays as it said, a row without it takes its ops as committed', async () => {
  const { w, a, b, store, sync, ripple } = await setup();
  let restarted: Carton | undefined;
  try {
    await b.close();
    const [row] = await store.range<any>('pending', { prefix: [b.cut] });
    assert.ok(row!.value.committed, 'the row keeps the committed ops digest');
    const { committed: _, ...legacy } = row!.value;
    await store.write([{ table: 'pending', key: row!.key, value: legacy }]);
    restarted = await Carton.open({ adapter, store, actor: bob, sync });
    assert.equal((await restarted.pendingChanges()).changes[0]!.edited, true, 'said edited: stays');
    await ripple(rippleDelete(0, 5));
    await restarted.head();
    assert.equal((await restarted.pendingChanges()).changes[0]!.edited, true, 'its committed ops are unknown: still edited');
    await restarted.close();
    const [now] = await store.range<any>('pending', { prefix: [b.cut] });
    assert.equal(now!.value.committed, undefined, 'no digest is made up for it');
    const { edited: __, ...older } = now!.value;
    await store.write([{ table: 'pending', key: now!.key, value: older }]);
    restarted = await Carton.open({ adapter, store, actor: bob, sync });
    assert.equal((await restarted.pendingChanges()).changes[0]!.edited, false, 'no flag: its stored ops are the committed ones');
  } finally { await restarted?.close(); await b.close(); await a.close(); w.host.close(); }
});
