// Damage reports, takeovers and repairs around shared proxies (S5 review round 3: the reviewer's reproductions).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { scratchDir } from './helpers.ts';
import { writeFile } from 'node:fs/promises';
import { bytesSource, hashSource } from '../src/hash.ts';
import { damagedKey, mediaKey, proxyPointerKey, streamEndKey, streamInitKey, streamSegmentKey } from '../src/keys.ts';
import { MemoryLeafCache } from '../src/cache.ts';
import { LEAF_SIZE } from '../src/manifest.ts';
import { nodeHasher } from '../src/node/node-hasher.ts';
import { closeHashWorkers } from '../src/node/hash-file.ts';
import { shareMedia } from '../src/node/share.ts';
import { MediaReader } from '../src/read.ts';
import { claimProxyStream, findProxy, ProxyStreamReader, ProxyStreamWriter, usableProxy } from '../src/stream.ts';
import { startRangeServer } from '../src/node/range-server.ts';
import { CountingMemoryStore } from '../src/testing.ts';
import { MemoryUploadStateStore, uploadMedia } from '../src/upload.ts';

const src = 'ab'.repeat(32);
const s = scratchDir('proxy-repair');
after(() => {
  closeHashWorkers();
  s.cleanup();
});
const scratch = s.dir;

async function stream(store: CountingMemoryStore) {
  const claim = await claimProxyStream(store, src, 'p1', 'libx264');
  const writer = new ProxyStreamWriter({ store, hasher: nodeHasher, id: (claim.pointer as { stream: string }).stream });
  await writer.init(new Uint8Array([1]));
  const part = await writer.segment(new Uint8Array([2, 3]), 2);
  return { writer, part };
}

test('a part a tool found damaged through the playlist makes a live stream replaceable (finding 1; S5-7: no listing)', async () => {
  const store = new CountingMemoryStore();
  const { writer, part } = await stream(store);
  store.objects.get(mediaKey(part.hash))![0] ^= 255;
  const media = new MediaReader({ store, hasher: nodeHasher, repairAttempts: 1 });
  const reader = new ProxyStreamReader({ store, media, id: writer.id });
  const server = await startRangeServer({
    source: media.toolSource(),
    playlist: (id, urlFor) => reader.playlist(urlFor),
    reportDamage: (_stream, hash) => reader.reportPartDamage(hash),
  });
  try {
    const list = await (await fetch(server.playlistUrl(writer.id))).text();
    const url = list.split("\n").find((l) => l.includes(part.hash))!;
    assert.equal((await fetch(url)).status, 502);
  } finally {
    await server.close();
  }
  assert.ok(store.objects.has(damagedKey(writer.id)), 'reported against the stream');
  store.list = async () => assert.fail('the reuse check lists nothing');
  assert.equal(await usableProxy(store, src, 'p1'), null, 'must not reuse corrupt live stream');
});
test('a reported proxy is not kept when its pointer lookup fails (finding 2)', async () => {
  const store = new CountingMemoryStore();
  const bytes = new Uint8Array([10, 11, 12]);
  const manifest = await hashSource(bytesSource(bytes), nodeHasher);
  const path = `${scratch}/original.bin`;
  await writeFile(path, bytes);
  const badHash = 'cd'.repeat(32);
  await store.put(damagedKey(badHash), new Uint8Array([1]));
  const get = store.get.bind(store);
  store.get = async (k, r) => { if (k.startsWith('px/')) throw new Error('proxy lookup failed'); return get(k, r); };
  await assert.rejects(shareMedia({
    store, record: { id: 'clip', kind: 'video', fileName: 'original.bin', size: bytes.length, hash: manifest.hash, proxy: { hash: badHash, size: 1, profile: 'p1', encoder: 'libx264' } },
    local: { original: path }, policy: { originals: false }, encoders: [], workDir: scratch,
  }), /proxy lookup failed/);
});

