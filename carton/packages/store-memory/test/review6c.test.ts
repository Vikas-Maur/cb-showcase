// Regressions from Stage F review round 6, third pass (GPT 6.1 Sol, high) over 11ea33d; the reviewer's repros and
// probes, kept. R6-8: `absorbed` (and a settle's notices) told only once History holds the rows behind them, after a
// settle that couldn't store and across a keyframe catch-up. R6-9: an empty commit's waits are told only what the store
// kept (its spent id, or the change that won the id).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Carton, type Actor, type Store, type ConfirmedChange } from '@carton/core';
import type { Transport } from '@carton/core/plugins';
import { ReplicaQueue } from '../../core/src/sync/index.ts';
import { createMemoryStore } from '../src/index.ts';
import { adapter, doc0, schema, set } from './fixture.ts';
import { copyStore, until, world } from './world.ts';
const alice: Actor = { kind: 'human', id: 'alice' };
const bob: Actor = { kind: 'human', id: 'bob' };
const latch = () => {
  let release!: () => void;
  return { p: new Promise<void>(r => release = r), release: () => release() };
};

test('R6-8 an absorbed handler reads confirmed credits after storage recovers', async () => {
  const w = world();
  const raw = createMemoryStore();
  const a = await Carton.open({ adapter, store: raw, init: { doc: doc0() }, actor: alice, sync: w.sync('alice') });
  let b: Carton | undefined;
  let fail = false;
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === 'server');
    const other = await copyStore(raw);
    const store: Store = { ...other, write: async (writes, conditions) => {
      if (fail && writes.some(x => x.table === 'changes' || x.table === 'notices'))
        throw new Error('injected settling failure');
      return other.write(writes, conditions);
    }};
    b = await Carton.open({ adapter, store, actor: bob, sync: w.sync('bob') });
    await until(() => b!.sync!.status === 'up-to-date');
    await b.sync!.disconnect();
    const pending = await b.commit({ ops: [set('a', 'name', "bob's")] });
    assert.equal(pending.status, 'pending');
    assert.equal((await a.commit({ ops: [set('a', 'name', "alice's")], wait: 5000 })).status, 'confirmed');
    const events: { credit: Promise<Actor | null>; changesSeen: boolean }[] = [];
    const notices: Promise<Actor | null>[] = [];
    let changed = false;
    b.on(e => {
      if (e.type === 'change') changed = true;
      if (e.type === 'absorbed') events.push({ credit: b!.credits(['items', 'a']), changesSeen: changed });
      // the late conflict's notice waits the same way (its cards name the other side too)
      if (e.type === 'notice' && e.notice.kind === 'late-conflict') notices.push(b!.credits(['items', 'a']));
    });
    fail = true;
    await b.sync!.connect();
    // Drain all settles already queued. Failure is deterministic and persists until after event-time reads finish.
    await b.head();
    const premature = events.length > 0;
    const prematureCredit = events[0] && await events[0].credit;
    const prematureNotices = notices.length;
    fail = false;
    await b.sync!.waitFor(pending.status === 'pending' ? pending.id : '', 5000);
    await b.head();
    assert.ok(events.length > 0, 'event delivered after successful retry');
    assert.equal(premature, false, `absorbed fired while History had no confirmed credit: ${JSON.stringify(prematureCredit)}`);
    assert.ok(events[0]!.changesSeen, 'change event precedes absorbed');
    assert.equal((await events[0]!.credit)?.id, 'alice');
    assert.equal(prematureNotices, 0, 'no late-conflict notice event while the batch could not be stored');
    assert.deepEqual((await Promise.all(notices)).map(x => x?.id), ['alice']);
  } finally {
    fail = false; await b?.close(); await a.close(); w.host.close();
  }
});

