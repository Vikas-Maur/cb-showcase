// @ts-nocheck: the reviewer's cases as it wrote them (plain literals for ops and intents)
// Review of feat/ux2-n0b (GPT 6.1 Sol, one round): its edge cases, each a test (ripple straddlers, pending and
// ancestor history, the timing before deletion, the newest insertion, previews matching restore, touching clips,
// pending retries, the expect check on a shared cut, undo).
import test from 'node:test';
import assert from 'node:assert/strict';
import {open, adapter, doc0, set, clip, at} from './bring-back-edge.helpers.ts';
import {Carton} from '../src/index.ts';
import {createMemoryStore} from '../../store-memory/src/index.ts';
const del = {ops:[{op:'remove',path:['items','b']},set('c','startTime',5),set('c','endTime',10)],intent:{kind:'ripple-delete',maps:{t1:[{d:[[5,10]],i:[]}]}}};
const ins = {ops:[{op:'insert',path:['items','d'],value:clip('d',5,8)},set('b','startTime',8),set('b','endTime',13),set('c','startTime',13),set('c','endTime',18)],intent:{kind:'ripple-insert',maps:{t1:[{d:[],i:[[5,3]]}]}}};
const shared = async()=>{const c=await Carton.open({adapter,store:createMemoryStore(),init:{doc:doc0()},actor:{kind:'human',id:'me'},sync:{autoConnect:false,url:'ws://unused',token:'x',transport:{connect:async()=>{throw Error('unexpected connection')}}}});return c};

test('overlap shorter than EPS still needs a new track',async()=>{
 const c=await open();try{
 await c.commit({ops:[{op:'remove',path:['items','b']}]});
 await c.commit({ops:[set('c','startTime',9.98),set('c','endTime',14.98)]});
 const r=await c.restoreClip(`${c.cut}@0`,'items/b');
 console.log('short overlap',r.brought,at((await c.head()).doc));
 assert.equal(r.brought.place?.placed,'new-track');
 }finally{await c.close()}
});

test('a pending ripple deletion still opens its gap when brought back',async()=>{
 const c=await shared();try{await c.share();await c.commit(del);
 const choice=(await c.bringBackChoices(`${c.cut}@0`)).deleted[0];
 const r=await c.restoreClip(`${c.cut}@0`,'items/b',{expect:choice.token});
 console.log('pending ripple',choice,r.brought,at((await c.head()).doc));
 assert.equal(r.brought.ripple?.direction,'later');
 assert.deepEqual(at((await c.head()).doc).c,['t1',10,15]);
 }finally{await c.close()}
});

test('retry of a pending restore keeps the ripple result',async()=>{
 const c=await shared();try{await c.commit(del);await c.share();
 const first=await c.restoreClip(`${c.cut}@0`,'items/b',{id:'review.1'});
 const retry=await c.restoreClip(`${c.cut}@0`,'items/b',{id:'review.1'});
 console.log('pending retry',first.brought,retry.brought);
 assert.deepEqual(retry.brought,first.brought);
 }finally{await c.close()}
});

test('the most recent addition defines ripple, not an earlier lifetime',async()=>{
 const c=await open();try{
 await c.commit({ops:[{op:'insert',path:['items','d'],value:clip('d',20,23)}]});
 await c.commit({ops:[{op:'remove',path:['items','d']}]});
 await c.commit(ins);
 const r=await c.restoreClip(`${c.cut}@0`,'items/d',{remove:true});
 console.log('readded',r.brought,at((await c.head()).doc));
 assert.equal(r.brought.ripple?.direction,'earlier');
 assert.deepEqual(at((await c.head()).doc).b,['t1',5,10]);
 }finally{await c.close()}
});

test('a fork after a ripple delete preserves its deletion history',async()=>{
 const c=await open();try{const old=`${c.cut}@0`;await c.commit(del);
 const fork=await c.fork('Other');await c.switchTo(fork.id);
 const r=await c.restoreClip(old,'items/b');
 console.log('fork history',r.brought,at((await c.head()).doc));
 assert.equal(r.brought.ripple?.direction,'later');
 }finally{await c.close()}
});

test('taking out a ripple insert does not create overlaps with a straddling clip',async()=>{
 const c=await open();try{
 await c.commit(ins);
 await c.commit({ops:[{op:'insert',path:['items','x'],value:clip('x',4,7)}]});
 const before=at((await c.head()).doc);
 const r=await c.restoreClip(`${c.cut}@0`,'items/d',{remove:true});
 const after=at((await c.head()).doc);
 console.log('straddler',before,r.brought,after);
 // X and B were disjoint before; after B moves on top of X.
 assert.ok(after.x[2]<=after.b[1] || after.b[2]<=after.x[1]);
 await c.undo();
 assert.deepEqual(at((await c.head()).doc),before);
 }finally{await c.close()}
});

test('expect checks pending edits on shared cut',async()=>{
 const c=await shared();try{await c.share();await c.commit({ops:[set('b','name','B1')]});
 const choice=(await c.bringBackChoices(`${c.cut}@0`)).changed.find(x=>x.record==='items/b');
 await c.commit({ops:[set('b','name','B2')]});
 await assert.rejects(c.restoreClip(`${c.cut}@0`,'items/b',{expect:choice.token}),e=>e.code==='CHANGED_SINCE');
 }finally{await c.close()}
});

test('cross-cut preview matches restore ripple',async()=>{
 const c=await open();try{
 const source=await c.fork('Saved before');
 await c.commit(del);
 const choice=(await c.bringBackChoices(`${source.id}@0`)).deleted.find(x=>x.record==='items/b');
 const restored=await c.restoreClip(`${source.id}@0`,'items/b',{expect:choice.token});
 console.log('cross-cut preview',choice,restored.brought);
 assert.deepEqual(choice.ripple,restored.brought.ripple);
 assert.equal(choice.place?.placed,restored.brought.place?.placed);
 }finally{await c.close()}
});

test('undo a ripple removal leaves unrelated content inside its gap untouched',async()=>{
 const c=await open();try{
 await c.commit(ins);
 await c.commit({ops:[{op:'insert',path:['items','x'],value:clip('x',6,7)}]});
 const before=at((await c.head()).doc);
 await c.restoreClip(`${c.cut}@0`,'items/d',{remove:true});
 const undone=await c.undo();
 console.log('undo with gap content',before,undone.status,at((await c.head()).doc));
 assert.deepEqual(at((await c.head()).doc),before);
 }finally{await c.close()}
});

test('a clip trimmed before its ripple deletion still brings back the deleting ripple',async()=>{
 const c=await open();try{
 await c.commit({ops:[set('b','endTime',8),set('b','trimEnd',3)]});
 await c.commit({ops:[{op:'remove',path:['items','b']},set('c','startTime',7),set('c','endTime',12)],intent:{kind:'ripple-delete',maps:{t1:[{d:[[5,8]],i:[]}]}}});
 const r=await c.restoreClip(`${c.cut}@0`,'items/b');
 console.log('trimmed before delete',r.brought,at((await c.head()).doc));
 assert.equal(r.brought.ripple?.direction,'later');
 assert.deepEqual(at((await c.head()).doc).c,['t1',10,15]);
 }finally{await c.close()}
});