test('a takeover cannot make an overlapping check accept the old damaged stream (finding 3)', async () => {
  const store = new CountingMemoryStore();
  const { writer } = await stream(store);
  await writer.end();
  await store.delete(streamSegmentKey(writer.id, 0));
  await store.put(damagedKey(writer.id), new Uint8Array([1]));
  const get = store.get.bind(store);
  let replaced = false;
  store.get = async (k, r) => {
    const got = await get(k, r);
    if (k === proxyPointerKey(src, 'p1') && !replaced) {
      replaced = true;
      assert.equal((await claimProxyStream(store, src, 'p1', 'libx264')).claimed, true);
    }
    return got;
  };
  const found = await usableProxy(store, src, 'p1');
  assert.ok(found === null || !('stream' in found) || found.stream !== writer.id, 'old stream is missing its segment entry');
});

async function repairSetup() {
  const store = new CountingMemoryStore();
  const bytes = new Uint8Array(2 * LEAF_SIZE + 1).fill(7);
  const manifest = await hashSource(bytesSource(bytes), nodeHasher);
  const state = new MemoryUploadStateStore();
  const o = { store, source: bytesSource(bytes), manifest, hasher: nodeHasher, state, partSize: LEAF_SIZE, retries: 0, concurrency: 1 };
  await uploadMedia(o);
  await store.put(damagedKey(manifest.hash), new Uint8Array([1]));
  return { store, o, manifest };
}

test('finding the object healthy after a failed repair aborts the partial upload (finding 4)', async () => {
  const { store, o, manifest } = await repairSetup();
  const create = store.createMultipart.bind(store);
  let repairId = '';
  store.createMultipart = async (k) => {
    const up = await create(k);
    repairId = up.uploadId;
    return { ...up, uploadPart: async (n, data) => { if (n === 2) throw new Error('link dropped'); return up.uploadPart(n, data); } };
  };
  await uploadMedia(o);
  assert.equal(await o.state.load(mediaKey(manifest.hash)), null);
  assert.equal(store.uploads.has(repairId), false, 'successful fallback forgot an upload with stored parts instead of aborting it');
});

test('cancelling during the read-back ends in AbortError (finding 5)', async () => {
  const { store, o, manifest } = await repairSetup();
  const create = store.createMultipart.bind(store);
  store.createMultipart = async (k) => {
    const up = await create(k);
    return { ...up, complete: async (parts) => { await up.complete(parts); throw Object.assign(new Error('NoSuchUpload'), { code: 'NoSuchUpload' }); } };
  };
  // Keep the same ETag across completion so the recovery must read the bytes.
  const head = store.head.bind(store);
  store.head = async (k) => { const h = await head(k); return h && { ...h, etag: 'stable' }; };
  const ac = new AbortController();
  const get = store.get.bind(store);
  store.get = async (k, r) => { const got = await get(k, r); if (k === mediaKey(manifest.hash)) ac.abort(); return got; };
  await assert.rejects(uploadMedia({ ...o, signal: ac.signal }), { name: 'AbortError' });
});

test('cancelling stops waiting for a stalled read-back read (finding 5)', async () => {
  const { store, o, manifest } = await repairSetup();
  const create = store.createMultipart.bind(store);
  store.createMultipart = async (k) => {
    const up = await create(k);
    return { ...up, complete: async (parts) => { await up.complete(parts); throw Object.assign(new Error('NoSuchUpload'), { code: 'NoSuchUpload' }); } };
  };
  const head = store.head.bind(store);
  store.head = async (k) => { const h = await head(k); return h && { ...h, etag: 'stable' }; };
  const get = store.get.bind(store);
  let entered!: () => void;
  const firstGet = new Promise<void>(r => { entered = r; });
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  store.get = async (k, r) => { if (k === mediaKey(manifest.hash)) { entered(); await gate; } return get(k, r); };
  const ac = new AbortController();
  let outcome = 'pending';
  const upload = uploadMedia({ ...o, signal: ac.signal }).then(() => { outcome = 'success'; }, e => { outcome = e.name; });
  await firstGet;
  ac.abort();
  // Allow all abort handlers and promise continuations to run without a wall-clock measurement.
  await new Promise<void>(r => setImmediate(r));
  const afterAbort = outcome;
  release();
  await upload;
  assert.equal(afterAbort, 'AbortError', 'abort left the caller waiting for a read-only GET to answer');
});

