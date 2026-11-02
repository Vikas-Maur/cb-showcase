// Regressions from Stage F review round 6.5 (GPT 6.1 Sol, high) over de7bf7a, on the reviewer's repros.
// R6-15: a refresh that loads rows and then fails reading people: the next refresh reads them again and tells the
// events those rows made ready, though it loads no row itself. The other tests here are the reviewer's probes of the
// R6-10/R6-11 event delivery (they passed before; kept as regression guards).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Carton, type Actor, type Store } from '@carton/core';
import type { Transport } from '@carton/core/plugins';
import { createMemoryStore } from '../src/index.ts';
import { adapter, doc0, set } from './fixture.ts';
import { copyStore, until, world } from './world.ts';
const alice: Actor = { kind: 'human', id: 'alice' };
const bob: Actor = { kind: 'human', id: 'bob' };

/**
 * Bob, offline with edits to a and b, falls behind Alice's six confirmed renames (a keyframe catch-up), then connects.
 * `history`: 'defer' holds his history request (and what he sends after it) until `release`; 'deny' answers it with an
 * error. Each absorbed or late-conflict notice event is recorded with the credit for its clip asked at the event.
 */
async function behind(history: 'defer' | 'deny', wrap: (store: Store) => Store = s => s, before?: (a: Carton) => Promise<void>) {
  const w = world({ maxBehind: 2, keyframeEvery: 2 });
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, actor: alice, sync: w.sync('alice') });
  await a.share();
  await until(async () => (await a.cuts())[0]!.sequencer.kind === 'server');
  await before?.(a);
  const sb: Store = await copyStore(sa);
  let asked = 0, holding = history === 'defer', denyHistory = history === 'deny';
  const deferred: (() => void)[] = [];
  const transport: Transport = { connect: async (...args) => {
    const c = await w.host.transport.connect(...args);
    return {
      get open() { return c.open; },
      onMessage: l => c.onMessage(m => {
        if (denyHistory && m.type === 'history') l({ ...m, rows: [], more: false, error: 'history unavailable' });
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
  const b = await Carton.open({ adapter, store: wrap(sb), actor: bob, keyframeEvery: 2, sync: { ...w.sync('bob'), transport } });
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
  return { w, a, b, sb, ids, seen, release, done, allowHistory: () => { denyHistory = false; } };
}
const whats = (seen: { what: string }[], kind: string) => seen.filter((x) => x.what.startsWith(kind)).map((x) => x.what);
const told = (ids: string[]) => ({ absorbed: ids.map((id) => `absorbed:${id}`), notices: ids.map((id) => `notice:${id}`) });


test('R6-15 ready events survive a transient people reload failure after refresh loaded the rows', async () => {
  let fail = false;
  const wrap = (raw: Store): Store => ({ ...raw, range: async (table, opts) => {
    if (fail && table === 'meta' && opts?.prefix?.[0] === 'person') {
      fail = false;
      throw new Error('injected people read failure');
    }
    return raw.range(table, opts);
  }});
  const { w, b, sb, ids, seen, done } = await behind('defer', wrap);
  let peer: Carton | undefined;
  try {
    peer = await Carton.open({ adapter, store: sb, actor: bob, sync: w.sync('bob') });
    await until(async () => (await sb.range('changes', { prefix: [b.cut] })).length >= 6);
    assert.equal(seen.length, 0);
    fail = true;
    await assert.rejects(b.head(), /injected people read failure/);
    assert.equal(fail, false, 'failure was in the requested read');
    // Retry the public read. Rows are already loaded, so the people/drain block is skipped.
    await b.head();
    assert.equal((await b.credits(['items', 'a']))?.id, 'alice', 'History now contains the missing rows');
    await new Promise<void>(r => setImmediate(r));
    assert.deepEqual({ absorbed: whats(seen, 'absorbed:'), notices: whats(seen, 'notice:') }, told(ids),
      'ready events must not require a new row to arrive');
  } finally { fail = false; await done(peer); }
});

test('R6-15 an all-cut refresh that loads one cut and fails reading the next: the next refresh tells the ready events', async () => {
  let other = '', fail = false, loadedFirst = 0;
  const wrap = (raw: Store): Store => ({ ...raw, range: async <T,>(table: string, opts?: Parameters<Store['range']>[1]) => {
    if (fail && table === 'changes' && opts?.prefix?.[0] === other) {
      fail = false;
      throw new Error('injected read failure on the next cut');
    }
    const r = await raw.range<T>(table, opts);
    if (fail && table === 'changes' && opts?.prefix?.[0] !== other && opts?.gt) loadedFirst += r.length;
    return r;
  }});
  const { w, b, sb, ids, seen, done } = await behind('defer', wrap, async (a) => { other = (await a.fork('local variant')).id; });
  let peer: Carton | undefined;
  try {
    const order = (await b.cuts()).map((c) => c.id);
    assert.deepEqual(order, [b.cut, other], 'the shared cut is read first, the local variant after it');
    peer = await Carton.open({ adapter, store: sb, actor: bob, sync: w.sync('bob') });
    await until(async () => (await sb.range('changes', { prefix: [b.cut] })).length >= 6);
    assert.equal(seen.length, 0);
    fail = true;
    await assert.rejects(b.cuts(), /injected read failure on the next cut/);
    assert.ok(loadedFirst > 0, 'the failing refresh had loaded the shared cut\'s rows');
    // the rows are in History now: this refresh loads none
    await b.cuts();
    await new Promise<void>(r => setImmediate(r));
    assert.deepEqual({ absorbed: whats(seen, 'absorbed:'), notices: whats(seen, 'notice:') }, told(ids));
    assert.equal((await b.credits(['items', 'a']))?.id, 'alice');
  } finally { fail = false; await done(peer); }
});

test('failed fetch fallback events are not repeated when a later fetch succeeds', async () => {
  const { a, b, ids, seen, allowHistory, done } = await behind('deny');
  try {
    await until(() => seen.length === 4);
    allowHistory();
    assert.equal((await a.commit({ ops: [set('f', 'name', 'later')], wait: 5000 })).status, 'confirmed');
    await until(async () => (await b.log()).some(v => v.author?.id === 'alice'));
    await b.head();
    assert.deepEqual(whats(seen, 'absorbed:'), told(ids).absorbed);
    assert.deepEqual(whats(seen, 'notice:'), told(ids).notices);
    assert.equal((await b.credits(['items', 'a']))?.id, 'alice');
    await b.close();
    assert.equal(seen.length, 4);
  } finally { await done(); }
});

test('an unanswered fetch keeps events waiting through reads and releases them on disconnect', async () => {
  const { b, ids, seen, done } = await behind('defer');
  try {
    await b.head(); await b.log(); await b.cuts();
    assert.equal(seen.length, 0);
    await b.sync!.disconnect();
    await b.head();
    assert.deepEqual(whats(seen, 'absorbed:'), told(ids).absorbed);
    assert.deepEqual(whats(seen, 'notice:'), told(ids).notices);
    await b.close();
    assert.equal(seen.length, 4);
  } finally { await done(); }
});

test('a rebuild drain waits for an active settle to publish change events, including a concurrent close', async () => {
  let block = false;
  let arrived!: () => void, resume!: () => void;
  const entered = new Promise<void>(r => arrived = r);
  const gate = new Promise<void>(r => resume = r);
  const wrap = (raw: Store): Store => ({ ...raw, write: async (writes, conditions) => {
    if (block && writes.some(x => x.table === 'keyframes')) {
      arrived(); await gate;
    }
    return raw.write(writes, conditions);
  }});
  const { w, a, b, sb, ids, seen, release, done } = await behind('defer', wrap);
  let peer: Carton | undefined;
  const order: string[] = [];
  b.on(e => {
    if (e.type === 'change') order.push('change');
    if (e.type === 'absorbed') order.push('absorbed');
    if (e.type === 'notice' && e.notice.kind === 'late-conflict') order.push('notice');
  });
  try {
    // Force the backfill to make periodic keyframes in a separate awaited write after History.load.
    block = true;
    release();
    await entered;
    peer = await Carton.open({ adapter, store: sb, actor: bob, sync: w.sync('bob', false) });
    const fork = await peer.fork('force rebuild while publication is blocked');
    assert.ok((await b.cuts()).some(c => c.id === fork.id));
    await new Promise<void>(r => setImmediate(r));
    assert.equal(seen.length, 0, 'rebuild loaded ready rows but must not overtake change publication');
    const closing = b.close();
    block = false; resume();
    await closing;
    assert.deepEqual(whats(seen, 'absorbed:'), told(ids).absorbed);
    assert.deepEqual(whats(seen, 'notice:'), told(ids).notices);
    assert.ok(order.indexOf('notice') > order.lastIndexOf('change'));
    assert.ok(order.indexOf('absorbed') > order.lastIndexOf('change'));
  } finally { block = false; resume(); await done(peer); }
});

test('waiting deliveries on different cuts drain independently and close tells the remaining cut once', async () => {
  const w = world({ maxBehind: 2, keyframeEvery: 2 });
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, actor: alice, sync: w.sync('alice') });
  let b: Carton | undefined;
  let hold = false;
  const replies = new Map<string, (() => void)[]>();
  const transport: Transport = { connect: async (...args) => {
    const c = await w.host.transport.connect(...args);
    return { get open() { return c.open; },
      onMessage: l => c.onMessage(m => {
        if (hold && m.type === 'history') {
          const list = replies.get(m.branchId) ?? [];
          list.push(() => l(m)); replies.set(m.branchId, list);
        } else l(m);
      }),
      onClose: l => c.onClose(l), close: () => c.close(), send: m => c.send(m),
    };
  }};
  try {
    const main = a.cut;
    await a.share(main);
    await until(async () => (await a.cuts()).find(c => c.id === main)?.sequencer.kind === 'server');
    const fork = await a.fork('shared variant');
    await a.share(fork.id);
    await until(async () => (await a.cuts()).find(c => c.id === fork.id)?.sequencer.kind === 'server');
    const cuts = [main, fork.id];
    const sb = await copyStore(sa);
    b = await Carton.open({ adapter, store: sb, actor: bob, sync: { ...w.sync('bob'), transport } });
    await until(() => cuts.every(c => b!.sync!.state(c).status === 'up-to-date'));
    await b.sync!.disconnect();
    const ids = new Map<string, string>();
    for (const cut of cuts) {
      const r = await b.commit({ cut, ops: [set('a', 'name', 'mine')] });
      assert.equal(r.status, 'pending'); if (r.status === 'pending') ids.set(cut, r.id);
      for (const key of ['a', 'b', 'c', 'd', 'e', 'f'])
        assert.equal((await a.commit({ cut, ops: [set(key, 'name', 'theirs')], wait: 5000 })).status, 'confirmed');
      await until(() => w.host.sequencer.tables.latestKeyframe(cut, 6)?.seq === 6);
    }
    const seen: { cut: string; id: string; type: string }[] = [];
    b.on(e => {
      if (e.type === 'absorbed') seen.push({ cut: e.branchId, id: e.id, type: e.type });
      if (e.type === 'notice' && e.notice.kind === 'late-conflict') seen.push({ cut: e.notice.cut!, id: e.notice.change!, type: e.type });
    });
    hold = true;
    await b.sync!.connect();
    await until(() => cuts.every(c => replies.has(c)));
    await b.head();
    assert.equal(seen.length, 0);
    for (const answer of replies.get(main)!) answer();
    replies.delete(main);
    await until(() => seen.some(e => e.cut === main));
    assert.deepEqual(seen.map(e => [e.cut, e.id, e.type]), [[main, ids.get(main), 'notice'], [main, ids.get(main), 'absorbed']]);
    await b.cuts();
    await b.close();
    assert.deepEqual(seen.filter(e => e.cut === fork.id).map(e => [e.id, e.type]), [[ids.get(fork.id), 'notice'], [ids.get(fork.id), 'absorbed']]);
    hold = false;
    for (const list of replies.values()) for (const answer of list) answer();
    await new Promise<void>(r => setImmediate(r));
    assert.equal(seen.length, 4);
  } finally {
    hold = false;
    for (const list of replies.values()) for (const answer of list) answer();
    await b?.close(); await a.close(); w.host.close();
  }
});
