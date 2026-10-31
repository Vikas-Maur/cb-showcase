// A stream part that a real host removed, or that is gone for any reason, marks its stream bad (windows-sync, 19:00):
// with a host that checks reported damage, the first failed read removes the object, so the range server's retry sees
// "missing", not a mismatch. Through server-node + blob-fs and hosts-plugins' client, as a teammate's tools see it.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createFsBlobStore } from '@carton/blob-fs';
import { hostMediaBlobs } from '@carton/host-http/client';
import { createHmacAuth } from '@carton/server';
import { startNodeHost, type NodeHost } from '@carton/server-node';
import type { BlobStore } from '../src/contracts.ts';
import { damagedKey, mediaKey, streamEndKey } from '../src/keys.ts';
import { nodeHasher } from '../src/node/node-hasher.ts';
import { closeHashWorkers } from '../src/node/hash-file.ts';
import { startRangeServer } from '../src/node/range-server.ts';
import { MediaReader } from '../src/read.ts';
import { claimProxyStream, ProxyStreamReader, ProxyStreamWriter, usableProxy } from '../src/stream.ts';
import { CountingMemoryStore } from '../src/testing.ts';
import { scratchDir } from './helpers.ts';

const SECRET = 'test-only-secret-test-only-secret-0123';
const auth = createHmacAuth({ secret: SECRET });
const src = 'cd'.repeat(32);
const s = scratchDir('host-missing-part');
const hosts: NodeHost[] = [];
after(async () => {
  for (const h of hosts) await h.close();
  closeHashWorkers();
  s.cleanup();
});

async function host(name: string) {
  const blobs = createFsBlobStore({ root: join(s.dir, name, 'blobs'), durable: false });
  const h = await startNodeHost({ dataDir: join(s.dir, name, 'data'), auth, secret: SECRET, blobs, durability: 'normal' });
  hosts.push(h);
  const token = await auth.issue({ account: 'o', credential: 'o/dev', role: 'editor', projectId: 'p', ttlMs: 3600_000 });
  return { blobs, store: hostMediaBlobs({ origin: h.httpUrl, projectId: 'p', token }) as unknown as BlobStore };
}

const fill = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 31 + seed) & 0xff);

/** A finished stream of an init part and three segments, shared as the proxy of `src`. */
async function finishedStream(store: BlobStore) {
  const claim = await claimProxyStream(store, src, 'p1', 'libx264');
  assert.ok(claim.claimed);
  const writer = new ProxyStreamWriter({ store, hasher: nodeHasher, id: (claim.pointer as { stream: string }).stream });
  await writer.init(fill(700, 1));
  const segs = [];
  for (let i = 0; i < 3; i++) segs.push(await writer.segment(fill(5000 + i, 2 + i), 2));
  await writer.end();
  assert.ok(await usableProxy(store, src, 'p1'), 'a sound finished stream is reused');
  return { id: writer.id, segs };
}

/** A teammate's tool following the stream's playlist through the loopback range server: the status of each segment. */
async function toolReads(store: BlobStore, id: string): Promise<number[]> {
  const media = new MediaReader({ store, hasher: nodeHasher, repairAttempts: 1 });
  const reader = new ProxyStreamReader({ store, media, id });
  let ended = 0;
  let allEnded = () => {};
  const server = await startRangeServer({
    // onRequest runs once a request is completely over, its damage report included
    onRequest: () => {
      ended++;
      allEnded();
    },
    source: media.toolSource(),
    playlist: (_id, urlFor) => reader.playlist(urlFor),
    reportDamage: (_stream, hash) => reader.reportPartDamage(hash),
    reportMissing: (_stream, hash) => reader.reportPartDamage(hash, 'missing'),
  });
  try {
    const list = await (await fetch(server.playlistUrl(id))).text();
    const urls = list.split('\n').filter((l) => l.startsWith('http'));
    const statuses = [];
    for (const url of urls) {
      const r = await fetch(url);
      await r.arrayBuffer();
      statuses.push(r.status);
    }
    await new Promise<void>((resolve) => {
      allEnded = () => ended === urls.length + 1 && resolve();
      allEnded();
    });
    return statuses;
  } finally {
    await server.close();
  }
}

/** `byRead`: the tool's read recorded bad/<stream> already; otherwise the reuse check finds the gap and records it. */
async function assertNotReused(store: BlobStore, id: string, byRead = true) {
  if (byRead) assert.ok(await store.head(damagedKey(id)), 'bad/<stream> is recorded by the read');
  assert.equal(await usableProxy(store, src, 'p1'), null, 'the next share does not reuse the stream');
  assert.ok(await store.head(damagedKey(id)), 'bad/<stream> is recorded');
  const next = await claimProxyStream(store, src, 'p1', 'libx264');
  assert.ok(next.claimed, 'the next share makes a new stream');
  assert.notEqual((next.pointer as { stream: string }).stream, id);
}

test('a segment the host found damaged and removed still marks its stream bad, and the next share makes a new one', async () => {
  const { blobs, store } = await host('damaged');
  const { id, segs } = await finishedStream(store);
  // Disk rot on the host: one byte of segment 1 flips, its size stays the same.
  const at = `projects/p/media/${mediaKey(segs[1]!.hash)}`;
  const stored = (await blobs.get(at))!;
  stored[10]! ^= 0xff;
  await blobs.put(at, stored);
  assert.deepEqual(await toolReads(store, id), [200, 502, 200]);
  assert.equal(await store.head(mediaKey(segs[1]!.hash)), null, 'the host checked the damage and removed the object');
  await assertNotReused(store, id);
});