// S5 review round 4 (the reviewer's reproductions, typed).
const json = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
const lostCompletion = (store: CountingMemoryStore) => {
  const create = store.createMultipart.bind(store);
  store.createMultipart = async (k: string) => {
    const up = await create(k);
    return {
      ...up,
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        await up.complete(parts);
        throw Object.assign(new Error('NoSuchUpload'), { code: 'NoSuchUpload' });
      },
    };
  };
  const head = store.head.bind(store);
  store.head = async (k: string) => {
    const h = await head(k);
    return h && { ...h, etag: 'stable' };
  };
};

test('a pointer that keeps changing is not vouched for, even past the re-read limit (round 4, finding 1)', async () => {
  const store = new CountingMemoryStore();
  const ids = ['10', '11', '12', '13', '14', '15'].map((x) => x.repeat(32));
  for (const id of ids.slice(0, -1)) {
    await store.put(streamEndKey(id), json({ segments: 1, durationSec: 2, size: 2, at: Date.now() }));
    await store.put(damagedKey(id), new Uint8Array([1]));
  }
  const key = proxyPointerKey(src, 'p1');
  await store.put(key, json({ stream: ids[0], at: Date.now(), encoder: 'libx264' }));
  const get = store.get.bind(store);
  const replaced = new Set<string>();
  let takingOver = false;
  // Every read of the pointer races a takeover, which deletes the old stream's report.
  store.get = async (k, r) => {
    const got = await get(k, r);
    if (k === key && got && !takingOver) {
      const old = JSON.parse(new TextDecoder().decode(got)).stream as string;
      const index = ids.indexOf(old);
      if (index < ids.length - 1) {
        takingOver = true;
        assert.equal((await claimProxyStream(store, src, 'p1', 'libx264', { id: ids[index + 1] })).claimed, true);
        replaced.add(old);
        takingOver = false;
      }
    }
    return got;
  };
  const found = await usableProxy(store, src, 'p1');
  assert.ok(found === null || !('stream' in found) || !replaced.has(found.stream));
});

test('a claim that fails right after it is written is reported, so a retry takes it over (round 4, finding 2)', async () => {
  const store = new CountingMemoryStore();
  const get = store.get.bind(store);
  let fail = true;
  store.get = async (k, r) => {
    if (k.startsWith('px/') && fail) {
      fail = false;
      throw new Error('transient GET failure');
    }
    return get(k, r);
  };
  await assert.rejects(claimProxyStream(store, src, 'p1', 'libx264'), /transient GET/);
  const stranded = await findProxy(store, src, 'p1');
  assert.ok(stranded && 'stream' in stranded);
  const retry = await claimProxyStream(store, src, 'p1', 'libx264');
  assert.equal(retry.claimed, true, 'not left waiting for a stream nobody writes');
  assert.notEqual((retry.pointer as { stream: string }).stream, stranded.stream);
});

test('cancelling the read-back with a custom reason ends with that reason (round 4, finding 6)', async () => {
  const store = new CountingMemoryStore();
  const data = new Uint8Array(LEAF_SIZE + 1).fill(7);
  const manifest = await hashSource(bytesSource(data), nodeHasher);
  const options = { store, source: bytesSource(data), manifest, hasher: nodeHasher, state: new MemoryUploadStateStore(), partSize: LEAF_SIZE, retries: 0, concurrency: 1 };
  await uploadMedia(options);
  await store.put(damagedKey(manifest.hash), new Uint8Array([1]));
  lostCompletion(store);
  let entered!: () => void;
  const firstRead = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const get = store.get.bind(store);
  store.get = async (k, r) => {
    if (k === mediaKey(manifest.hash)) {
      entered();
      await gate;
    }
    return get(k, r);
  };
  const ac = new AbortController();
  const reason = new Error('share cancelled by caller');
  const outcome = uploadMedia({ ...options, signal: ac.signal }).then((r) => ({ result: r, error: undefined }), (error: unknown) => ({ error }));
  await firstRead;
  ac.abort(reason);
  const got = await outcome;
  release();
  assert.equal(got.error, reason);
});

