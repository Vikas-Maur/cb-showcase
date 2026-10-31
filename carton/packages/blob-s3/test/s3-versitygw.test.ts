// S3Client against a real S3 gateway (VersityGW, POSIX backend). VersityGW recomputes every SigV4 signature
// itself, so these tests check our signing independently of the AWS vectors in sigv4.test.ts.
//
// VersityGW differences from AWS S3 / R2 found while writing these (kept out of the assertions):
// - It rejects the region "auto" (400 AuthorizationHeaderMalformed); R2 expects "auto", AWS a real region.
// - Its POSIX backend folds "a//b" into "a/b" (the listing shows "a/b"); AWS and R2 keep "a//b" a distinct key.
// - It enforces the 5 MiB minimum for non-last parts at CompleteMultipartUpload (EntityTooSmall), as AWS does,
//   and checks it before whether the listed parts exist and match: a wrong ETag among small parts, or a
//   never-uploaded part listed after the small last one, reports EntityTooSmall rather than InvalidPart.
//   Which check AWS and R2 run first is not documented; callers should treat both codes as "fix the part list".
// - Its continuation tokens are the last key returned (AWS's are opaque); the client treats them as opaque.
// - It accepted a presigned URL whose X-Amz-Date was an hour in the future.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { S3Client, S3Error } from "../src/s3-client.ts";
import type { S3ClientOptions } from "../src/s3-client.ts";
import { createBucket, startVersityGw, versitygwMissingReason } from "./versitygw.ts";
import type { Gateway } from "./versitygw.ts";

const MiB = 1024 * 1024;
const BUCKET = "carton-blobs";
const missing = versitygwMissingReason();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

function streamOf(bytes: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
}

