// Regressions from Stage F review round 6, fourth pass (GPT 6.1 Sol, high) over 6acb526, on the reviewer's repros.
// R6-10: events waiting for a keyframe catch-up's skipped rows are told once a refresh or a rebuild loads those rows.
// R6-11: when the rows can't be fetched, or the handle closes first, they are told on what History holds, once.
// R6-12: `edited` compares ops: a rebase that only re-expresses a remap intent edits nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Carton, rippleDelete, type Actor, type Store } from '@carton/core';
import type { Transport } from '@carton/core/plugins';
import { createMemoryStore } from '../src/index.ts';
import { adapter, doc0, set } from './fixture.ts';
import { copyStore, until, world } from './world.ts';
const alice: Actor = { kind: 'human', id: 'alice' };
const bob: Actor = { kind: 'human', id: 'bob' };
const agent: Actor = { kind: 'agent', id: 'agent' };

/**
 * Bob, offline with edits to a and b, falls behind Alice's six confirmed renames (a keyframe catch-up), then connects.
 * `history`: 'defer' holds his history request (and what he sends after it) until `release`; 'deny' answers it with an
 * error. Each absorbed or late-conflict notice event is recorded with the credit for its clip asked at the event.
 */
async function behind(history: 'defer' | 'deny') {
  const w = world({ maxBehind: 2, keyframeEvery: 2 });
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, actor: alice, sync: w.sync('alice') });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === 'server');
  const sb: Store = await copyStore(sa);
  let asked = 0, holding = history === 'defer';
  const deferred: (() => void)[] = [];
  const transport: Transport = { connect: async (...args) => {
    const c = await w.host.transport.connect(...args);
    return {
      get open() { return c.open; },
      onMessage: l => c.onMessage(m => {
        if (history === 'deny' && m.type === 'history') l({ ...m, rows: [], more: false, error: 'history unavailable' });
        else l(m);
      }),
      onClose: l => c.onClose(l), close: () => c.close(),
      send: m => {
        if (m.type === 'history') asked++;
        if (holding && (m.type === 'history' || deferred.length)) deferred.push(() => c.send(m));
        else c.send(m);
      },
    };
  }};
  const b = await Carton.open({ adapter, store: sb, actor: bob, sync: { ...w.sync('bob'), transport } });
  await until(() => b.sync!.status === 'up-to-date');
  await b.sync!.disconnect();
  const ids: string[] = [];
  for (const key of ['a', 'b']) {
    const r = await b.commit({ ops: [set(key, 'name', "bob's")] });
    assert.equal(r.status, 'pending');
    if (r.status === 'pending') ids.push(r.id);
  }
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f'])
    assert.equal((await a.commit({ ops: [set(key, 'name', "alice's")], wait: 5000 })).status, 'confirmed');
  await until(() => w.host.sequencer.tables.latestKeyframe(a.cut, 6)?.seq === 6);
  const seen: { what: string; credit: Promise<Actor | null> }[] = [];
  const clip = (id: string | undefined) => (id === ids[0] ? 'a' : 'b');
  b.on(e => {
    if (e.type === 'absorbed') seen.push({ what: `absorbed:${e.id}`, credit: b.credits(['items', clip(e.id)]) });
    if (e.type === 'notice' && e.notice.kind === 'late-conflict') seen.push({ what: `notice:${e.notice.change}`, credit: b.credits(['items', clip(e.notice.change)]) });
  });
  await b.sync!.connect();
  await until(() => asked > 0, 5000, 'the history request');
  await b.head();
  assert.equal(await b.pendingCount(), 0, 'both absorbed and stored');
  const release = () => {
    holding = false;
    for (const r of deferred.splice(0)) r();
  };
  const done = async (...more: (Carton | undefined)[]) => {
    release();
    for (const x of [...more, b, a]) await x?.close();
    w.host.close();
  };
  return { w, a, b, sb, ids, seen, release, done };
}
const whats = (seen: { what: string }[], kind: string) => seen.filter((x) => x.what.startsWith(kind)).map((x) => x.what);
const told = (ids: string[]) => ({ absorbed: ids.map((id) => `absorbed:${id}`), notices: ids.map((id) => `notice:${id}`) });

test('R6-10 events waiting for skipped rows are told once a refresh loads the rows another handle saved', async () => {
  const { w, b, sb, ids, seen, done } = await behind('defer');
  let peer: Carton | undefined;
  try {
    assert.equal(seen.length, 0, 'waiting: his own fetch is under way');
    // another handle on Bob's store fetches the skipped rows and saves them
    peer = await Carton.open({ adapter, store: sb, actor: bob, sync: w.sync('bob') });
    await until(async () => (await sb.range('changes', { prefix: [b.cut] })).length >= 6, 5000, 'the rows saved');
    assert.equal(seen.length, 0, 'nothing told before this handle has the rows');
    await b.head(); // a refresh loads them
    await until(() => seen.length === 4, 5000, 'the events');
    assert.deepEqual(whats(seen, 'absorbed:'), told(ids).absorbed, 'each absorption once, in order');
    assert.deepEqual(whats(seen, 'notice:'), told(ids).notices);
    assert.deepEqual((await Promise.all(seen.map((x) => x.credit))).map((x) => x?.id), ['alice', 'alice', 'alice', 'alice'], "credits at the event name Alice");
  } finally {
    await done(peer);
  }
});

