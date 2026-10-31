// Stage F review round 3 (GPT 6.1 Sol): the reviewer's reproductions of SF3-1..8, which assert the correct behaviour
// (they failed at 29ab749), kept as written apart from imports; the source is
// /home/ubuntu/gfv-scratch/carton/foundation-core-review/f3-review.test.ts. Names map to findings:
// SF3-3 "a successor of a confirmed pending row…"; SF3-2 "different default-named copies…", "default sender
// collision…", "a collided import…"; SF3-1 "an older pending head…"; SF3-4 "a never-sent absorption…"; SF3-7 "an
// expired token…"; SF3-6 "a token whose writes are forbidden…"; SF3-5 "compaction must not turn…"; SF3-8 "a successful
// withdraw ack…"; and a control: "a failed rebuild during fencing…".
import test from 'node:test';
import assert from 'node:assert/strict';
import {Carton} from '@carton/core';
import {createMemoryStore} from '../src/index.ts';
import {adapter, doc0, item, set, schema} from './fixture.ts';
import {world, until, copyStore} from './world.ts';
const actor={kind:'human' as const,id:'alice'};

test('a successor of a confirmed pending row retains its causal base at reopen',async()=>{
 const w=world(), store=createMemoryStore(); let h:any,n:any,next:any;
 try {
  h=await Carton.open({adapter,store,init:{doc:doc0()},sync:w.sync('alice',false)});
  await h.share(); await h.sync!.connect({nonce:'h'}); await h.sync!.disconnect();
  const p=await h.commit({ops:[set('a','name','first')]}); assert.equal(p.status,'pending');
  n=await Carton.open({adapter,store,sync:w.sync('alice',false)});
  assert.equal(item((await n.head()).doc,'a')!.name,'first');
  const r=await n.commit({ops:[set('a','name','second')]}); assert.equal(r.status,'pending');
  await h.sync!.connect({nonce:'h2'}); assert.equal((await h.sync!.waitFor(p.id,1000)).status,'confirmed');
  assert.equal((await store.get<any>('pending',[h.cut,r.id]))?.head,0);
  await n.close(); n=null; await h.close(); h=null;
  next=await Carton.open({adapter,store,sync:w.sync('alice')});
  const outcome=await next.sync!.waitFor(r.id,1000);
  assert.equal(outcome.status,'confirmed',JSON.stringify(outcome));
  assert.equal(item((await next.head()).doc,'a')!.name,'second');
 }finally{await n?.close();await h?.close();await next?.close();w.host.close();}
});

test('different default-named copies do not overwrite the same imported node',async()=>{
 const sa=createMemoryStore(); const a=await Carton.open({adapter,store:sa,init:{doc:doc0()}});
 const b=await Carton.open({adapter,store:await copyStore(sa)}),c=await Carton.open({adapter,store:await copyStore(sa)});
 try{
  await b.commit({ops:[set('b','name','Bob')]});
  await c.commit({ops:[set('c','name','Carol')]});
  const rb=await a.importShallow(await b.exportShallow()); assert.equal(rb.status,'imported');
  const hb=rb.status==='imported'?rb.head:'';
  assert.equal((await a.fold(hb)).status,'confirmed');
  const rc=await a.importShallow(await c.exportShallow()); assert.equal(rc.status,'imported');
  const hc=rc.status==='imported'?rc.head:'';
  assert.notEqual(hb,hc,'distinct divergent senders need distinct nodes');
  assert.equal((await a.fold(hc)).status,'confirmed');
  assert.equal(item((await a.head()).doc,'c')!.name,'Carol');
 }finally{await a.close();await b.close();await c.close();}
});

async function gapCase(){
 const w=world({maxBehind:2,keyframeEvery:2}),sa=createMemoryStore();let block=false;
 const transport={async connect(url:any,o:any){const c=await w.host.transport.connect(url,o);return {get open(){return c.open},send(m:any){if(block&&(m.type==='history'||m.type==='push'))return;c.send(m)},onMessage:c.onMessage,onClose:c.onClose,close:c.close};}};
 const a=await Carton.open({adapter,store:sa,init:{doc:doc0()},sync:{...w.sync('alice',false),transport}});
 await a.share();await a.sync!.connect({nonce:'a'});await a.sync!.disconnect();
 const b=await Carton.open({adapter,store:await copyStore(sa),sync:w.sync('bob')});await until(()=>b.sync!.status==='up-to-date');
 for(let i=0;i<6;i++) await b.commit({ops:[set('b','name',`remote${i}`)],wait:1000});
 await until(()=>w.host.sequencer.tables.latestKeyframe(a.cut,6)?.seq===6);
 block=true;await a.sync!.connect({nonce:'a2'});
 // (the saved catch-up states are keyed by seq since round 3's fix: ["queue-head", cut, seq])
 await until(async()=>(await sa.range('meta',{prefix:['queue-head',a.cut]})).length>0);
 return {w,sa,a,b,transport};
}