test('R6-8 a keyframe catch-up must load skipped rows before delivering back-to-back absorptions', async () => {
  const w = world({ maxBehind: 2, keyframeEvery: 2 });
  const raw = createMemoryStore();
  const a = await Carton.open({ adapter, store: raw, init: { doc: doc0() }, actor: alice, sync: w.sync('alice') });
  let b: Carton | undefined;
  let delayHistory = true;
  const deferred: (() => void)[] = [];
  const transport: Transport = { connect: async (...args) => {
    const c = await w.host.transport.connect(...args);
    return {
      get open() { return c.open; },
      onMessage: l => c.onMessage(l), onClose: l => c.onClose(l), close: () => c.close(),
      send: m => {
        // Preserve send order while the history request and all later messages wait in the transport.
        if (delayHistory && (m.type === 'history' || deferred.length)) deferred.push(() => c.send(m));
        else c.send(m);
      },
    };
  }};
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === 'server');
    b = await Carton.open({ adapter, store: await copyStore(raw), actor: bob, sync: { ...w.sync('bob'), transport } });
    await until(() => b!.sync!.status === 'up-to-date');
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
    const events: { id: string; credit: Promise<Actor | null> }[] = [];
    const notices: { id: string; credit: Promise<Actor | null> }[] = [];
    b.on(e => {
      if (e.type === 'absorbed') events.push({ id: e.id, credit: b!.credits(['items', e.id === ids[0] ? 'a' : 'b']) });
      // the late conflicts' notices wait for the skipped rows too
      if (e.type === 'notice' && e.notice.kind === 'late-conflict') notices.push({ id: e.notice.change!, credit: b!.credits(['items', e.notice.change === ids[0] ? 'a' : 'b']) });
    });
    await b.sync!.connect();
    await b.head();
    assert.ok(deferred.length, 'real catch-up requested the skipped rows');
    const premature = events.length > 0;
    const credits = await Promise.all(events.map(e => e.credit));
    const prematureNotices = notices.length;
    delayHistory = false;
    for (const resume of deferred.splice(0)) resume();
    await until(async () => (await b!.log()).some(v => v.author?.id === 'alice'));
    await b.head();
    assert.deepEqual(events.map(e => e.id), ids, 'each absorption delivered in queue order, without replay');
    assert.equal(premature, false, `absorbed was emitted before backfill, with credits ${JSON.stringify(credits)}`);
    assert.deepEqual((await Promise.all(events.map(e => e.credit))).map(a => a?.id), ['alice', 'alice']);
    assert.equal(prematureNotices, 0, 'no late-conflict notice event before the backfill');
    assert.deepEqual(notices.map(n => n.id), ids);
    assert.deepEqual((await Promise.all(notices.map(n => n.credit))).map(a => a?.id), ['alice', 'alice']);
  } finally {
    delayHistory = false;
    for (const resume of deferred.splice(0)) resume();
    await b?.close(); await a.close(); w.host.close();
  }
});

test('R6-9 a confirmed competing winner replaces the empty attempt outcome', async () => {
  const w = world();
  const raw = createMemoryStore();
  let armed = false, release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(r => entered = r);
  const resume = new Promise<void>(r => release = r);
  const store: Store = { ...raw, write: async (writes, conditions) => {
    if (armed && writes.some(x => x.table === 'meta' && x.key[0] === 'noop')) {
      armed = false; entered(); await resume;
    }
    return raw.write(writes, conditions);
  }};
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: w.sync('alice') });
  let b: Carton | undefined;
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === 'server');
    await a.sync!.disconnect();
    b = await Carton.open({ adapter, store: raw, sync: w.sync('alice') });
    await until(() => b!.sync!.status === 'up-to-date');
    const id = a.newChangeId();
    armed = true;
    const empty = a.commit({ id, ops: [] });
    await blocked;
    const winner = await b.commit({ id, ops: [set('a', 'name', 'confirmed winner')], wait: 5000 });
    assert.equal(winner.status, 'confirmed');
    release();
    const result = await empty;
    assert.equal(result.status, 'confirmed');
    assert.equal(result.status === 'confirmed' && result.seq, winner.status === 'confirmed' && winner.seq);
    const outcome = await a.sync!.waitFor(id, 1);
    assert.equal(outcome.status, 'confirmed');
    assert.equal(outcome.status === 'confirmed' && outcome.seq, winner.status === 'confirmed' && winner.seq,
      'waitFor must report the stored winning edit, not the losing provisional empty confirmation');
  } finally {
    release(); await a.close(); await b?.close(); w.host.close();
  }
});

