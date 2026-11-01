// Stage F review round 4 (GPT 6.1 Sol): the reviewer's reproductions of SF4-1..8, which assert the correct behaviour
// (they failed at fb7f4e9), kept as written apart from imports; the source is
// /home/ubuntu/gfv-scratch/carton/foundation-core-review/f4-review.test.ts. Names map to findings:
// SF4-6 "shallow frozen input records…"; SF4-4 "shared stale-base edit after a confirmed split…"; SF4-2 "restart
// successor retains…"; SF4-8 "a trailing presence update…"; SF4-1 "a row whose pending dependency is held…"; SF4-5 "a
// stale edit across successive splits…"; SF4-7 "a returning holder prunes…"; SF4-3 "retrying an id whose row is
// held…"; and the reviewer's control "a held row is retried after the backfill…". Then the owner's additions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Carton } from '@carton/core';
import { ReplicaQueue } from '../../core/src/sync/queue.ts';
import { createMemoryStore } from '../src/index.ts';
import { adapter, doc0, item, set, schema, clip } from './fixture.ts';
import { world, until, copyStore } from './world.ts';
const author={kind:'human' as const,id:'alice'};

test('shallow frozen input records must have their nested objects frozen too',async()=>{
 const c=await Carton.open({adapter,store:createMemoryStore(),init:{doc:doc0()}});
 try{
  const style={nested:{color:'red'}};
  const record=Object.freeze({...clip('g',30,35),style});
  await c.commit({ops:[{op:'insert',path:['items','g'],value:record}]});
  const h=await c.head();
  assert.throws(()=>{(item(h.doc,'g')!.style as any).nested.color='blue'},TypeError);
 }finally{await c.close()}
});

test('shared stale-base edit after a confirmed split must reach both pieces',async()=>{
 const w=world(),store=createMemoryStore();
 const c=await Carton.open({adapter,store,init:{doc:doc0()},sync:w.sync('alice')});
 try{
  await c.share();await until(async()=>(await c.cuts())[0].sequencer.kind==='server');
  const base=`${c.cut}@0`;
  const r=await c.commit({ops:[set('c','endTime',12.5),set('c','trimEnd',2.5),{op:'insert',path:['items','c-b'],value:{...clip('c-b',12.5,15),trimStart:2.5,trimEnd:5,name:'c'}}],intent:{kind:'split',lineage:{c:['c','c-b']}},wait:1000});
  assert.equal(r.status,'confirmed');
  const color=await c.commit({base,ops:[set('c','color','red')],wait:1000});
  assert.equal(color.status,'confirmed');
  const d=(await c.head()).doc;
  assert.deepEqual([item(d,'c')!.color,item(d,'c-b')!.color],['red','red']);
 }finally{await c.close();w.host.close()}
});

test('restart successor retains the authored version of its confirmed dependency',async()=>{
 const w=world(),store=createMemoryStore();let h:any,n:any,b:any,next:any;
 try{
  h=await Carton.open({adapter,store,init:{doc:doc0()},sync:w.sync('alice',false)});
  await h.share();await h.sync.connect({nonce:'h'});await h.sync.disconnect();
  const p=await h.commit({ops:[set('a','endTime',4),set('a','trimEnd',4)]});
  n=await Carton.open({adapter,store,sync:w.sync('alice',false)});
  const r=await n.commit({ops:[set('a','endTime',3),set('a','trimEnd',3)]});
  // Bob only moves the clip; Alice's pending rows remain on Alice's machine.
  const bs=await copyStore(store);await bs.write((await bs.range<any>('pending')).map(x=>({table:'pending',key:x.key,value:undefined})));
  b=await Carton.open({adapter,store:bs,sync:w.sync('bob')});
  await until(()=>b.sync.status==='up-to-date');
  assert.equal((await b.commit({ops:[set('a','startTime',2),set('a','endTime',7)],wait:1000})).status,'confirmed');
  await h.sync.connect({nonce:'h2'});assert.equal((await h.sync.waitFor(p.id,1000)).status,'confirmed');
  const restartedStore=await copyStore(store);
  const before=item((await n.head()).doc,'a')!;
  console.log('live successor',before.startTime,before.endTime,before.trimEnd);
  await n.close();n=null;await h.close();h=null;
  next=await Carton.open({adapter,store:restartedStore,sync:w.sync('alice',false)});
  const after=item((await next.head()).doc,'a')!;
  assert.deepEqual([after.startTime,after.endTime,after.trimEnd],[before.startTime,before.endTime,before.trimEnd]);
 }finally{await h?.close();await n?.close();await b?.close();await next?.close();w.host.close()}
});

