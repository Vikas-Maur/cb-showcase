// BlobStore conformance suite (PLAN §3.1): a store is accepted when it passes this, whatever it runs on. Each test
// checks one invariant from `BlobStore` in `@carton/core/plugins`; the comments say which.
//
// Usage, in a store's own test file:
//   import { blobStoreSuite } from "@carton/conformance";
//   blobStoreSuite("fs", async () => createFsBlobStore({ root: dir }), { cleanup });
//
// Keys are prefixed with a random run id, so the suite can share a real bucket with other runs.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { BlobStore } from "@carton/core/plugins";

export interface BlobSuiteOptions {
  // Runs after the suite (and after it deleted its keys).
  cleanup?: () => Promise<void>;
  // Smallest part S3 and R2 accept (5 MiB) for every part but the last; 0 when the store has no minimum.
  minPartSize?: number;
  // Fetch implementation for signed URLs (defaults to the global fetch); only used when the store has signedUrl.
  fetch?: typeof fetch;
  // How long to wait for a 1 s signed URL to expire; 0 skips that (slow) check.
  expiryWaitMs?: number;
}

const bytes = (n: number, seed: number): Uint8Array => {
  const b = new Uint8Array(n);
  let x = seed * 2654435761 >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    b[i] = x & 0xff;
  }
  return b;
};
const text = (s: string) => new TextEncoder().encode(s);
const eq = (a: Uint8Array | null, b: Uint8Array, msg?: string) => {
  assert.ok(a, msg ?? "expected bytes, got null");
  assert.equal(a.byteLength, b.byteLength, msg);
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) assert.fail(`${msg ?? "bytes differ"} at byte ${i}`);
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
};
async function readStream(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of s as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
  return concat(...chunks);
}

