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
import { damagedKey, mediaKey, proxyPointerKey, streamEndKey } from '../src/keys.ts';
import { reportDamage } from '../src/damage.ts';
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

async function host(name: string, fetch?: typeof globalThis.fetch) {
  const blobs = createFsBlobStore({ root: join(s.dir, name, 'blobs'), durable: false });
  const h = await startNodeHost({ dataDir: join(s.dir, name, 'data'), auth, secret: SECRET, blobs, durability: 'normal' });
  hosts.push(h);
  const token = await auth.issue({ account: 'o', credential: 'o/dev', role: 'editor', projectId: 'p', ttlMs: 3600_000 });
  return { blobs, store: hostMediaBlobs({ origin: h.httpUrl, projectId: 'p', token, ...(fetch ? { fetch } : {}) }) as unknown as BlobStore };
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

/** Past the time a stream found whole is remembered (VERIFIED_MS in stream.ts): what another process, or a later share, sees. */
const later = () => Date.now() + 11 * 60_000;

/**
 * `byRead`: the tool's read recorded bad/<stream> already (which counts at once). Otherwise the reuse check finds the
 * gap and records it, once it checks the parts again: `finishedStream` found them whole a moment ago, so look later.
 */
async function assertNotReused(store: BlobStore, id: string, byRead = true) {
  if (byRead) assert.ok(await store.head(damagedKey(id)), 'bad/<stream> is recorded by the read');
  const when = byRead ? {} : { now: later };
  assert.equal(await usableProxy(store, src, 'p1', when), null, 'the next share does not reuse the stream');
  assert.ok(await store.head(damagedKey(id)), 'bad/<stream> is recorded');
  const next = await claimProxyStream(store, src, 'p1', 'libx264', when);
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

test('a stream found whole is not checked again in this process: no HEADs, but a damage report still counts at once', async () => {
  const store = new CountingMemoryStore();
  const { id, segs } = await finishedStream(store); // checked once, inside
  const heads = store.counters.heads;
  const lists = { n: 0 };
  const list = store.list.bind(store);
  store.list = async (prefix) => (lists.n++, list(prefix));
  for (let i = 0; i < 4; i++) assert.ok(await usableProxy(store, src, 'p1'));
  assert.equal(lists.n, 0, 'no listing');
  assert.ok(store.counters.heads - heads <= 4 * 2, 'no part HEADs (only the end and the report per check)');
  // A part gone without a report is found once the memory runs out...
  store.objects.delete(mediaKey(segs[2]!.hash));
  assert.ok(await usableProxy(store, src, 'p1'), 'remembered');
  assert.equal(await usableProxy(store, src, 'p1', { now: later }), null, 'checked again later');
  // ...and a report counts at once.
  const other = new CountingMemoryStore();
  const second = await finishedStream(other);
  await reportDamage(other, second.id, { hash: second.segs[0]!.hash });
  assert.equal(await usableProxy(other, src, 'p1'), null);
});

/** A store that pages its listing on the server, as S3 and R2 do. */
const asS3 = <T extends CountingMemoryStore>(store: T): T => Object.defineProperty(store, 'kind', { value: 's3' });

test('where the store pages its listing (S3, R2), a long stream is checked in a few pages, not a HEAD per part; HEADs elsewhere', async () => {
  const store = asS3(new CountingMemoryStore());
  const claim = await claimProxyStream(store, src, 'p1', 'libx264');
  const id = (claim.pointer as { stream: string }).stream;
  const hashes = Array.from({ length: 2000 }, (_, i) => i.toString(16).padStart(64, '0'));
  for (const h of hashes) store.objects.set(mediaKey(h), new Uint8Array(3));
  const end = { segments: 1999, durationSec: 3998, size: 6000, at: Date.now(), parts: hashes };
  store.objects.set(streamEndKey(id), new TextEncoder().encode(JSON.stringify(end)));
  // pages of 1000, as S3 gives them
  let lists = 0;
  store.list = async (prefix: string, opts?: { cursor?: string; limit?: number }) => {
    lists++;
    const keys = [...store.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = Number(opts?.cursor ?? 0);
    const page = keys.slice(from, from + (opts?.limit ?? 1000));
    const next = from + page.length;
    return { blobs: page.map((key) => ({ key, size: store.objects.get(key)!.length })), ...(next < keys.length ? { cursor: String(next) } : {}) };
  };
  let heads = store.counters.heads;
  assert.ok(await usableProxy(store, src, 'p1'));
  assert.equal(lists, 2);
  assert.ok(store.counters.heads - heads <= 2, 'no part HEADs');
  // a gone part: still found, by the listing plus one HEAD that confirms it
  store.objects.delete(mediaKey(hashes[1234]!));
  heads = store.counters.heads;
  assert.equal(await usableProxy(store, src, 'p1', { now: later }), null);
  assert.ok(store.counters.heads - heads <= 3);

  // A store whose listing is a local walk of the whole prefix (blob-fs, blob-memory): HEADs, no listing.
  const local = new CountingMemoryStore();
  await finishedStream(local);
  let walked = 0;
  local.list = async () => (walked++, { blobs: [] });
  assert.ok(await usableProxy(local, src, 'p1', { now: later }));
  assert.equal(walked, 0);

  // An S3-like store whose list fails (no permission): HEADs, and it isn't asked to list again.
  const host = asS3(new CountingMemoryStore());
  const two = await finishedStream(host);
  let tries = 0;
  host.list = async () => {
    tries++;
    throw new Error('the host HTTP API has no list');
  };
  assert.ok(await usableProxy(host, src, 'p1', { now: later }));
  assert.ok(await usableProxy(host, src, 'p1', { now: () => later() + 11 * 60_000 }));
  assert.equal(tries, 1);
  host.objects.delete(mediaKey(two.segs[1]!.hash));
  assert.equal(await usableProxy(host, src, 'p1', { now: () => later() + 22 * 60_000 }), null);
});

test('what one store holds vouches for nothing in another, and an end that changed is checked anew (review 3)', async () => {
  const a = new CountingMemoryStore();
  const { id, segs } = await finishedStream(a); // found whole in a
  const b = new CountingMemoryStore();
  for (const [key, value] of a.objects) b.objects.set(key, value);
  b.objects.delete(mediaKey(segs[1]!.hash));
  assert.equal(await usableProxy(b, src, 'p1'), null, 'b is missing a part');
  assert.ok((await claimProxyStream(b, src, 'p1', 'libx264')).claimed);
  assert.ok(await usableProxy(a, src, 'p1'), 'a is still whole');

  // The same stream id and end numbers, but the end now names a part that isn't there (rot in the entry).
  const end = JSON.parse(new TextDecoder().decode(a.objects.get(streamEndKey(id))!));
  end.parts[2] = 'ef'.repeat(32);
  a.objects.set(streamEndKey(id), new TextEncoder().encode(JSON.stringify(end)));
  assert.equal(await usableProxy(a, src, 'p1'), null);
});

test('through a Carton host, a 2,000-part stream is checked in 2 requests (POST /blobs/heads, REQ-11), and a gone part is still found', async () => {
  const requests: string[] = [];
  const counting = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push(`${init?.method ?? 'GET'} ${new URL(String(input instanceof Request ? input.url : input)).pathname}`);
    return fetch(input, init);
  }) as typeof fetch;
  const { blobs, store } = await host('heads', counting);
  // Seeded straight into the host's blob store: only the check goes through the client.
  const at = (k: string) => `projects/p/media/${k}`;
  const id = 'ab'.repeat(16) + '12'.repeat(16);
  const hashes = Array.from({ length: 2000 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
  for (const h of hashes) await blobs.put(at(mediaKey(h)), new Uint8Array(3));
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  await blobs.put(at(streamEndKey(id)), json({ segments: 1999, durationSec: 3998, size: 6000, at: Date.now(), parts: hashes }));
  await blobs.put(at(proxyPointerKey(src, 'p1')), json({ stream: id, encoder: 'libx264', at: Date.now() }));

  const p = await usableProxy(store, src, 'p1');
  assert.equal((p as { stream: string } | null)?.stream, id, 'reused');
  const heads = requests.filter((r) => r.endsWith('/blobs/heads'));
  assert.equal(heads.length, 2, '1,000 keys a request');
  assert.ok(requests.length <= 12, `the whole check takes a few requests, not one per part: ${requests.length}`);

  await blobs.delete(at(mediaKey(hashes[1500]!)));
  assert.equal(await usableProxy(store, src, 'p1', { now: later }), null, 'a gone part is found');
  assert.ok(await store.head(damagedKey(id)), 'and recorded');
});
