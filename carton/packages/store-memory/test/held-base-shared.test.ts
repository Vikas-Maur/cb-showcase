// Review of fix/core-deferred (GPT 6.1 Sol, high), finding 1, on the reviewer's repro: a commit on a shared cut whose
// base is held (core's HeldBase: a GUI save merged with someone else's change, held so the person's next quick save
// builds on it; ui-words follow-up `cbfeafd`). The held save's own change is in the base (`causal`): once confirmed,
// it is still not the other side's, so its ripple isn't composed onto the next save again (a clip moved twice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Carton, rippleInsert, type Doc, type Rec } from '@carton/core';
import { createMemoryStore } from '../src/index.ts';
import { adapter, doc0, set, item } from './fixture.ts';
import { world, until } from './world.ts';

for (const confirmFirst of [false, true]) test(`a held GUI ripple is causal to the next save, confirmed=${confirmFirst}`, async () => {
  const w = world();
  const c = await Carton.open({ adapter, store: createMemoryStore(), init: { doc: doc0() }, actor: {kind:'human',id:'person'}, sync: w.sync('alice') });
  try {
    await c.share();
    await until(async () => (await c.cuts())[0]!.sequencer.kind === 'server');
    const base = await c.head();
    const agent = await c.commit({ ops:[set('a','name','agent')], author:{kind:'agent',id:'agent'}, wait:5000 });
    assert.equal(agent.status,'confirmed');
    if (!confirmFirst) await c.sync!.disconnect();
    const mine = structuredClone(base.doc);
    for(const r of mine.items as Rec[]) { r.startTime = (r.startTime as number)+5; r.endTime = (r.endTime as number)+5; }
    const first = await c.commit({ doc:mine, base:base.ref, intent:{kind:'ripple',maps:{t1:rippleInsert(0,5)}}, ...(confirmFirst ? {wait:5000} : {}) });
    assert.equal(first.status,confirmFirst ? 'confirmed' : 'pending');
    const own = first.status === 'confirmed' ? first.change!.id : first.status === 'pending' ? first.id : '';
    assert.ok(own);
    const next = structuredClone(mine);
    item(next,'f')!.startTime = 31; item(next,'f')!.endTime = 36;
    const second = await c.commit({doc:next, base:{baseDoc:mine,baseSeq:base.ref.seq,causal:[own]}, choices:()=>'ours',...(confirmFirst ? {wait:5000} : {})});
    assert.equal(second.status,confirmFirst ? 'confirmed' : 'pending');
    assert.deepEqual(second.resolved ?? [], [], 'the first save must not be merged a second time');
    assert.equal(item((await c.head()).doc,'f')!.startTime,31);
  } finally {await c.close(); w.host.close();}
});