test('a held row is retried after the backfill makes its base rebuildable',async()=>{
 const w=world({maxBehind:2,keyframeEvery:2}),store=createMemoryStore();let a:any,b:any,n:any,next:any;let block=false;
 const transport={async connect(url:any,o:any){const c=await w.host.transport.connect(url,o);return {get open(){return c.open},send(m:any){if(block&&(m.type==='history'||m.type==='push'))return;c.send(m)},onMessage:c.onMessage,onClose:c.onClose,close:c.close}}};
 try{
  a=await Carton.open({adapter,store,init:{doc:doc0()},sync:{...w.sync('alice',false),transport}});await a.share();await a.sync.connect({nonce:'a'});await a.sync.disconnect();
  b=await Carton.open({adapter,store:await copyStore(store),sync:w.sync('bob')});await until(()=>b.sync.status==='up-to-date');
  for(let i=0;i<6;i++)await b.commit({ops:[set('b','name',`remote${i}`)],wait:1000});
  await until(()=>w.host.sequencer.tables.latestKeyframe(a.cut,6)?.seq===6);
  block=true;await a.sync.connect({nonce:'a2'});await until(async()=>!!await store.get('meta',['queue-head',a.cut,6]));
  n=await Carton.open({adapter,store,sync:w.sync('alice',false)});
  const r=await n.commit({ops:[set('a','color','red')]});
  for(let i=0;i<2;i++)await b.commit({ops:[set('b','name',`new${i}`)],wait:1000});
  await until(async()=>!!await store.get('meta',['queue-head',a.cut,8]));
  const snapshot=await copyStore(store);
  // Model an older saved store from before per-seq retention, whose row's base isn't available at open.
  await snapshot.write([{table:'meta',key:['queue-head',a.cut,6],value:undefined}]);
  await a.close();a=null;await n.close();n=null;
  next=await Carton.open({adapter,store:snapshot,sync:w.sync('alice')});
  await until(async()=>(await snapshot.range('changes',{prefix:[next.cut]})).length>=8);
  assert.equal((await next.sync.waitFor(r.id,100)).status,'confirmed');
 }finally{await a?.close();await b?.close();await n?.close();await next?.close();w.host.close()}
});

import { SyncClient } from '../../core/src/sync/client.ts';
function virtualTime(){
 let now=0,id=0;const due:any[]=[];
 const timers={setTimeout(fn:()=>void,ms:number){const n=++id;due.push({at:now+ms,fn,id:n});return n},clearTimeout(n:any){const i=due.findIndex(x=>x.id===n);if(i>=0)due.splice(i,1)}};
 return {clock:()=>now,timers,advance(ms:number){const end=now+ms;for(;;){due.sort((a,b)=>a.at-b.at);if(!due.length||due[0].at>end)break;const t=due.shift();now=t.at;t.fn()}now=end}};
}
class Conn {
 open=true;sent:any[]=[];msgs:any[]=[];closes:any[]=[];
 send(m:any){if(this.open)this.sent.push(structuredClone(m))}onMessage(f:any){this.msgs.push(f)}onClose(f:any){this.closes.push(f)}close(){this.open=false}feed(m:any){for(const f of this.msgs)f(m)}drop(){this.open=false;for(const f of this.closes)f('network down')}
}
const tick=()=>new Promise(r=>setTimeout(r,0));
test('a trailing presence update survives a disconnect before its timer',async()=>{
 const vt=virtualTime(),q=new ReplicaQueue(schema),conns:Conn[]=[];
 q.addBranch({id:'b',name:'b',kind:'main',sequencer:{kind:'server',since:0}},doc0());
 const client=new SyncClient({queue:q,branchId:'b',schemaVersion:1,connect:async()=>{const c=new Conn();conns.push(c);return c},clock:vt.clock,timers:vt.timers,defer:f=>queueMicrotask(f)}).start();
 try{
  await tick();conns[0].feed({type:'hello',branchId:'b',head:0,rows:[],confirmed:[]});
  client.sendPresence(author,{at:0});vt.advance(10);client.sendPresence(author,{at:1});
  conns[0].drop();vt.advance(100);vt.advance(500);await tick();
  conns[1].feed({type:'hello',branchId:'b',head:0,rows:[],confirmed:[]});vt.advance(500);
  assert.ok(conns[1].sent.some(m=>m.type==='presence'&&m.state?.at===1));
 }finally{client.stop()}
});