export function blobStoreSuite(name: string, make: () => Promise<BlobStore>, opts: BlobSuiteOptions = {}): void {
  const run = `conf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let store: BlobStore;
  const k = (name: string) => `${run}/${name}`;
  const partSize = Math.max(opts.minPartSize ?? 0, 64 * 1024);

  describe(`BlobStore conformance: ${name}`, () => {
    before(async () => {
      store = await make();
    });
    after(async () => {
      // leave nothing behind in a shared bucket
      for (;;) {
        const page = await store.list(run + "/");
        for (const b of page.blobs) await store.delete(b.key);
        if (!page.cursor || page.blobs.length === 0) break;
      }
      await opts.cleanup?.();
    });

    test("put then get and head return the bytes and their size", async () => {
      const data = bytes(1000, 1);
      // the real hash: a store may verify it (R2 does) and refuse bytes that don't match
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const info = await store.put(k("a"), data, { contentType: "video/mp4", sha256 });
      assert.equal(info.key, k("a"));
      assert.equal(info.size, 1000);
      eq(await store.get(k("a")), data);
      const h = await store.head(k("a"));
      assert.ok(h);
      assert.equal(h.size, 1000);
      assert.equal(h.contentType, "video/mp4");
      assert.equal(h.sha256, sha256);
    });

    test("a blob is the bytes at put time: the caller's buffers are never shared", async () => {
      const data = bytes(64, 2), copy = data.slice();
      await store.put(k("own"), data);
      data.fill(0);
      const got = await store.get(k("own"));
      eq(got, copy);
      got!.fill(1);
      eq(await store.get(k("own")), copy);
    });

    test("absent keys: get and head give null, delete is a no-op", async () => {
      assert.equal(await store.get(k("missing")), null);
      assert.equal(await store.get(k("missing"), { offset: 0, length: 1 }), null);
      assert.equal(await store.head(k("missing")), null);
      await store.delete(k("missing"));
    });

    test("an empty blob is a blob", async () => {
      await store.put(k("empty"), new Uint8Array(0));
      eq(await store.get(k("empty")), new Uint8Array(0));
      assert.equal((await store.head(k("empty")))?.size, 0);
    });

    test("a plain put replaces the bytes, and the etag changes", async () => {
      const a = await store.put(k("r"), text("first"));
      const b = await store.put(k("r"), text("second version"));
      eq(await store.get(k("r")), text("second version"));
      if (a.etag !== undefined && b.etag !== undefined) assert.notEqual(a.etag, b.etag);
      assert.equal((await store.head(k("r")))?.etag, b.etag);
    });

    test("put with ifAbsent leaves existing bytes untouched and returns their info", async () => {
      await store.put(k("once"), text("original"));
      const info = await store.put(k("once"), text("replacement!"), { ifAbsent: true });
      assert.equal(info.size, 8);
      eq(await store.get(k("once")), text("original"));
      const fresh = await store.put(k("once-new"), text("x"), { ifAbsent: true });
      assert.equal(fresh.size, 1);
      eq(await store.get(k("once-new")), text("x"));
    });

    test("ranges return exactly [offset, offset + length), clipped at the end", async () => {
      const data = bytes(10_000, 3);
      await store.put(k("rng"), data);
      eq(await store.get(k("rng"), { offset: 0, length: 10 }), data.subarray(0, 10), "head");
      eq(await store.get(k("rng"), { offset: 4321, length: 1000 }), data.subarray(4321, 5321), "middle");
      eq(await store.get(k("rng"), { offset: 9999, length: 1 }), data.subarray(9999), "last byte");
      eq(await store.get(k("rng"), { offset: 9000 }), data.subarray(9000), "to the end");
      eq(await store.get(k("rng"), { offset: 9990, length: 100 }), data.subarray(9990), "clipped");
      eq(await store.get(k("rng"), { offset: 0 }), data, "whole");
    });

    test("a range at or past the end, or of length 0, is an empty array", async () => {
      await store.put(k("rng2"), bytes(100, 4));
      eq(await store.get(k("rng2"), { offset: 100, length: 10 }), new Uint8Array(0), "at end");
      eq(await store.get(k("rng2"), { offset: 5000 }), new Uint8Array(0), "past end");
      eq(await store.get(k("rng2"), { offset: 10, length: 0 }), new Uint8Array(0), "length 0");
    });

    test("invalid ranges and keys are refused before any I/O", async () => {
      await assert.rejects(store.get(k("rng2"), { offset: -1, length: 2 }));
      await assert.rejects(store.get(k("rng2"), { offset: 1.5 }));
      await assert.rejects(store.put("", text("x")));
      await assert.rejects(store.put(k("x".repeat(1100)), text("x")));
    });

    test("keys are opaque: case, unicode, spaces, reserved characters, and an object beside a folder", async () => {
      const keys = ["Clip.MP4", "clip.mp4", "dir/Ünïcødé 名前.mov", "a b+c%20d?e#f&g=h", "CON", "nul.txt", "x/", "trailing.", "a", "a/b", "a/b/c", "~tilde~b", ".hidden", "..."];
      const valid = keys.filter((x) => !x.endsWith("/"));
      for (const [i, key] of valid.entries()) await store.put(k(key), text(`v${i}:${key}`));
      for (const [i, key] of valid.entries()) eq(await store.get(k(key)), text(`v${i}:${key}`), key);
      const listed = new Set<string>();
      let cursor: string | undefined;
      do {
        const page: { blobs: { key: string }[]; cursor?: string } = await store.list(k(""), cursor ? { cursor } : {});
        for (const b of page.blobs) listed.add(b.key);
        cursor = page.cursor;
      } while (cursor);
      for (const key of valid) assert.ok(listed.has(k(key)), `list misses ${key}`);
      // a 1024-byte key is legal
      const long = k("L".repeat(1024 - k("").length));
      await store.put(long, text("long"));
      eq(await store.get(long), text("long"));
      await store.delete(long);
    });

    test("list: prefix, order, and paging with a cursor visit every key once", async () => {
      const names = Array.from({ length: 25 }, (_, i) => `ls/item-${String(i).padStart(3, "0")}`);
      await Promise.all(names.map((n, i) => store.put(k(n), bytes(10 + i, i))));
      await store.put(k("lsx/other"), text("not in prefix"));
      const seen: string[] = [];
      let cursor: string | undefined, pages = 0;
      do {
        const page: { blobs: { key: string; size: number }[]; cursor?: string } = await store.list(k("ls/"), { limit: 7, ...(cursor ? { cursor } : {}) });
        assert.ok(page.blobs.length <= 7);
        for (const b of page.blobs) seen.push(b.key);
        cursor = page.cursor;
        pages++;
        assert.ok(pages < 20, "cursor loops");
      } while (cursor);
      assert.deepEqual(seen, names.map(k));
      const one = await store.list(k("ls/item-007"));
      assert.equal(one.blobs.length, 1);
      assert.equal(one.blobs[0]!.size, 17);
    });

    test("delete removes the key and nothing else", async () => {
      await store.put(k("d/1"), text("1"));
      await store.put(k("d/2"), text("2"));
      await store.delete(k("d/1"));
      assert.equal(await store.get(k("d/1")), null);
      eq(await store.get(k("d/2")), text("2"));
    });

    test("multipart: parts out of order, listed, resumed by id, completed in part-number order", async () => {
      const p1 = bytes(partSize, 11), p2 = bytes(partSize, 12), p3 = bytes(1234, 13);
      const up = await store.createMultipart(k("mp/one"), { contentType: "video/mp4" });
      assert.equal(up.key, k("mp/one"));
      const r3 = await up.uploadPart(3, p3);
      const r1 = await up.uploadPart(1, p1);
      assert.equal(r1.partNumber, 1);
      // a restart: a fresh handle from the id alone sees the same parts
      const again = await store.resumeMultipart(k("mp/one"), up.uploadId);
      const listed = await again.listParts();
      assert.deepEqual(listed.map((p) => [p.partNumber, p.size]), [[1, partSize], [3, 1234]]);
      assert.equal(listed[0]!.etag, r1.etag);
      assert.equal(listed[1]!.etag, r3.etag);
      const r2 = await again.uploadPart(2, p2);
      assert.equal(await store.head(k("mp/one")), null, "nothing visible before complete");
      const info = await again.complete([r3, r1, r2]);
      assert.equal(info.size, 2 * partSize + 1234);
      const whole = concat(p1, p2, p3);
      eq(await store.get(k("mp/one")), whole);
      eq(await store.get(k("mp/one"), { offset: partSize - 5, length: 10 }), whole.subarray(partSize - 5, partSize + 5), "across a part boundary");
      assert.equal((await store.head(k("mp/one")))?.contentType, "video/mp4");
    });

    test("multipart: a re-uploaded part replaces the old one, whose etag no longer completes", async () => {
      const up = await store.createMultipart(k("mp/re"));
      const old = await up.uploadPart(1, bytes(500, 21));
      const neu = await up.uploadPart(1, bytes(500, 22));
      await assert.rejects(up.complete([old]));
      await up.complete([neu]);
      eq(await store.get(k("mp/re")), bytes(500, 22));
    });

    test("multipart: parts before the last must be equal, and the last no larger", async () => {
      const up = await store.createMultipart(k("mp/unequal"));
      const a = await up.uploadPart(1, bytes(partSize, 31));
      const b = await up.uploadPart(2, bytes(partSize + 1, 32));
      const c = await up.uploadPart(3, bytes(10, 33));
      await assert.rejects(up.complete([a, b, c]));
      await up.abort();
    });

    test("multipart: abort discards the upload, and a spent id can't be used again", async () => {
      const up = await store.createMultipart(k("mp/abort"));
      await up.uploadPart(1, bytes(100, 41));
      await up.abort();
      await assert.rejects((await store.resumeMultipart(k("mp/abort"), up.uploadId)).listParts());
      assert.equal(await store.head(k("mp/abort")), null);
      const done = await store.createMultipart(k("mp/spent"));
      const p = await done.uploadPart(1, bytes(10, 42));
      await done.complete([p]);
      await assert.rejects(done.uploadPart(2, bytes(10, 43)));
    });

    test("multipart: a bogus upload id or part number is refused", async () => {
      await assert.rejects((await store.resumeMultipart(k("mp/bogus"), "no-such-upload")).listParts());
      const up = await store.createMultipart(k("mp/num"));
      await assert.rejects(up.uploadPart(0, bytes(1, 1)));
      await assert.rejects(up.uploadPart(10_001, bytes(1, 1)));
      await up.abort();
    });

    test("a plain put replaces atomically: concurrent readers see the old or the new bytes, never a mix", async () => {
      const A = new Uint8Array(256 * 1024).fill(0xaa), B = new Uint8Array(256 * 1024).fill(0xbb);
      await store.put(k("atomic"), A);
      const reads: Promise<Uint8Array | null>[] = [];
      const writes = [store.put(k("atomic"), B), store.put(k("atomic"), A), store.put(k("atomic"), B)];
      for (let i = 0; i < 6; i++) reads.push(store.get(k("atomic")));
      await Promise.all(writes);
      for (const r of await Promise.all(reads)) {
        assert.ok(r && r.byteLength === A.byteLength, "torn length");
        const v = r[0];
        assert.ok(r.every((x) => x === v), "torn read");
      }
    });

    test("getStream, when offered, streams the same bytes as get", async (t) => {
      if (!store.getStream) return t.skip("no getStream");
      const data = bytes(300_000, 51);
      await store.put(k("stream"), data);
      eq(await readStream((await store.getStream(k("stream")))!), data);
      eq(await readStream((await store.getStream(k("stream"), { offset: 1000, length: 5000 }))!), data.subarray(1000, 6000));
      eq(await readStream((await store.getStream(k("stream"), { offset: 400_000 }))!), new Uint8Array(0));
      assert.equal(await store.getStream(k("nope")), null);
    });

    test("signedUrl, when offered: GET and PUT work for anyone holding the URL, until it expires", async (t) => {
      if (!store.signedUrl) return t.skip("no signedUrl");
      const f = opts.fetch ?? fetch;
      await store.put(k("signed"), text("signed bytes"));
      const get = await store.signedUrl(k("signed"), { method: "GET", expiresIn: 60 });
      const r = await f(get);
      assert.equal(r.status, 200);
      eq(new Uint8Array(await r.arrayBuffer()), text("signed bytes"));
      const ranged = await f(get, { headers: { range: "bytes=7-11" } });
      assert.equal(ranged.status, 206);
      eq(new Uint8Array(await ranged.arrayBuffer()), text("bytes"));
      const put = await store.signedUrl(k("signed-up"), { method: "PUT", expiresIn: 60 });
      const w = await f(put, { method: "PUT", body: text("uploaded") });
      assert.ok(w.ok, `PUT ${w.status}`);
      eq(await store.get(k("signed-up")), text("uploaded"));
      // a URL for one key can't be bent to another
      const other = get.replace("/signed?", "/signed-up?");
      if (other !== get) assert.notEqual((await f(other)).status, 200, "a URL signed for one key opened another");
      if (opts.expiryWaitMs) {
        const short = await store.signedUrl(k("signed"), { method: "GET", expiresIn: 1 });
        await new Promise((res) => setTimeout(res, opts.expiryWaitMs));
        assert.notEqual((await f(short)).status, 200, "expired URL still works");
      }
    });
  });
}
