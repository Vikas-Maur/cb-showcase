// Recovery after NoSuchUpload (CI #27), the review of 98ddb02: the reviewer's reproductions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bytesSource, hashSource } from '../src/hash.ts';
import { LEAF_SIZE } from '../src/manifest.ts';
import { nodeHasher } from '../src/node/node-hasher.ts';
import { CountingMemoryStore } from '../src/testing.ts';
import { damagedKey, mediaKey } from '../src/keys.ts';
import { reportDamage, repairedKey, isDamaged } from '../src/damage.ts';
import { MemoryUploadStateStore, uploadMedia } from '../src/upload.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(r => setImmediate(r));

async function setup() {
  const data = new Uint8Array(2 * LEAF_SIZE + 1).fill(71);
  const source = bytesSource(data);
  const manifest = await hashSource(source, nodeHasher);
  const store = new CountingMemoryStore();
  const state = new MemoryUploadStateStore();
  const key = mediaKey(manifest.hash);
  await store.put(key, new Uint8Array(data.length).fill(72));
  await reportDamage(store, manifest.hash);
  const create = store.createMultipart.bind(store);
  const head = store.head.bind(store);
  let hide = false;
  let lost = false;
  let recovering = false;
  store.head = async k => {
    if (k === key && hide) {
      hide = false;
      recovering = true;
      return null;
    }
    return head(k);
  };
  store.createMultipart = async k => {
    const u = await create(k);
    return { ...u, complete: async parts => {
      const result = await u.complete(parts);
      if (!lost) {
        lost = true;
        hide = true;
        throw Object.assign(new Error('NoSuchUpload'), { code: 'NoSuchUpload' });
      }
      return result;
    } };
  };
  return {
    store, state, key, manifest, data, recovering: () => recovering,
    opts: { store, state, source, manifest, hasher: nodeHasher, partSize: LEAF_SIZE, concurrency: 1, retries: 2, retryDelayMs: 0 },
  };
}

for (const stage of ['report read', 'answer write']) {
  test(`abort during recovery ${stage} must reject promptly`, async () => {
    const s = await setup();
    const entered = deferred();
    const release = deferred();
    const pause = async () => { entered.resolve(); await release.promise; };
    if (stage === 'report read') {
      const get = s.store.get.bind(s.store);
      s.store.get = async (k, r) => {
        if (s.recovering() && k === damagedKey(s.manifest.hash)) await pause();
        return get(k, r);
      };
    } else if (stage === 'answer write') {
      const put = s.store.put.bind(s.store);
      s.store.put = async (k, d, o) => {
        if (s.recovering() && k === repairedKey(s.manifest.hash)) await pause();
        return put(k, d, o);
      };
    } else {
      let verificationRead = false;
      const get = s.store.get.bind(s.store);
      s.store.get = async (k, r) => {
        if (s.recovering() && k === s.key) verificationRead = true;
        return get(k, r);
      };
      const del = s.state.delete.bind(s.state);
      s.state.delete = async k => {
        if (verificationRead) await pause();
        return del(k);
      };
    }
    const ac = new AbortController();
    let outcome = 'pending';
    const uploading = uploadMedia({ ...s.opts, signal: ac.signal }).then(
      () => { outcome = 'success'; }, e => { outcome = e.name; },
    );
    await entered.promise;
    ac.abort();
    await tick();
    const afterAbort = outcome;
    release.resolve();
    await uploading;
    assert.deepEqual({ afterAbort, final: outcome }, { afterAbort: 'AbortError', final: 'AbortError' });
  });
}

test('a transient recovery verification GET failure must not defeat upload recovery', async () => {
  const s = await setup();
  const get = s.store.get.bind(s.store);
  let failed = false;
  s.store.get = async (k, r) => {
    if (s.recovering() && k === s.key && !failed) {
      failed = true;
      throw new Error('ECONNRESET during recovery verification');
    }
    return get(k, r);
  };
  await uploadMedia(s.opts);
  assert.equal(await isDamaged(s.store, s.manifest.hash), false);
  assert.equal(await s.state.load(s.key), null);
});

test('a sound recovered object clears the saved state and keeps the UploadResult shape', async () => {
  const s = await setup();
  const result = await uploadMedia(s.opts);
  assert.equal(await s.state.load(s.key), null);
  assert.equal(await isDamaged(s.store, s.manifest.hash), false);
  assert.deepEqual(Object.keys(result).sort(), ['hash', 'size', 'deduped', 'partSize', 'resumedParts', 'partsSent', 'bytesSent'].sort());
  assert.deepEqual(s.store.objects.get(s.key), s.data);
});