test('a row whose pending dependency is held must wait too, rather than lose the edit',()=>{
 const q=new ReplicaQueue(schema);q.addBranch({id:'b',name:'b',kind:'main',sequencer:{kind:'server',since:0}},doc0());
 const top=doc0();q.jumpTo('b',{seq:8,doc:top,stateHash:HashDoc(top,schema)});
 const input=(id:string,head:number,ops:any[],basePending:string[])=>({id,author,at:0,ops,head,basePending,k:0,supersedes:[],cards:[],sentBases:[]});
 const r=q.restoreAll('b',[
  input('alice.1',6,[{op:'insert',path:['items','g'],value:clip('g',30,35)}],[]),
  input('alice.2',8,[set('g','color','red')],['alice.1'])
 ]);
 const successor=q.pending('b').find(p=>p.id==='alice.2');
 if(successor&&q.isEmpty(successor))q.absorbLocally('b',successor);
 q.restoreAll('b',r.held,()=>doc0());
 assert.equal(item(q.optimistic('b').doc,'g')?.color,'red');
});
import {hashDoc as HashDoc} from '../../core/src/engine/index.ts';

test('a stale edit across successive splits follows every surviving piece',async()=>{
 const c=await Carton.open({adapter,store:createMemoryStore(),init:{doc:doc0()}});
 try{
  const base=`${c.cut}@0`;
  assert.equal((await c.commit({ops:[set('c','endTime',12.5),set('c','trimEnd',2.5),{op:'insert',path:['items','c-b'],value:{...clip('c-b',12.5,15),trimStart:2.5,trimEnd:5,name:'c'}}],intent:{kind:'split',lineage:{c:['c','c-b']}}})).status,'confirmed');
  assert.equal((await c.commit({ops:[set('c','endTime',11),set('c','trimEnd',1),{op:'insert',path:['items','c-c'],value:{...clip('c-c',11,12.5),trimStart:1,trimEnd:2.5,name:'c'}}],intent:{kind:'split',lineage:{c:['c','c-c']}}})).status,'confirmed');
  assert.equal((await c.commit({base,ops:[set('c','color','red')]})).status,'confirmed');
  const d=(await c.head()).doc;
  assert.deepEqual(['c','c-b','c-c'].map(id=>item(d,id)!.color),['red','red','red']);
 }finally{await c.close()}
});

test('a returning holder prunes catch-up snapshots created by an intervening holder',async()=>{
 const w=world({maxBehind:2,keyframeEvery:2}),store=createMemoryStore();let a:any,b:any,n:any;let blockA=false;
 const wrap=(blocked:()=>boolean)=>({async connect(url:any,o:any){const c=await w.host.transport.connect(url,o);return {get open(){return c.open},send(m:any){if(blocked()&&m.type==='history')return;c.send(m)},onMessage:c.onMessage,onClose:c.onClose,close:c.close}}});
 try{
  a=await Carton.open({adapter,store,init:{doc:doc0()},sync:{...w.sync('alice',false),transport:wrap(()=>blockA)}});await a.share();await a.sync.connect({nonce:'a'});await a.sync.disconnect();
  b=await Carton.open({adapter,store:await copyStore(store),sync:w.sync('bob')});await until(()=>b.sync.status==='up-to-date');
  for(let i=0;i<6;i++)await b.commit({ops:[set('b','name',`remote${i}`)],wait:1000});
  await until(()=>w.host.sequencer.tables.latestKeyframe(a.cut,6)?.seq===6);
  blockA=true;await a.sync.connect({nonce:'a2'});await until(async()=>!!await store.get('meta',['queue-head',a.cut,6]));await a.sync.disconnect();
  n=await Carton.open({adapter,store,sync:{...w.sync('alice',false),transport:wrap(()=>true)}});await n.sync.connect({nonce:'n'});
  await b.commit({ops:[set('b','name','remote7')],wait:1000});await until(async()=>!!await store.get('meta',['queue-head',a.cut,7]));
  await n.close();n=null;
  await b.commit({ops:[set('b','name','remote8')],wait:1000});
  blockA=false;await a.sync.connect({nonce:'a3'});
  await until(async()=>(await store.range('changes',{prefix:[a.cut]})).length===8);
  await a.head();
  assert.equal(await store.get('meta',['queue-head',a.cut,7]),undefined);
 }finally{await a?.close();await b?.close();await n?.close();w.host.close()}
});