test('cancelling during the read-back\'s last digest ends in AbortError, not success (round 4, finding 5)', async () => {
  const store = new CountingMemoryStore();
  const data = new Uint8Array(LEAF_SIZE + 1).fill(7);
  const manifest = await hashSource(bytesSource(data), nodeHasher);
  const options = { store, source: bytesSource(data), manifest, hasher: nodeHasher, partSize: LEAF_SIZE, retries: 0, concurrency: 1 };
  await uploadMedia(options);
  await store.put(damagedKey(manifest.hash), new Uint8Array([1]));
  lostCompletion(store);
  let lastRead = false;
  const get = store.get.bind(store);
  store.get = async (k, r) => {
    const bytes = await get(k, r);
    if (k === mediaKey(manifest.hash) && r?.offset === LEAF_SIZE) lastRead = true;
    return bytes;
  };
  let entered!: () => void;
  const hashing = new Promise<void>((r) => (entered = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const hasher = {
    name: 'abort-in-final-digest',
    sha256: async (bytes: Uint8Array) => {
      if (lastRead) {
        entered();
        await gate;
      }
      return nodeHasher.sha256(bytes);
    },
  };
  const ac = new AbortController();
  let outcome = 'pending';
  const upload = uploadMedia({ ...options, hasher, signal: ac.signal }).then(() => void (outcome = 'success'), (e: Error) => void (outcome = e.name));
  await hashing;
  ac.abort();
  await new Promise((r) => setImmediate(r));
  const afterAbort = outcome;
  release();
  await upload;
  assert.equal(afterAbort, 'AbortError');
});

// S5 review round 5 (the reviewer's reproductions, typed).
async function liveStream() {
  const store = new CountingMemoryStore();
  const claim = await claimProxyStream(store, src, 'p1', 'test');
  const writer = new ProxyStreamWriter({ store, hasher: nodeHasher, id: (claim.pointer as { stream: string }).stream });
  const init = await writer.init(new Uint8Array([1]));
  const part = await writer.segment(new Uint8Array([2, 3]), 2);
  return { store, writer, init, part };
}

test('an entry that reads as JSON but not as an entry is not kept, and is read again (round 5, finding 1)', async () => {
  const { store, writer, init } = await liveStream();
  const cache = new MemoryLeafCache();
  const media = new MediaReader({ store, hasher: nodeHasher, cache });
  const get = store.get.bind(store);
  let transient = true;
  store.get = async (key, range) => {
    if (key === streamInitKey(writer.id) && transient) {
      transient = false;
      const b = (await get(key, range))!;
      return new TextEncoder().encode(new TextDecoder().decode(b).replace('size', 'sixe'));
    }
    return get(key, range);
  };
  const reader = new ProxyStreamReader({ store, media, id: writer.id });
  assert.equal(await reader.initPart(), null);
  assert.deepEqual(await reader.initPart(), init, 'the store is asked again');
  // And one already kept invalid (an older cache): read from the store instead.
  await cache.putEntry(streamInitKey(writer.id), new TextEncoder().encode('{"hash":"nope"}'));
  assert.deepEqual(await new ProxyStreamReader({ store, media, id: writer.id }).initPart(), init);
});

test('reporting a known damaged segment needs no further entry reads (round 5, finding 2)', async () => {
  const { store, writer, part } = await liveStream();
  const media = new MediaReader({ store, hasher: nodeHasher, repairAttempts: 1 });
  const reader = new ProxyStreamReader({ store, media, id: writer.id });
  await reader.segment(0);
  let handled!: () => void;
  const requestDone = new Promise<void>((r) => (handled = r));
  const server = await startRangeServer({
    onRequest: (info) => {
      if (info.hash === part.hash && info.error) handled();
    },
    source: media.toolSource(),
    playlist: (_id, urlFor) => reader.playlist(urlFor),
    reportDamage: (_stream, hash) => reader.reportPartDamage(hash),
  });
  try {
    const list = await (await fetch(server.playlistUrl(writer.id))).text();
    const url = list.split('\n').find((line) => line.includes(part.hash))!;
    store.objects.get(mediaKey(part.hash))![0] ^= 255;
    const get = store.get.bind(store);
    let failNext = true;
    store.get = async (key, range) => {
      if (key === streamSegmentKey(writer.id, 1) && failNext) {
        failNext = false;
        throw new Error('transient metadata GET failure');
      }
      return get(key, range);
    };
    assert.equal((await fetch(url)).status, 502);
    await requestDone; // onRequest runs after the damage callback settles
    assert.equal(await usableProxy(store, src, 'p1'), null, 'the stream is reported');
  } finally {
    await server.close();
  }
});