test('R6-10 events waiting for skipped rows are told once a rebuild loads them', async () => {
  const { w, b, sb, ids, seen, done } = await behind('defer');
  let peer: Carton | undefined;
  try {
    peer = await Carton.open({ adapter, store: sb, actor: bob, sync: w.sync('bob') });
    await until(async () => (await sb.range('changes', { prefix: [b.cut] })).length >= 6, 5000, 'the rows saved');
    // a cut this handle doesn't know: its next read rebuilds History from the store (before loading any row itself)
    const fork = await peer.fork('forces a rebuild');
    assert.equal(seen.length, 0);
    assert.ok((await b.cuts()).some((c) => c.id === fork.id));
    await until(() => seen.length === 4, 5000, 'the events');
    assert.deepEqual(whats(seen, 'absorbed:'), told(ids).absorbed);
    assert.deepEqual(whats(seen, 'notice:'), told(ids).notices);
    assert.deepEqual((await Promise.all(seen.map((x) => x.credit))).map((x) => x?.id), ['alice', 'alice', 'alice', 'alice']);
  } finally {
    await done(peer);
  }
});

test("R6-11 a server that can't serve the skipped rows: the events are told once the fetch fails, each once, in order", async () => {
  const { b, ids, seen, done } = await behind('deny');
  try {
    await until(() => seen.length === 4, 5000, 'the events');
    assert.deepEqual(whats(seen, 'absorbed:'), told(ids).absorbed);
    assert.deepEqual(whats(seen, 'notice:'), told(ids).notices);
    // the outcome is final, the notices stored; nothing told again by reads, waits or close
    assert.equal((await b.sync!.waitFor(ids[0]!, 1)).status, 'conflicts');
    assert.equal((await b.notices()).length, ids.length);
    await b.head();
    await b.log();
    await b.close();
    assert.equal(seen.length, 4, 'no event twice');
  } finally {
    await done();
  }
});

test('R6-11 close tells the events still waiting for skipped rows (their fetch under way), once', async () => {
  const { b, ids, seen, done } = await behind('defer');
  try {
    assert.equal(seen.length, 0);
    await b.close();
    assert.deepEqual(whats(seen, 'absorbed:'), told(ids).absorbed, 'told before the listeners go');
    assert.deepEqual(whats(seen, 'notice:'), told(ids).notices);
  } finally {
    await done();
    assert.equal(seen.length, 4, 'and not again when the held request is answered');
  }
});

test('R6-12 edited is false when only a remap intent changes and the ops stay identical', async () => {
  const w = world();
  const store = createMemoryStore();
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, actor: alice, sync: w.sync('alice') });
  let b: Carton | undefined;
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === 'server');
    b = await Carton.open({ adapter, store, actor: agent, sync: w.sync('bob', false) });
    // There are no clips on t2. The timeline can ripple its gap while also changing a title.
    const ops = [set('a', 'name', 'renamed')];
    const intent = { kind: 'ripple-delete', maps: { t2: rippleDelete(5, 5) } };
    const pending = await b.commit({ ops, intent });
    assert.equal(pending.status, 'pending');
    assert.equal((await b.pendingChanges()).changes[0]!.edited, false);
    const before = (await store.range<any>('pending', { prefix: [b.cut] }))[0]!.value;
    assert.equal((await a.commit({ ops: [set('b', 'name', 'remote')], intent: { kind: 'ripple-delete', maps: { t2: rippleDelete(0, 2) } }, wait: 5000 })).status, 'confirmed');
    const entry = (await b.pendingChanges()).changes[0]!;
    // Drain the settle scheduled when pendingChanges fed the remote row into this queue.
    await b.head();
    const after = (await store.range<any>('pending', { prefix: [b.cut] }))[0]!.value;
    assert.deepEqual(after.ops, before.ops, 'rebasing left every operation unchanged');
    assert.notDeepEqual(after.intent, before.intent, 'only the edge-map intent changed');
    assert.equal(entry.rebases, 1);
    assert.equal(entry.edited, false, 'documented ops-only flag must not include intent in its comparison');
    assert.notEqual(after.edited, true, 'nor does its stored row say so');
  } finally { await b?.close(); await a.close(); w.host.close(); }
});
