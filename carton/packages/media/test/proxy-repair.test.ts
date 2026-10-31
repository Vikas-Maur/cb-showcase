// Damage reports, takeovers and repairs around shared proxies (S5 review round 3: the reviewer's reproductions).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { scratchDir } from './helpers.ts';
import { writeFile } from 'node:fs/promises';
import { bytesSource, hashSource } from '../src/hash.ts';
import { damagedKey, mediaKey, proxyPointerKey, streamSegmentKey } from '../src/keys.ts';
import { LEAF_SIZE } from '../src/manifest.ts';
import { nodeHasher } from '../src/node/node-hasher.ts';
import { closeHashWorkers } from '../src/node/hash-file.ts';
import { shareMedia } from '../src/node/share.ts';
import { MediaReader } from '../src/read.ts';
import { claimProxyStream, ProxyStreamReader, ProxyStreamWriter, usableProxy } from '../src/stream.ts';
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