const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof S3Error, `expected S3Error, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

/** Status and S3 error code of a plain fetch response. */
async function fetchOutcome(url: string, init?: RequestInit): Promise<{ status: number; code: string | undefined; body: string }> {
  const res = await fetch(url, init);
  const body = await res.text();
  return { status: res.status, code: /<Code>([^<]*)<\/Code>/.exec(body)?.[1], body };
}

describe("S3Client against VersityGW", { skip: missing ?? false, timeout: 180_000 }, () => {
  let gateway: Gateway | undefined;

  const gw = (): Gateway => {
    if (gateway === undefined) throw new Error("gateway did not start");
    return gateway;
  };
  const client = (overrides: Partial<S3ClientOptions> = {}): S3Client =>
    new S3Client({
      endpoint: gw().endpoint,
      region: gw().region,
      bucket: BUCKET,
      credentials: gw().credentials,
      retryBaseDelayMs: 10,
      ...overrides,
    });

  before(async () => {
    gateway = await startVersityGw();
    await createBucket(gateway, BUCKET);
  });
  // Runs on failure too; the harness also SIGKILLs any gateway left at process exit.
  after(async () => {
    await gateway?.stop();
  });

  for (const payload of ["unsigned", "signed"] as const) {
    test(`put, head, get, list, delete (${payload} payload)`, async () => {
      const s3 = client({ payload });
      const key = `roundtrip/${payload}/clip.bin`;
      const bytes = randomBytes(64 * 1024 + 7);

      const put = await s3.putObject(key, bytes, { contentType: "application/x-carton" });
      assert.match(put.etag, /^"[0-9a-f]{32}"$/);

      const head = await s3.headObject(key);
      assert.ok(head);
      assert.equal(head.size, bytes.length);
      assert.equal(head.etag, put.etag);
      assert.equal(head.contentType, "application/x-carton");
      assert.ok(head.lastModified instanceof Date && !Number.isNaN(head.lastModified.getTime()));

      const got = await s3.getObject(key);
      assert.ok(got);
      assert.equal(got.size, bytes.length);
      assert.equal(got.etag, put.etag);
      assert.equal(got.range, undefined);
      assert.equal(sha256(await readAll(got.body)), sha256(bytes));

      // A stream body (always sent as UNSIGNED-PAYLOAD) with its length given up front.
      const streamed = randomBytes(200 * 1024 + 3);
      const streamPut = await s3.putObject(`${key}.stream`, streamOf(streamed), { contentLength: streamed.length });
      const streamGot = await s3.getObject(`${key}.stream`);
      assert.ok(streamGot);
      assert.equal(streamGot.etag, streamPut.etag);
      assert.equal(sha256(await readAll(streamGot.body)), sha256(streamed));

      const listed = await s3.listObjects(`roundtrip/${payload}/`);
      assert.deepEqual(
        listed.objects.map((o) => [o.key, o.size, o.etag]),
        [[key, bytes.length, put.etag], [`${key}.stream`, streamed.length, streamPut.etag]],
      );
      assert.equal(listed.next, undefined);

      await s3.deleteObject(key);
      await s3.deleteObject(`${key}.stream`);
      assert.equal(await s3.headObject(key), null);
      assert.equal(await s3.getObject(key), null);
      await s3.deleteObject(key); // deleting a missing key is not an error
    });
  }

  test("keys with spaces, +, %, reserved characters and unicode", async () => {
    const s3 = client({ payload: "signed" });
    const keys = [
      "special/dir a/b+c/100% done/ünï©ødé ✓ 😀.bin",
      "special/a&b=c?d#e;f,g:h@i$j",
      "special/x'y(z)*!~",
      "special/ leading and trailing ",
      "special/%2e%2e/%2F literal percent",
      "special/back\\slash",
      'special/q"uote<gt>&amp;',
      "special/tab\there",
    ];
    for (const key of keys) {
      const body = new TextEncoder().encode(`body of ${key}`);
      await s3.putObject(key, body);
      const got = await s3.getObject(key);
      assert.ok(got, key);
      assert.equal((await readAll(got.body)).toString("utf8"), `body of ${key}`);
      const presigned = await fetch(await s3.presign("GET", key, { expiresSeconds: 60 }));
      assert.equal(presigned.status, 200, key);
      assert.equal(await presigned.text(), `body of ${key}`);
    }
    const listed = await s3.listObjects("special/");
    assert.deepEqual(listed.objects.map((o) => o.key).sort(), [...keys].sort());
    for (const key of keys) await s3.deleteObject(key);
    assert.deepEqual((await s3.listObjects("special/")).objects, []);
  });

  test("ranged reads: start, middle, last byte, open-ended, suffix, past EOF", async () => {
    const s3 = client();
    const key = "ranges/object";
    const bytes = randomBytes(1000);
    await s3.putObject(key, bytes);

    const cases: Array<[Parameters<S3Client["getObject"]>[1], number, number]> = [
      [{ range: { offset: 0, length: 10 } }, 0, 10],
      [{ range: { offset: 500, length: 100 } }, 500, 100],
      [{ range: { offset: 999, length: 1 } }, 999, 1],
      [{ range: { offset: 990 } }, 990, 10],
      [{ range: { offset: 995, length: 100 } }, 995, 5], // clipped at the end of the object
      [{ range: { suffix: 10 } }, 990, 10],
      [{ range: { suffix: 5000 } }, 0, 1000], // a suffix longer than the object returns all of it
    ];
    for (const [options, offset, length] of cases) {
      const got = await s3.getObject(key, options);
      assert.ok(got);
      assert.equal(got.size, 1000, JSON.stringify(options));
      assert.deepEqual(got.range, { offset, length }, JSON.stringify(options));
      assert.deepEqual(await readAll(got.body), bytes.subarray(offset, offset + length), JSON.stringify(options));
    }
    await rejectsWith(s3.getObject(key, { range: { offset: 1000 } }), 416, "InvalidRange");
    await rejectsWith(s3.getObject(key, { range: { offset: 5000, length: 1 } }), 416, "InvalidRange");
    assert.equal(await s3.getObject("ranges/missing", { range: { offset: 0, length: 1 } }), null);
  });

  test("listObjects pages with continuation tokens", async () => {
    const s3 = client();
    const keys = ["pages/a", "pages/b", "pages/c", "pages/d", "pages/e"];
    for (const key of keys) await s3.putObject(key, new Uint8Array([1]));
    await s3.putObject("pagesX/not-in-prefix", new Uint8Array([1]));

    const seen: string[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      const page = await s3.listObjects("pages/", { maxKeys: 2, continuationToken: token });
      assert.ok(page.objects.length <= 2);
      seen.push(...page.objects.map((o) => o.key));
      token = page.next;
      pages++;
    } while (token !== undefined);
    assert.deepEqual(seen, keys);
    assert.equal(pages, 3);
  });

  for (const payload of ["signed", "unsigned"] as const) {
    test(`multipart: parts out of order, resume from listParts, complete (${payload} payload)`, async () => {
      const s3 = client({ payload });
      const key = `multipart/${payload}/clip ✓ 1.mp4`;
      // S3 needs every part but the last to be at least 5 MiB (VersityGW enforces it too).
      const p1 = randomBytes(5 * MiB);
      const p2 = randomBytes(5 * MiB);
      const p3 = randomBytes(1234);
      const whole = Buffer.concat([p1, p2, p3]);

      const uploadId = await s3.createMultipartUpload(key, { contentType: "video/mp4" });
      const e3 = await s3.uploadPart(key, uploadId, 3, p3);
      const e1 = await s3.uploadPart(key, uploadId, 1, p1);

      // An uploader that restarts learns what the server already has, then sends only the rest.
      let listed = await s3.listParts(key, uploadId);
      assert.deepEqual(listed.map((p) => [p.partNumber, p.size, p.etag]), [[1, p1.length, e1.etag], [3, p3.length, e3.etag]]);
      const e2 = await s3.uploadPart(key, uploadId, 2, streamOf(p2), { contentLength: p2.length });
      listed = await s3.listParts(key, uploadId);
      assert.deepEqual(
        listed.map((p) => [p.partNumber, p.size, p.etag]),
        [[1, p1.length, e1.etag], [2, p2.length, e2.etag], [3, p3.length, e3.etag]],
      );
      assert.equal(await s3.headObject(key), null, "nothing is visible before completion");

      // A wrong ETag or an unknown part fails, and leaves the upload intact.
      await rejectsWith(
        s3.completeMultipartUpload(key, uploadId, [{ partNumber: 1, etag: '"00000000000000000000000000000000"' }, listed[1], listed[2]]),
        400,
        "InvalidPart",
      );
      // Part 4 was never uploaded. It replaces part 3 rather than following it: a small part 3 that is no
      // longer last trips VersityGW's size check first (EntityTooSmall), which would hide what we test here.
      await rejectsWith(
        s3.completeMultipartUpload(key, uploadId, [listed[0], listed[1], { partNumber: 4, etag: e3.etag }]),
        400,
        "InvalidPart",
      );

      // Parts given in any order and with unquoted ETags: the client sorts and normalises them.
      const done = await s3.completeMultipartUpload(key, uploadId, [
        { partNumber: 3, etag: e3.etag },
        { partNumber: 1, etag: e1.etag.slice(1, -1) },
        { partNumber: 2, etag: e2.etag },
      ]);
      assert.match(done.etag, /^"[0-9a-f]{32}-3"$/);

      const head = await s3.headObject(key);
      assert.ok(head);
      assert.equal(head.size, whole.length);
      assert.equal(head.etag, done.etag);
      assert.equal(head.contentType, "video/mp4");

      const got = await s3.getObject(key);
      assert.ok(got);
      assert.equal(sha256(await readAll(got.body)), sha256(whole));

      const across = await s3.getObject(key, { range: { offset: 5 * MiB - 3, length: 6 } });
      assert.ok(across);
      assert.deepEqual(await readAll(across.body), whole.subarray(5 * MiB - 3, 5 * MiB + 3));

      await rejectsWith(s3.listParts(key, uploadId), 404, "NoSuchUpload");
      await s3.deleteObject(key);
    });
  }

  test("multipart: abort frees the upload, and aborting again is fine", async () => {
    const s3 = client();
    const key = "multipart/aborted.bin";
    const uploadId = await s3.createMultipartUpload(key);
    await s3.uploadPart(key, uploadId, 1, randomBytes(4096));
    assert.equal((await s3.listParts(key, uploadId)).length, 1);
    await s3.abortMultipartUpload(key, uploadId);
    await rejectsWith(s3.listParts(key, uploadId), 404, "NoSuchUpload");
    await rejectsWith(s3.uploadPart(key, uploadId, 2, new Uint8Array(1)), 404, "NoSuchUpload");
    await s3.abortMultipartUpload(key, uploadId);
    assert.equal(await s3.headObject(key), null);
  });

  test("presigned GET and PUT work with a plain fetch", async () => {
    const s3 = client();
    const key = "presigned/ü file+1.txt";
    await s3.putObject(key, new TextEncoder().encode("read me"));
    const get = await fetchOutcome(await s3.presign("GET", key, { expiresSeconds: 60 }));
    assert.equal(get.status, 200);
    assert.equal(get.body, "read me");

    const target = "presigned/uploaded by url.bin";
    const bytes = randomBytes(10_000);
    const put = await fetch(await s3.presign("PUT", target, { expiresSeconds: 60 }), { method: "PUT", body: bytes });
    await put.arrayBuffer();
    assert.equal(put.status, 200);
    const got = await s3.getObject(target);
    assert.ok(got);
    assert.deepEqual(await readAll(got.body), bytes);
  });

  test("presigned URLs that are expired or tampered with are rejected", async () => {
    const s3 = client();
    const key = "presigned/guarded.txt";
    await s3.putObject(key, new TextEncoder().encode("secret"));

    const expired = await s3.presign("GET", key, { expiresSeconds: 60, datetime: new Date(Date.now() - 2 * 3600_000) });
    const expiredOutcome = await fetchOutcome(expired);
    assert.equal(expiredOutcome.status, 403);
    assert.equal(expiredOutcome.code, "AccessDenied");
    assert.match(expiredOutcome.body, /expired/i);

    const url = await s3.presign("GET", key, { expiresSeconds: 60 });
    const flipped = url.replace(/(X-Amz-Signature=)([0-9a-f])/, (_m, p: string, c: string) => p + (c === "0" ? "1" : "0"));
    const otherKey = url.replace("guarded.txt", "guarded.txs");
    const longer = url.replace("X-Amz-Expires=60", "X-Amz-Expires=600");
    for (const tampered of [flipped, otherKey, longer]) {
      assert.notEqual(tampered, url);
      const outcome = await fetchOutcome(tampered);
      assert.equal(outcome.status, 403, tampered);
      assert.equal(outcome.code, "SignatureDoesNotMatch", tampered);
    }
    // A presigned GET does not authorise a PUT to the same key.
    const asPut = await fetchOutcome(url, { method: "PUT", body: "overwrite" });
    assert.equal(asPut.status, 403);
  });

  test("a wrong secret fails with 403 SignatureDoesNotMatch", async () => {
    const good = client();
    await good.putObject("auth/object", new Uint8Array([1, 2, 3]));
    for (const payload of ["signed", "unsigned"] as const) {
      const bad = client({ payload, credentials: { ...gw().credentials, secretAccessKey: "not-the-secret" } });
      await rejectsWith(bad.putObject("auth/object", new Uint8Array([9])), 403, "SignatureDoesNotMatch");
      await rejectsWith(bad.getObject("auth/object"), 403, "SignatureDoesNotMatch");
      await rejectsWith(bad.listObjects("auth/"), 403, "SignatureDoesNotMatch");
      // HEAD responses have no body, so only the status is known.
      await rejectsWith(bad.headObject("auth/object"), 403, "Forbidden");
      const presigned = await fetchOutcome(await bad.presign("GET", "auth/object", { expiresSeconds: 60 }));
      assert.equal(presigned.status, 403);
      assert.equal(presigned.code, "SignatureDoesNotMatch");
    }
    const unknownKeyId = client({ credentials: { accessKeyId: "NOSUCHKEY", secretAccessKey: "x" } });
    await assert.rejects(unknownKeyId.getObject("auth/object"), (e: unknown) => e instanceof S3Error && e.status === 403);
    // The good client's object was not overwritten by any of the rejected writes.
    const got = await good.getObject("auth/object");
    assert.ok(got);
    assert.deepEqual([...(await readAll(got.body))], [1, 2, 3]);
  });

  test("a missing bucket is an error, not a missing object", async () => {
    const s3 = client({ bucket: "no-such-bucket" });
    await rejectsWith(s3.getObject("k"), 404, "NoSuchBucket");
    await rejectsWith(s3.deleteObject("k"), 404, "NoSuchBucket");
    await rejectsWith(s3.listObjects(""), 404, "NoSuchBucket");
    // HEAD cannot tell the two apart: there is no body to read the code from.
    assert.equal(await s3.headObject("k"), null);
  });
});