test('an older pending head must remain reconstructible when the saved queue head advances',async()=>{
 const {w,sa,a,b,transport}=await gapCase();let n:any,next:any;
 try{
  n=await Carton.open({adapter,store:sa,sync:w.sync('alice',false)});
  const r=await n.commit({ops:[set('a','endTime',4),set('a','trimEnd',4)]});assert.equal(r.status,'pending');
  assert.equal((await sa.get<any>('pending',[a.cut,r.id])).head,6);
  // The holder's catch-up moves again, while the non-holder's row remains on the first saved head.
  for(let i=0;i<2;i++)await b.commit({ops:[set('a','startTime',1+i),set('a','endTime',6+i)],wait:1000});
  await a.sync!.disconnect();await a.sync!.connect({nonce:'a3'});
  await until(async()=>!!(await sa.get<any>('meta',['queue-head',a.cut,8])));
  assert.ok(await sa.get<any>('meta',['queue-head',a.cut,6]),'the state the other process\'s row is made on is kept');
  assert.equal((await sa.get<any>('pending',[a.cut,r.id])).head,6);
  await n.close();n=null;await a.close();
  next=await Carton.open({adapter,store:sa,sync:w.sync('alice')});
  assert.equal((await next.sync!.waitFor(r.id,1000)).status,'confirmed');
  const clip=item((await next.head()).doc,'a')!;
  assert.deepEqual([clip.startTime,clip.endTime,clip.trimEnd],[2,6,4]);
 }finally{await n?.close();await next?.close();await a.close();await b.close();w.host.close();}
});

// Confirm that a hash collision of imported node identities also changes the persisted merge's meaning.
test('default sender collision loses a later fold and rewrites a previous merge parent after reopen',async()=>{
 const sa=createMemoryStore();let a=await Carton.open({adapter,store:sa,init:{doc:doc0()}});
 const b=await Carton.open({adapter,store:await copyStore(sa)}),c=await Carton.open({adapter,store:await copyStore(sa)});
 try{
  await b.commit({ops:[set('b','name','Bob')]});await c.commit({ops:[set('c','name','Carol')]});
  const rb:any=await a.importShallow(await b.exportShallow());await a.fold(rb.head);
  const old=await a.checkout(rb.head);assert.equal(item(old,'b')!.name,'Bob');
  const rc:any=await a.importShallow(await c.exportShallow());const result=await a.fold(rc.head);
  await a.close();a=await Carton.open({adapter,store:sa});
  assert.equal(item(await a.checkout(rb.head),'b')!.name,'Bob','the old merge parent stays immutable');
  assert.equal(item((await a.head()).doc,'c')!.name,'Carol',JSON.stringify(result));
 }finally{await a.close();await b.close();await c.close();}
});

test('a never-sent absorption spends its id across restart',async()=>{
 const w=world(),store=createMemoryStore();let h:any,n:any,next:any,last:any;
 try{
  h=await Carton.open({adapter,store,init:{doc:doc0()},sync:w.sync('alice',false)});await h.share();await h.sync!.connect({nonce:'h'});
  n=await Carton.open({adapter,store,sync:w.sync('alice',false)});
  const r:any=await n.commit({id:'retry.1',ops:[set('a','name','same')]});assert.equal(r.status,'pending');
  await h.commit({ops:[set('a','name','same')],wait:1000});
  await n.close();n=null;await h.close();h=null;
  next=await Carton.open({adapter,store,sync:w.sync('alice')});assert.equal((await next.sync!.waitFor(r.id,1000)).status,'absorbed');
  await next.commit({ops:[set('a','name','later')],wait:1000});
  await next.close();next=null;
  last=await Carton.open({adapter,store,sync:w.sync('alice')});
  const retry=await last.commit({id:r.id,ops:[set('a','name','same')],wait:1000});
  assert.equal(item((await last.head()).doc,'a')!.name,'later',JSON.stringify(retry));
 }finally{await h?.close();await n?.close();await next?.close();await last?.close();w.host.close();}
});