test('R6-9 a wait cannot confirm a provisional empty attempt before the store accepts it', async () => {
  const w = world();
  const raw = createMemoryStore();
  let armed = false, release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(r => entered = r);
  const resume = new Promise<void>(r => release = r);
  const store: Store = { ...raw, write: async (writes, conditions) => {
    if (armed && writes.some(x => x.table === 'meta' && x.key[0] === 'noop')) {
      armed = false; entered(); await resume;
      throw new Error('injected rejected no-op write');
    }
    return raw.write(writes, conditions);
  }};
  const a = await Carton.open({ adapter, store, init: { doc: doc0() }, sync: w.sync('alice') });
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === 'server');
    await a.sync!.disconnect();
    const id = a.newChangeId();
    armed = true;
    const empty = assert.rejects(a.commit({ id, ops: [] }), /injected rejected no-op write/);
    await blocked;
    const premature = await a.sync!.waitFor(id, 1);
    assert.equal(await raw.get('meta', ['noop', id]), undefined);
    release();
    await empty;
    const retry = await a.commit({ id, ops: [set('a', 'name', 'still pending')] });
    assert.equal(retry.status, 'pending');
    assert.equal(premature.status, 'pending', 'a wait cannot confirm an attempt whose transaction has not landed');
  } finally {
    release(); await a.close(); w.host.close();
  }
});

test('back-to-back absorbed events survive rebuild and close while their settle is pending', async () => {
  const w = world();
  const raw = createMemoryStore();
  const a = await Carton.open({ adapter, store: raw, init: { doc: doc0() }, actor: alice, sync: w.sync('alice') });
  let b: Carton | undefined, peer: Carton | undefined;
  const arrived = latch(), resume = latch();
  let hold = false;
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === 'server');
    const other = await copyStore(raw);
    const store: Store = { ...other, write: async (writes, conditions) => {
      if (hold && writes.some(x => x.table === 'notices')) {
        hold = false; arrived.release(); await resume.p;
      }
      return other.write(writes, conditions);
    }};
    b = await Carton.open({ adapter, store, actor: bob, sync: w.sync('bob') });
    await until(() => b!.sync!.status === 'up-to-date');
    await b.sync!.disconnect();
    const ids: string[] = [];
    for (const key of ['a', 'b']) {
      const r = await b.commit({ ops: [set(key, 'name', "bob's")] });
      assert.equal(r.status, 'pending');
      if (r.status === 'pending') ids.push(r.id);
    }
    assert.equal((await a.commit({ ops: [set('a', 'name', "alice's"), set('b', 'name', "alice's")], wait: 5000 })).status, 'confirmed');
    const events: string[] = [];
    const credits: Promise<Actor | null>[] = [];
    b.on(e => {
      if (e.type === 'change') events.push('change');
      if (e.type === 'absorbed') {
        events.push(e.id);
        credits.push(b!.credits(['items', e.id === ids[0] ? 'a' : 'b']));
      }
    });
    hold = true;
    await b.sync!.connect();
    await arrived.p;
    peer = await Carton.open({ adapter, store: other });
    await peer.fork('forces rebuild');
    assert.ok((await b.cuts()).some(c => c.name === 'forces rebuild'));
    const closing = b.close();
    resume.release();
    await closing;
    assert.deepEqual(events.filter(x => x !== 'change'), ids, 'the absorbed events arrive in order before listeners clear');
    assert.ok(events.indexOf('change') >= 0 && events.indexOf('change') < events.indexOf(ids[0]!));
    assert.deepEqual((await Promise.all(credits)).map(x => x?.id), ['alice', 'alice']);
  } finally {
    resume.release(); await peer?.close(); await b?.close(); await a.close(); w.host.close();
  }
});