test('a segment that is gone for any reason marks a finished stream bad: through the tool, and in the reuse check alone', async () => {
  {
    const { blobs, store } = await host('gone-read');
    const { id, segs } = await finishedStream(store);
    await blobs.delete(`projects/p/media/${mediaKey(segs[2]!.hash)}`);
    const statuses = await toolReads(store, id);
    assert.notEqual(statuses[2], 200);
    await assertNotReused(store, id);
  }
  {
    // Nobody read it: the reuse check itself HEADs the parts the end entry lists, and records what it found.
    const { blobs, store } = await host('gone-unread');
    const { id, segs } = await finishedStream(store);
    await blobs.delete(`projects/p/media/${mediaKey(segs[0]!.hash)}`);
    await assertNotReused(store, id, false);
  }
});

test('the reuse check finds a gone part of an end written before ends listed their parts, and a part of the wrong size', async () => {
  const store = new CountingMemoryStore();
  const { id, segs } = await finishedStream(store);
  const end = JSON.parse(new TextDecoder().decode(store.objects.get(streamEndKey(id))!));
  delete end.parts;
  store.objects.set(streamEndKey(id), new TextEncoder().encode(JSON.stringify(end)));
  assert.ok(await usableProxy(store, src, 'p1'), 'an old end is still reused while its parts are there');
  store.objects.delete(mediaKey(segs[1]!.hash));
  await assertNotReused(store, id, false);

  const other = new CountingMemoryStore();
  const second = await finishedStream(other);
  other.objects.set(mediaKey(second.segs[0]!.hash), fill(10, 9)); // truncated: present, but not what the end adds up to
  await assertNotReused(other, second.id, false);
});

test('a part reported missing that is there is not reported, and a hash that is not a part never is', async () => {
  const store = new CountingMemoryStore();
  const { id, segs } = await finishedStream(store);
  const reader = new ProxyStreamReader({ store, media: new MediaReader({ store, hasher: nodeHasher }), id });
  assert.equal(await reader.reportPartDamage(segs[0]!.hash, 'missing'), false, 'still there');
  assert.equal(await reader.reportPartDamage('ef'.repeat(32), 'missing'), false, 'not a part');
  assert.equal(store.objects.has(damagedKey(id)), false);
  assert.ok(await usableProxy(store, src, 'p1'));
});

for (const withMissing of [false, true]) {
  const wiring = withMissing ? 'reportDamage and reportMissing' : 'reportDamage only, wired before reportMissing existed';
  test(`a part missing at the read but back before the report doesn't mark the stream (review 1, ${wiring})`, async () => {
    const store = new CountingMemoryStore();
    const { id, segs } = await finishedStream(store);
    const media = new MediaReader({ store, hasher: nodeHasher });
    const reader = new ProxyStreamReader({ store, media, id });
    await reader.known();
    const key = mediaKey(segs[0]!.hash);
    const bytes = store.objects.get(key)!;
    store.objects.delete(key);
    const head = store.head.bind(store);
    let restore = true;
    store.head = async (k) => {
      const r = await head(k);
      if (k === key && restore) {
        restore = false; // another uploader puts it back right after the read's stat
        store.objects.set(key, bytes);
      }
      return r;
    };
    let over!: () => void;
    const ended = new Promise<void>((r) => (over = r));
    let calls = 0;
    const server = await startRangeServer({
      onRequest: () => over(),
      source: media.toolSource(),
      reportDamage: (_stream, hash) => (calls++, reader.reportPartDamage(hash)),
      ...(withMissing ? { reportMissing: (_stream: string, hash: string) => reader.reportPartDamage(hash, 'missing') } : {}),
    });
    try {
      const r = await fetch(`${server.url(segs[0]!.hash)}&s=${id}`);
      await r.arrayBuffer();
      assert.equal(r.status, 404);
      await ended;
    } finally {
      await server.close();
    }
    assert.equal(calls, 0, 'a missing part never goes to reportDamage');
    assert.equal(store.objects.has(damagedKey(id)), false, 'not reported');
    assert.ok(await usableProxy(store, src, 'p1'), 'still reused');
  });
}

test('cancelling playback does not wait for the report of a missing part (review 2)', async () => {
  const store = new CountingMemoryStore();
  const { id } = await finishedStream(store);
  const reader = new ProxyStreamReader({ store, media: new MediaReader({ store, hasher: nodeHasher }), id });
  const init = (await reader.initPart())!;
  const key = mediaKey(init.hash);
  store.objects.delete(key);
  let entered!: () => void;
  const inHead = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const head = store.head.bind(store);
  store.head = async (k) => {
    if (k === key) {
      entered();
      await held; // the confirming HEAD stalls
    }
    return head(k);
  };
  const ac = new AbortController();
  const next = reader.play({ signal: ac.signal }).next();
  await inHead;
  ac.abort();
  try {
    await assert.rejects(
      Promise.race([next, new Promise((_, reject) => setTimeout(() => reject(new Error('still waiting for the report')), 2000))]),
      { name: 'AbortError' },
    );
  } finally {
    release();
  }
});