test('retrying an id whose row is held preserves that row and its causal base',async()=>{
 const w=world({maxBehind:2,keyframeEvery:2}),store=createMemoryStore();let a:any,b:any,n:any,next:any;let block=false;
 const transport={async connect(url:any,o:any){const c=await w.host.transport.connect(url,o);return {get open(){return c.open},send(m:any){if(block&&(m.type==='history'||m.type==='push'))return;c.send(m)},onMessage:c.onMessage,onClose:c.onClose,close:c.close}}};
 try{
  a=await Carton.open({adapter,store,init:{doc:doc0()},sync:{...w.sync('alice',false),transport}});await a.share();await a.sync.connect({nonce:'a'});await a.sync.disconnect();
  b=await Carton.open({adapter,store:await copyStore(store),sync:w.sync('bob')});await until(()=>b.sync.status==='up-to-date');
  for(let i=0;i<6;i++)await b.commit({ops:[set('b','name',`remote${i}`)],wait:1000});
  await until(()=>w.host.sequencer.tables.latestKeyframe(a.cut,6)?.seq===6);
  block=true;await a.sync.connect({nonce:'a2'});await until(async()=>!!await store.get('meta',['queue-head',a.cut,6]));
  n=await Carton.open({adapter,store,sync:w.sync('alice',false)});
  const r=await n.commit({ops:[set('a','endTime',4),set('a','trimEnd',4)]});
  for(let i=0;i<2;i++)await b.commit({ops:[set('a','startTime',1+i),set('a','endTime',6+i)],wait:1000});
  await until(async()=>!!await store.get('meta',['queue-head',a.cut,8]));
  const snapshot=await copyStore(store);
  // Model an older saved store from before per-seq retention, whose row's base isn't available at open.
  await snapshot.write([{table:'meta',key:['queue-head',a.cut,6],value:undefined}]);
  await a.close();a=null;await n.close();n=null;
  next=await Carton.open({adapter,store:snapshot,sync:w.sync('alice',false)});
  assert.equal((await snapshot.get<any>('pending',[next.cut,r.id])).head,6);
  const retry=await next.commit({id:r.id,ops:[set('a','endTime',4),set('a','trimEnd',4)]});
  assert.equal(retry.status,'pending');
  assert.equal((await snapshot.get<any>('pending',[next.cut,r.id])).head,6);
  const applied=item((await next.head()).doc,'a')!;
  assert.deepEqual([applied.startTime,applied.endTime,applied.trimEnd],[2,7,5]);
 }finally{await a?.close();await b?.close();await n?.close();await next?.close();w.host.close()}
});

// SF4-5, the owner's: a piece made by a split split again, and the original split twice, both reach every piece; the
// queue's rebase (a shared cut) composes lineage the same way
test('SF4-5: an edit made before two splits reaches every piece, whichever piece was split again (local and shared)', async () => {
 const split=(from:string,at:number,piece:string,end:number)=>({ops:[set(from,'endTime',at),{op:'insert' as const,path:['items',piece],value:{...clip(piece,at,end),name:'c'}}],intent:{kind:'split',lineage:{[from]:[from,piece]}}});
 const c=await Carton.open({adapter,store:createMemoryStore(),init:{doc:doc0()}});
 try{
  const base=`${c.cut}@0`;
  assert.equal((await c.commit(split('c',12.5,'c-b',15) as never)).status,'confirmed');
  assert.equal((await c.commit(split('c-b',13.5,'c-d',15) as never)).status,'confirmed');
  assert.equal((await c.commit({base,ops:[set('c','color','red')]})).status,'confirmed');
  const d=(await c.head()).doc;
  assert.deepEqual(['c','c-b','c-d'].map(id=>item(d,id)!.color),['red','red','red']);
 }finally{await c.close()}
 const w=world(),store=createMemoryStore();
 const s=await Carton.open({adapter,store,init:{doc:doc0()},sync:w.sync('alice')});
 try{
  await s.share();await until(async()=>(await s.cuts())[0].sequencer.kind==='server');
  const base=`${s.cut}@0`;
  assert.equal((await s.commit({...split('c',12.5,'c-b',15),wait:1000} as never)).status,'confirmed');
  assert.equal((await s.commit({...split('c',11,'c-c',12.5),wait:1000} as never)).status,'confirmed');
  assert.equal((await s.commit({base,ops:[set('c','color','red')],wait:1000})).status,'confirmed');
  const d=(await s.head()).doc;
  assert.deepEqual(['c','c-b','c-c'].map(id=>item(d,id)!.color),['red','red','red']);
 }finally{await s.close();w.host.close()}
});

// SF4-2, the owner's: a row on a pending change stores its base exactly; a row on none stores nothing extra
test('SF4-2: a pending row made on another pending change keeps its base as ops; one on the confirmed head keeps none', async () => {
 const w=world(),store=createMemoryStore();
 const h=await Carton.open({adapter,store,init:{doc:doc0()},sync:w.sync('alice',false)});
 try{
  await h.share();await h.sync!.connect({nonce:'h'});await h.sync!.disconnect();
  const p1=await h.commit({ops:[set('a','name','one')]});
  const p2=await h.commit({ops:[set('b','name','two')]});
  const r1=await store.get<any>('pending',[h.cut,p1.status==='pending'?p1.id:'']);
  const r2=await store.get<any>('pending',[h.cut,p2.status==='pending'?p2.id:'']);
  assert.equal(r1.baseDelta,undefined);
  assert.deepEqual(r2.basePending,[r1.id]);
  assert.deepEqual(r2.baseDelta,[{op:'set',path:['items','a','name'],value:'one'}]);
 }finally{await h.close();w.host.close()}
});