for (const mutation of ['damaged', 'absent']) {
  test(`recovery does not answer the report when verification finds the object ${mutation}`, async () => {
    const s = await setup();
    const get = s.store.get.bind(s.store);
    const put = s.store.put.bind(s.store);
    let changed = false;
    s.store.get = async (k, r) => {
      if (s.recovering() && k === s.key && !changed) {
        changed = true;
        if (mutation === 'absent') s.store.objects.delete(s.key);
        else s.store.objects.get(s.key)![0] ^= 255;
      }
      return get(k, r);
    };
    s.store.put = async (k, d, o) => {
      if (k === repairedKey(s.manifest.hash)) {
        assert.deepEqual(s.store.objects.get(s.key), s.data, 'must not answer until a good object exists');
      }
      return put(k, d, o);
    };
    await uploadMedia(s.opts);
    assert.equal(changed, true);
    assert.deepEqual(s.store.objects.get(s.key), s.data);
    assert.equal(await isDamaged(s.store, s.manifest.hash), false);
    assert.equal(await s.state.load(s.key), null);
  });
}

test('resumedParts and partSize reset after a resumed upload expires and the restart uses a single PUT', async () => {
  const store = new CountingMemoryStore();
  const state = new MemoryUploadStateStore();
  const data = new Uint8Array(3 * LEAF_SIZE).fill(29);
  const source = bytesSource(data);
  const manifest = await hashSource(source, nodeHasher);
  const key = mediaKey(manifest.hash);
  const up = await store.createMultipart(key);
  const first = await up.uploadPart(1, data.subarray(0, LEAF_SIZE));
  await state.save({ v: 1, key, hash: manifest.hash, size: manifest.size, partSize: LEAF_SIZE, uploadId: up.uploadId, parts: [{ ...first, size: LEAF_SIZE }] });
  const resume = store.resumeMultipart.bind(store);
  store.resumeMultipart = async (k, id) => {
    const u = await resume(k, id);
    return { ...u, uploadPart: async (n, d) => {
      const part = await u.uploadPart(n, d);
      if (n === 2) store.uploads.delete(id);
      return part;
    } };
  };
  const result = await uploadMedia({ store, state, source, manifest, hasher: nodeHasher, concurrency: 1, retries: 0, retryDelayMs: 0 });
  assert.equal(result.resumedParts, 0);
  assert.equal(result.partSize, 8 * LEAF_SIZE);
  assert.equal(result.deduped, false);
  assert.equal(result.partsSent, 2);
  assert.equal(result.bytesSent, 5 * LEAF_SIZE);
  assert.equal(await state.load(key), null);
  assert.deepEqual(store.objects.get(key), data);
});

test('recovery forgets no saved state of its own: the run that met NoSuchUpload already did (review of 821f598)', async () => {
  const s = await setup();
  let verificationRead = false;
  let deletedAfter = 0;
  const get = s.store.get.bind(s.store);
  s.store.get = async (k, r) => {
    if (s.recovering() && k === s.key) verificationRead = true;
    return get(k, r);
  };
  const del = s.state.delete.bind(s.state);
  s.state.delete = async (k) => {
    if (verificationRead) deletedAfter++;
    return del(k);
  };
  await uploadMedia(s.opts);
  assert.equal(deletedAfter, 0);
  assert.equal(await s.state.load(s.key), null);
});

test('work a cancelled recovery leaves running cannot erase a later upload\'s saved state (review of 821f598)', async () => {
  const s = await setup();
  const entered = deferred();
  const release = deferred();
  const put = s.store.put.bind(s.store);
  let blockOnce = true;
  s.store.put = async (k, d, o) => {
    if (blockOnce && s.recovering() && k === repairedKey(s.manifest.hash)) {
      blockOnce = false;
      entered.resolve();
      await release.promise;
    }
    return put(k, d, o);
  };
  const ac = new AbortController();
  const first = assert.rejects(uploadMedia({ ...s.opts, signal: ac.signal }), { name: 'AbortError' });
  await entered.promise;
  ac.abort();
  await first;
  // The object goes (a host removed it); a retry saves its progress and fails resumably.
  s.store.objects.delete(s.key);
  const source = {
    size: s.data.length,
    read: async (offset: number, length: number) => {
      if (offset >= LEAF_SIZE) throw new Error('source temporarily unavailable');
      return s.data.subarray(offset, offset + length);
    },
  };
  await assert.rejects(uploadMedia({ ...s.opts, source }), /source temporarily unavailable/);
  const saved = await s.state.load(s.key);
  assert.ok(saved && saved.parts.length > 0, 'the failed retry saved its resumable upload');
  release.resolve();
  await tick();
  await tick();
  assert.deepEqual(await s.state.load(s.key), saved);
});