import {createInProcessHost} from '@carton/server';
import {sqliteStorage} from '../../conformance/src/system/sqlite.ts';
function roleWorld(){
 const tokens=new Map<string,any>([['alice',{account:'alice',credential:'alice/install',role:'editor',projectId:'p',expires:Date.now()+3600000}],['viewer',{account:'viewer',credential:'viewer/install',role:'viewer',projectId:'p',expires:Date.now()+3600000}],['expired',{account:'alice',credential:'alice/install',role:'editor',projectId:'p',expires:0}]]);
 const host=createInProcessHost({storage:sqliteStorage(),auth:{kind:'table',verify:async t=>tokens.get(t)??null},timeline:schema.timeline!,groupOf:(c,f)=>schema.collections[c]?.groupOf.get(f)?.name});
 const sync=(token:string,autoConnect=true)=>({transport:host.transport,url:host.url,token,autoConnect});
 return {host,sync,tokens};
}
test('an expired token is classified as unauthorized',async()=>{
 const w=roleWorld(),store=createMemoryStore();let a:any,b:any;
 try{
  a=await Carton.open({adapter,store,init:{doc:doc0()},sync:w.sync('alice')});await a.share();await until(async()=>(await a.cuts())[0].sequencer.kind==='server');
  b=await Carton.open({adapter,store:await copyStore(store),sync:w.sync('expired')});await until(()=>!!b.sync!.error());
  assert.equal(b.sync!.error().code,'unauthorized',JSON.stringify(b.sync!.error()));
 }finally{await a?.close();await b?.close();w.host.close();}
});
test('a token whose writes are forbidden raises a sync error',async()=>{
 const w=roleWorld(),store=createMemoryStore();let a:any,b:any;
 try{
  a=await Carton.open({adapter,store,init:{doc:doc0()},sync:w.sync('alice')});await a.share();await until(async()=>(await a.cuts())[0].sequencer.kind==='server');
  b=await Carton.open({adapter,store:await copyStore(store),sync:w.sync('viewer')});await until(()=>b.sync!.status==='up-to-date');
  const r=await b.commit({ops:[set('a','name','viewer edit')],wait:1000});assert.equal(r.status,'rejected');assert.equal(r.reason,'forbidden');
  assert.equal(b.sync!.error()?.code,'unauthorized');
 }finally{await a?.close();await b?.close();w.host.close();}
});

test('compaction must not turn a copy of our own ancestor into a divergent cut',async()=>{
 let now=1;const sa=createMemoryStore();const a=await Carton.open({adapter,store:sa,init:{doc:doc0()},clock:()=>now,keyframeEvery:2});let b:any;
 try{
  await a.commit({ops:[set('a','name','old')]});b=await Carton.open({adapter,store:await copyStore(sa)});
  await a.commit({ops:[set('a','name','newer')]});await a.commit({ops:[set('b','name','new b')]});await a.commit({ops:[set('c','name','new c')]});
  now=100*864e5;await a.commit({ops:[set('d','name','new d')]});await a.commit({ops:[set('e','name','new e')]});
  await a.compact();assert.equal((await sa.get<any>('changes',[a.cut,1])).squashedInto,4);
  const r:any=await a.importShallow(await b.exportShallow());const folded=await a.fold(r.head);
  assert.equal(folded.status,'up-to-date',JSON.stringify({r,folded}));
 }finally{await a.close();await b?.close();}
});

test('a collided import can persist a fold whose parent names a different document',async()=>{
 const sa=createMemoryStore();let a=await Carton.open({adapter,store:sa,init:{doc:doc0()}});
 const b=await Carton.open({adapter,store:await copyStore(sa)}),c=await Carton.open({adapter,store:await copyStore(sa)});
 try{
  await b.commit({ops:[set('b','name','Bob')]});await c.commit({ops:[set('c','name','Carol')]});
  const rb:any=await a.importShallow(await b.exportShallow());
  const rc:any=await a.importShallow(await c.exportShallow());
  assert.equal(item(await a.checkout(rc.head),'c')!.name,'Carol');
  assert.equal((await a.fold(rc.head)).status,'confirmed');assert.equal(item((await a.head()).doc,'c')!.name,'Carol');
  await a.close();a=await Carton.open({adapter,store:sa});
  assert.equal(item(await a.checkout(rc.head),'c')!.name,'Carol','a folded node must name the same state after reopen');
 }finally{await a.close();await b.close();await c.close();}
});

