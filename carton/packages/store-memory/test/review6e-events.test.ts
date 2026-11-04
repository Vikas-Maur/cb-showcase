// Regressions from Stage F review round 6.5 (GPT 6.1 Sol, high) over de7bf7a, on the reviewer's repros.
// R6-13: a history fetch that fails while a settle is still storing its batch: that batch's events are told once it is
// stored, on what History holds (not held until close).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Carton, type Actor, type Store } from '@carton/core';
import type { Transport } from '@carton/core/plugins';
import { createMemoryStore } from '../src/index.ts';
import { adapter, doc0, set } from './fixture.ts';
import { copyStore, until, world } from './world.ts';
const alice: Actor = { kind: 'human', id: 'alice' };
const bob: Actor = { kind: 'human', id: 'bob' };
const latch = () => { let release!: () => void; return { p: new Promise<void>(r => release = r), release: () => release() }; };
const tick = () => new Promise<void>(r => setImmediate(r));

test('R6-13 failed history fetch before the first outcome is stored still releases that outcome', async () => {
  const w = world({ maxBehind: 2, keyframeEvery: 2 });
  const sa = createMemoryStore();
  const a = await Carton.open({ adapter, store: sa, init: { doc: doc0() }, actor: alice, sync: w.sync('alice') });
  let b: Carton | undefined;
  const entered = latch(), resume = latch();
  let hold = false;
  let deny: (() => void) | undefined;
  let asked = 0;
  try {
    await a.share();
    await until(async () => (await a.cuts())[0]!.sequencer.kind === 'server');
    const raw = await copyStore(sa);
    const store: Store = { ...raw, write: async (writes, conditions) => {
      if (hold && writes.some(x => x.table === 'notices')) { entered.release(); await resume.p; }
      return raw.write(writes, conditions);
    }};
    const transport: Transport = { connect: async (...args) => {
      const c = await w.host.transport.connect(...args);
      return {
        get open() { return c.open; },
        onMessage: l => c.onMessage(m => {
          if (m.type === 'history') deny = () => l({ ...m, rows: [], more: false, error: 'history unavailable' });
          else l(m);
        }),
        onClose: l => c.onClose(l), close: () => c.close(),
        send: m => { if (m.type === 'history') asked++; c.send(m); },
      };
    }};
    b = await Carton.open({ adapter, store, actor: bob, sync: { ...w.sync('bob'), transport } });
    await until(() => b!.sync!.status === 'up-to-date');
    await b.sync!.disconnect();
    const ids: string[] = [];
    for (const key of ['a', 'b']) {
      const r = await b.commit({ ops: [set(key, 'name', "bob's")] });
      assert.equal(r.status, 'pending'); if (r.status === 'pending') ids.push(r.id);
    }
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f'])
      assert.equal((await a.commit({ ops: [set(key, 'name', "alice's")], wait: 5000 })).status, 'confirmed');
    await until(() => w.host.sequencer.tables.latestKeyframe(a.cut, 6)?.seq === 6);
    const seen: string[] = [];
    b.on(e => {
      if (e.type === 'absorbed') seen.push(`absorbed:${e.id}`);
      if (e.type === 'notice' && e.notice.kind === 'late-conflict') seen.push(`notice:${e.notice.change}`);
    });
    hold = true;
    await b.sync!.connect();
    await entered.p;
    await until(() => !!deny);
    assert.equal(seen.length, 0);
    // All queue events from the welcome are already scheduled, but the first durable outcome is still blocked.
    deny!();
    await tick(); await tick();
    assert.equal(asked, 1, 'no later sync event has retried history');
    hold = false; resume.release();
    await b.head();
    assert.equal(await b.pendingCount(), 0, 'outcomes have been stored');
    assert.equal((await b.notices()).length, ids.length, 'notices are durable');
    await tick();
    assert.deepEqual({ absorbed: seen.filter(x => x.startsWith('absorbed:')), notices: seen.filter(x => x.startsWith('notice:')) },
      { absorbed: ids.map(id => `absorbed:${id}`), notices: ids.map(id => `notice:${id}`) },
      'failed-fetch fallback must include outcomes whose settlement was already running');
  } finally {
    hold = false; resume.release(); await b?.close(); await a.close(); w.host.close();
  }
});