test('queue version counters remain consistent through rebaseAll, restoreAll, rejectLocally and absorb', () => {
  const branch = { id: 'cut', name: 'main', kind: 'main' as const, sequencer: { kind: 'server' as const, since: 0 } };
  const q = new ReplicaQueue(schema);
  q.addBranch(branch, doc0());
  q.commit('cut', { id: 'r.1', author: bob, ops: [set('a', 'name', 'mine')], at: 0 });
  const latest = (queue: ReplicaQueue) => queue.pending('cut')[0]!.versions.at(-1)!;
  const initial = latest(q).k;
  q.rebaseAll('cut');
  assert.equal(latest(q).k, initial + 1);
  const p = q.pending('cut')[0]!, v = latest(q);
  const stored = {
    id: p.id, author: p.author, ops: v.ops, at: p.created,
    head: v.base.seq, basePending: v.base.pending,
    intent: v.intent, kinds: v.kinds, policy: v.policy,
    k: v.k, supersedes: v.supersedes, cards: [], sentBases: [0],
  };
  const restored = new ReplicaQueue(schema);
  restored.addBranch(branch, doc0());
  restored.restoreAll('cut', [stored]);
  const newer = new ReplicaQueue(schema);
  const row: ConfirmedChange = { id: 'remote.1', hash: 'unused', author: alice, branchId: 'cut',
    base: { seq: 0, pending: [] }, ops: [set('b', 'name', 'remote')], intent: null, kinds: null, policy: 'merge',
    at: 0, paths: [], reads: [], spans: [], trackOrder: [], rebase: 0, seq: 1 };
  newer.addBranch(branch, doc0(), [row]);
  newer.restoreAll('cut', [stored]);
  assert.equal(latest(newer).k, v.k + 1, 'a restore onto a newer head adds a rebase to the stored count');
  assert.equal(latest(restored).k, v.k, 'an exact restore preserves the stored version counter');
  const old = latest(restored).k;
  restored.rejectLocally('cut', p.id, 'too large');
  assert.equal(latest(restored).k, old + 2, 'the synthetic empty version and the subsequent rebase advance the counter');
  assert.equal(latest(restored).ops.length, 0);
  const rejection: string[] = [];
  restored.on(e => { if (e.type === 'rejected') rejection.push(e.change.id); });
  restored.finishAbsorb('cut', restored.pending('cut')[0]!, true);
  assert.deepEqual(restored.pending('cut'), []);
  assert.deepEqual(rejection, [p.id]);
});

test('R6-8 events waiting for skipped rows are told, once, when the lease moves on before the backfill', async () => {
  const w = world({ maxBehind: 2, keyframeEvery: 2 });
  const raw = createMemoryStore();
  const a = await Carton.open({ adapter, store: raw, init: { doc: doc0() }, actor: alice, sync: w.sync('alice') });
  let b: Carton | undefined;
  let delayHistory = true;
  const deferred: (() => void)[] = [];
  const transport: Transport = { connect: async (...args) => {
    const c = await w.host.transport.connect(...args);
    return {
      get open() { return c.open; },
      onMessage: l => c.onMessage(l), onClose: l => c.onClose(l), close: () => c.close(),
      send: m => {
        if (delayHistory && (m.type === 'history' || deferred.length)) deferred.push(() => c.send(m));
        else c.send(m);
      },
    };
  }};
  const holder = (nonce: string) => ({ table: 'lease', key: ['holder'], expect: { equals: { nonce } } }) as const;
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === 'server');
    const store = await copyStore(raw);
    await store.write([{ table: 'lease', key: ['holder'], value: { nonce: 'old' } }]);
    b = await Carton.open({ adapter, store, actor: bob, sync: { ...w.sync('bob', false), transport } });
    assert.ok(await b.sync!.connect({ nonce: 'old', fence: () => true, conditions: [holder('old')] }));
    await until(() => b!.sync!.status === 'up-to-date');
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
    const seen: string[] = [];
    b.on(e => {
      if (e.type === 'absorbed') seen.push(e.id);
      if (e.type === 'sync' && e.status === 'stopped') seen.push('stopped');
    });
    assert.ok(await b.sync!.connect({ nonce: 'old', fence: () => true, conditions: [holder('old')] }));
    await b.head();
    assert.ok(deferred.length, 'real catch-up requested the skipped rows');
    assert.equal(seen.length, 0, 'nothing told before the skipped rows are in');
    // another holder takes the lease: the backfill's settle can't store, and this handle stops
    await store.write([{ table: 'lease', key: ['holder'], value: { nonce: 'new' } }]);
    delayHistory = false;
    for (const resume of deferred.splice(0)) resume();
    await until(() => seen.includes('stopped'), 5000, 'the replaced holder to stop');
    await b.head();
    assert.deepEqual(seen.filter(x => x !== 'stopped'), ids, 'each absorption told once, in order');
    assert.equal(seen.indexOf('stopped'), ids.length, 'before the stop');
  } finally {
    delayHistory = false;
    for (const resume of deferred.splice(0)) resume();
    await b?.close(); await a.close(); w.host.close();
  }
});