test('a failed rebuild during fencing still discards the old queue before reconnect',async()=>{
 const w=world(),mem=createMemoryStore();let move=false,failRead=false,failed=false,a:any,b:any;
 const holder=(nonce:string)=>({table:'lease',key:['holder'],expect:{equals:{nonce}}});
 const store=Object.assign(Object.create(mem),{
  write:async(ws:any,cs:any)=>{if(move&&ws.some((x:any)=>x.table==='notices')){move=false;await mem.write([{table:'lease',key:['holder'],value:{nonce:'new'}}]);failRead=true;}return mem.write(ws,cs)},
  range:async(table:any,opts:any)=>{if(failRead&&table==='lineage'){failRead=false;failed=true;throw Error('temporary fenced rebuild read error')}return mem.range(table,opts)}
 });
 try{
  await mem.write([{table:'lease',key:['holder'],value:{nonce:'old'}}]);
  a=await Carton.open({adapter,store,init:{doc:doc0()},sync:w.sync('alice',false)});await a.share();await a.sync!.connect({nonce:'old',fence:()=>true,conditions:[holder('old')]});
  b=await Carton.open({adapter,store:await copyStore(mem),sync:w.sync('bob')});await until(()=>b.sync!.status==='up-to-date');await b.commit({id:'zz.1',ops:[set('b','name','Bob')],wait:1000});await b.close();b=null;
  move=true;const r:any=await a.commit({id:'zz.2',author:{kind:'agent',id:'agent'},ops:[set('c','name','Agent')]});assert.equal(r.status,'pending');
  await until(()=>failed);
  await mem.write([{table:'lease',key:['holder'],value:{nonce:'back'}}]);
  assert.ok(await a.sync!.connect({nonce:'back',conditions:[holder('back')]}));
  await a.sync!.waitFor(r.id,100);
  assert.equal(await mem.get('pending',[a.cut,r.id]),undefined,'the restored queue retries the stored row');
 }finally{await a?.close();await b?.close();w.host.close();}
});

test('a successful withdraw ack clears an earlier sync error',async()=>{
 const sql=sqliteStorage();let fail=false,failPush=false;let a:any,b:any;
 const storage={...sql,exec(sqlText:string,...params:any[]){if(fail){fail=false;throw Error('temporary storage fault')}return sql.exec(sqlText,...params)}} as typeof sql;
 const host=createInProcessHost({storage,auth:{kind:'table',verify:async t=>({account:t,credential:t,role:'editor',projectId:'p',expires:Date.now()+3600000})},timeline:schema.timeline!,groupOf:(c,f)=>schema.collections[c]?.groupOf.get(f)?.name});
 const transport={async connect(url:any,o:any){const c=await host.transport.connect(url,o);return {get open(){return c.open},send(m:any){if(failPush&&m.type==='push'){failPush=false;fail=true;}c.send(m)},onMessage:c.onMessage,onClose:c.onClose,close:c.close}}};
 const store=createMemoryStore();
 try{
  a=await Carton.open({adapter,store,init:{doc:doc0()},sync:{transport,url:host.url,token:'alice'}});await a.share();await until(async()=>(await a.cuts())[0].sequencer.kind==='server');
  b=await Carton.open({adapter,store:await copyStore(store),sync:{transport:host.transport,url:host.url,token:'bob'}});await until(()=>b.sync!.status==='up-to-date');
  failPush=true;const r:any=await a.commit({ops:[set('a','name','same')]});assert.equal(r.status,'pending');await until(()=>!!a.sync!.error());
  assert.match(a.sync!.error().message,/temporary storage fault/);
  await b.commit({ops:[set('a','name','same')],wait:1000});
  assert.equal((await a.sync!.waitFor(r.id,1000)).status,'absorbed');
  await until(()=>a.sync!.status==='up-to-date');assert.ok(host.sequencer.stats.withdraws);
  assert.equal(a.sync!.error(),null,'the acknowledged withdrawal demonstrates recovery on this connection');
 }finally{await a?.close();await b?.close();await host.close();sql.close();}
});
