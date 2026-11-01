// S3Client and the XML reader against a scripted fake fetch: request shape, retries, error mapping, ranges,
// pagination and ETag normalisation, without a server.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { S3Client, S3Error, normalizeEtag } from "../src/s3-client.ts";
import type { FetchLike, S3ClientOptions, S3FetchInit } from "../src/s3-client.ts";
import { UNSIGNED_PAYLOAD } from "../src/sigv4.ts";
import {
  buildCompleteMultipartUpload,
  decodeXmlEntities,
  escapeXml,
  parseErrorXml,
  parseListObjectsV2,
  parseListParts,
  parseXml,
} from "../src/xml.ts";

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
  duplex: string | undefined;
}

type Reply = Response | Error | ((call: Call) => Response | Error);

/** A fetch that records each request (reading stream bodies) and answers from a script, in order. */
function scripted(...replies: Reply[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url: string, init: S3FetchInit) => {
    let body: Uint8Array | undefined;
    if (init.body instanceof Uint8Array) body = init.body;
    else if (init.body instanceof ReadableStream) body = new Uint8Array(await new Response(init.body).arrayBuffer());
    const call: Call = {
      url: new URL(url),
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      body,
      duplex: init.duplex,
    };
    calls.push(call);
    if (init.signal?.aborted) throw init.signal.reason;
    let reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (typeof reply === "function") reply = reply(call);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { fetch, calls };
}

function makeClient(fetch: FetchLike, overrides: Partial<S3ClientOptions> = {}): S3Client {
  return new S3Client({
    endpoint: "https://acct.r2.example.com",
    bucket: "bkt",
    credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
    fetch,
    retryBaseDelayMs: 1,
    ...overrides,
  });
}

const xml = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { "content-type": "application/xml", ...headers } });
const errorXml = (status: number, code: string, message = code, requestId = "REQ1"): Response =>
  xml(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>${requestId}</RequestId></Error>`, status);
const empty = (status = 200, headers: Record<string, string> = {}): Response =>
  new Response(status === 204 ? null : "", { status, headers });

async function rejectsWith(promise: Promise<unknown>, status: number, code: string): Promise<S3Error> {
  let caught: S3Error | undefined;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof S3Error, `expected S3Error, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    assert.equal(error.code, code, error.message);
    caught = error;
    return true;
  });
  return caught as S3Error;
}

describe("request shape", () => {
  test("path-style URLs encode the key once and keep its slashes", async () => {
    const { fetch, calls } = scripted(empty(200, { etag: '"e"' }));
    await makeClient(fetch).putObject("dir a/b+c/100%/ü ✓", new Uint8Array([1]));
    assert.equal(calls[0].url.href, "https://acct.r2.example.com/bkt/dir%20a/b%2Bc/100%25/%C3%BC%20%E2%9C%93");
    assert.match(calls[0].headers.authorization, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  test("virtual-hosted URLs and endpoint path prefixes", async () => {
    const { fetch, calls } = scripted(empty(200, { etag: '"e"' }), xml("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"));
    const s3 = makeClient(fetch, { endpoint: "https://s3.example.com/proxy/", forcePathStyle: false, region: "eu-west-1" });
    await s3.putObject("k/v", new Uint8Array([1]));
    await s3.listObjects("p/");
    assert.equal(calls[0].url.href, "https://bkt.s3.example.com/proxy/k/v");
    assert.equal(calls[1].url.href, "https://bkt.s3.example.com/proxy/?list-type=2&prefix=p%2F");
    assert.match(calls[0].headers.authorization, /\/eu-west-1\/s3\/aws4_request/);
  });

  test("unsigned payload by default, SHA-256 of the body when signed", async () => {
    const body = new TextEncoder().encode("payload");
    const unsigned = scripted(empty(200, { etag: '"e"' }));
    await makeClient(unsigned.fetch).putObject("k", body);
    assert.equal(unsigned.calls[0].headers["x-amz-content-sha256"], UNSIGNED_PAYLOAD);

    const signed = scripted(empty(200, { etag: '"e"' }), new Response("x", { headers: { etag: '"e"' } }));
    const s3 = makeClient(signed.fetch, { payload: "signed" });
    await s3.putObject("k", body);
    assert.equal(signed.calls[0].headers["x-amz-content-sha256"], createHash("sha256").update(body).digest("hex"));
    await s3.getObject("k");
    assert.equal(signed.calls[1].headers["x-amz-content-sha256"], createHash("sha256").update("").digest("hex"));
  });

  test("stream bodies: unsigned, half duplex, explicit content-length, length required", async () => {
    const { fetch, calls } = scripted(empty(200, { etag: '"e"' }));
    const s3 = makeClient(fetch, { payload: "signed" });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        c.enqueue(new Uint8Array([3]));
        c.close();
      },
    });
    await s3.putObject("k", stream, { contentLength: 3, contentType: "video/mp4" });
    assert.equal(calls[0].headers["x-amz-content-sha256"], UNSIGNED_PAYLOAD);
    assert.equal(calls[0].headers["content-length"], "3");
    assert.equal(calls[0].headers["content-type"], "video/mp4");
    assert.match(calls[0].headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/);
    assert.equal(calls[0].duplex, "half");
    assert.deepEqual([...(calls[0].body ?? [])], [1, 2, 3]);

    await assert.rejects(s3.putObject("k", new ReadableStream<Uint8Array>()), /needs contentLength/);
    await assert.rejects(s3.putObject("k", new Uint8Array(2), { contentLength: 3 }), RangeError);
    assert.equal(calls.length, 1);
  });

  test("session tokens are sent and signed", async () => {
    const { fetch, calls } = scripted(empty(204));
    await makeClient(fetch, { credentials: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "TOK" } }).deleteObject("k");
    assert.equal(calls[0].headers["x-amz-security-token"], "TOK");
    assert.match(calls[0].headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
  });

  test("keys that URLs cannot carry are refused before any request", async () => {
    const { fetch, calls } = scripted(empty());
    const s3 = makeClient(fetch);
    for (const key of ["", ".", "..", "a/./b", "a/../b", "\uD800lone"]) {
      await assert.rejects(s3.getObject(key), TypeError, JSON.stringify(key));
      await assert.rejects(s3.presign("GET", key, { expiresSeconds: 60 }), TypeError, JSON.stringify(key));
    }
    assert.equal(calls.length, 0);
  });

  test("argument validation", async () => {
    const { fetch, calls } = scripted(empty());
    const s3 = makeClient(fetch);
    await assert.rejects(s3.getObject("k", { range: { offset: -1 } }), RangeError);
    await assert.rejects(s3.getObject("k", { range: { offset: 0, length: 0 } }), RangeError);
    await assert.rejects(s3.getObject("k", { range: { suffix: 0 } }), RangeError);
    await assert.rejects(s3.uploadPart("k", "u", 0, new Uint8Array(1)), RangeError);
    await assert.rejects(s3.uploadPart("k", "u", 10001, new Uint8Array(1)), RangeError);
    await assert.rejects(s3.listObjects("", { maxKeys: 1001 }), RangeError);
    await assert.rejects(s3.completeMultipartUpload("k", "u", []), TypeError);
    await assert.rejects(s3.completeMultipartUpload("k", "u", [{ partNumber: 1, etag: "a" }, { partNumber: 1, etag: "b" }]), /listed twice/);
    await assert.rejects(s3.completeMultipartUpload("k", "u", [{ partNumber: 1, etag: "" }]), /no ETag/);
    assert.throws(() => new S3Client({ endpoint: "http://h?x=1", bucket: "b", credentials: { accessKeyId: "a", secretAccessKey: "s" } }), TypeError);
    assert.throws(() => makeClient(fetch, { retries: -1 }), RangeError);
    assert.equal(calls.length, 0);
  });
});

describe("retries", () => {
  test("idempotent requests retry 5xx, 429 and network errors, re-signing each attempt", async () => {
    const { fetch, calls } = scripted(
      errorXml(503, "SlowDown"),
      new TypeError("fetch failed"),
      errorXml(429, "TooManyRequests"),
      new Response("data", { headers: { etag: '"e"', "content-length": "4" } }),
    );
    const got = await makeClient(fetch, { retries: 3 }).getObject("k");
    assert.ok(got);
    assert.equal(await new Response(got.body).text(), "data");
    assert.equal(calls.length, 4);
    for (const call of calls) assert.ok(call.headers.authorization);
  });

  test("gives up after the configured retries and reports the last error", async () => {
    const { fetch, calls } = scripted(errorXml(500, "InternalError", "boom", "R1"), errorXml(500, "InternalError", "boom", "R2"));
    const error = await rejectsWith(makeClient(fetch, { retries: 1 }).headObject("k"), 500, "Http500");
    assert.equal(calls.length, 2);
    assert.equal(error.requestId, undefined);

    const net = scripted(new TypeError("socket hang up"));
    const netError = await rejectsWith(makeClient(net.fetch, { retries: 2 }).deleteObject("k"), 0, "NetworkError");
    assert.equal(net.calls.length, 3);
    assert.ok(netError.cause instanceof TypeError);
  });

  test("retries: 0 sends once", async () => {
    const { fetch, calls } = scripted(errorXml(503, "SlowDown"));
    await rejectsWith(makeClient(fetch, { retries: 0 }).getObject("k"), 503, "SlowDown");
    assert.equal(calls.length, 1);
  });

  test("non-idempotent calls and stream bodies are never retried", async () => {
    const create = scripted(errorXml(500, "InternalError"));
    await rejectsWith(makeClient(create.fetch).createMultipartUpload("k"), 500, "InternalError");
    assert.equal(create.calls.length, 1);

    const complete = scripted(new TypeError("fetch failed"));
    await rejectsWith(makeClient(complete.fetch).completeMultipartUpload("k", "u", [{ partNumber: 1, etag: '"a"' }]), 0, "NetworkError");
    assert.equal(complete.calls.length, 1);

    const stream = scripted(errorXml(503, "SlowDown"));
    const body = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    await rejectsWith(makeClient(stream.fetch).uploadPart("k", "u", 1, body, { contentLength: 0 }), 503, "SlowDown");
    assert.equal(stream.calls.length, 1);
  });

  test("byte-bodied parts and 4xx: parts retry, client errors do not", async () => {
    const part = scripted(errorXml(502, "BadGateway"), empty(200, { etag: '"p1"' }));
    assert.deepEqual(await makeClient(part.fetch).uploadPart("k", "u", 1, new Uint8Array(3)), { etag: '"p1"' });
    assert.equal(part.calls.length, 2);
    assert.deepEqual(part.calls[0].body, part.calls[1].body);
    assert.equal(part.calls[1].url.search, "?partNumber=1&uploadId=u");

    const denied = scripted(errorXml(403, "AccessDenied"));
    await rejectsWith(makeClient(denied.fetch).getObject("k"), 403, "AccessDenied");
    assert.equal(denied.calls.length, 1);
  });

  test("an aborted signal stops at once and is not wrapped", async () => {
    const { fetch, calls } = scripted(errorXml(503, "SlowDown"));
    const controller = new AbortController();
    controller.abort(new Error("caller gave up"));
    await assert.rejects(makeClient(fetch).getObject("k", { signal: controller.signal }), /caller gave up/);
    assert.equal(calls.length, 1);
  });
});

describe("responses", () => {
  test("errors carry status, code, message and request id", async () => {
    const { fetch } = scripted(errorXml(403, "SignatureDoesNotMatch", "bad sig", "XMLREQ"));
    const error = await rejectsWith(makeClient(fetch).putObject("k", new Uint8Array(1)), 403, "SignatureDoesNotMatch");
    assert.equal(error.message, "SignatureDoesNotMatch: bad sig");
    assert.equal(error.requestId, "XMLREQ");
    assert.equal(error.name, "S3Error");

    const header = scripted(new Response("<html>gateway</html>", { status: 502, statusText: "Bad Gateway", headers: { "x-amz-request-id": "HDR" } }));
    const proxyError = await rejectsWith(makeClient(header.fetch, { retries: 0 }).getObject("k"), 502, "Http502");
    assert.equal(proxyError.requestId, "HDR");
    assert.match(proxyError.message, /Bad Gateway/);
  });

  test("getObject: 404 is null, a missing bucket throws, 416 is a clear error", async () => {
    const { fetch } = scripted(errorXml(404, "NoSuchKey"), errorXml(404, "NoSuchBucket"), errorXml(416, "InvalidRange"));
    const s3 = makeClient(fetch);
    assert.equal(await s3.getObject("k"), null);
    await rejectsWith(s3.getObject("k"), 404, "NoSuchBucket");
    const error = await rejectsWith(s3.getObject("k", { range: { offset: 100 } }), 416, "InvalidRange");
    assert.match(error.message, /bytes from 100.*not satisfiable/);

    const withSize = scripted(new Response("", { status: 416, headers: { "content-range": "bytes */42" } }));
    const sized = await rejectsWith(makeClient(withSize.fetch).getObject("k", { range: { offset: 50, length: 2 } }), 416, "InvalidRange");
    assert.match(sized.message, /object size 42/);
  });

  test("getObject: ranges map to Range headers and Content-Range back to offset, length and size", async () => {
    const partial = (range: string): Response =>
      new Response("abc", { status: 206, headers: { "content-range": range, etag: "unquoted", "content-type": "video/mp4" } });
    const { fetch, calls } = scripted(partial("bytes 10-12/100"), partial("bytes 97-99/100"), partial("bytes 5-7/8"));
    const s3 = makeClient(fetch);

    const a = await s3.getObject("k", { range: { offset: 10, length: 3 } });
    assert.ok(a);
    assert.deepEqual({ size: a.size, range: a.range, etag: a.etag, contentType: a.contentType }, {
      size: 100, range: { offset: 10, length: 3 }, etag: '"unquoted"', contentType: "video/mp4",
    });
    assert.equal(await new Response(a.body).text(), "abc");
    assert.equal(calls[0].headers.range, "bytes=10-12");
    assert.match(calls[0].headers.authorization, /SignedHeaders=host;range;/);

    const b = await s3.getObject("k", { range: { suffix: 3 } });
    assert.deepEqual(b?.range, { offset: 97, length: 3 });
    assert.equal(calls[1].headers.range, "bytes=-3");

    const c = await s3.getObject("k", { range: { offset: 5 } });
    assert.deepEqual([c?.size, c?.range], [8, { offset: 5, length: 3 }]);
    assert.equal(calls[2].headers.range, "bytes=5-");
  });

  test("getObject: a server that ignores Range is accepted only when the range covered everything", async () => {
    const whole = (): Response => new Response("abcd", { status: 200, headers: { "content-length": "4", etag: '"e"' } });
    const { fetch } = scripted(whole(), whole(), whole());
    const s3 = makeClient(fetch);
    const all = await s3.getObject("k", { range: { offset: 0, length: 10 } });
    assert.deepEqual([all?.size, all?.range], [4, { offset: 0, length: 4 }]);
    const suffix = await s3.getObject("k", { range: { suffix: 4 } });
    assert.deepEqual(suffix?.range, { offset: 0, length: 4 });
    await rejectsWith(s3.getObject("k", { range: { offset: 1, length: 2 } }), 200, "RangeNotHonoured");
  });

  test("headObject parses metadata; 404 is null", async () => {
    const { fetch, calls } = scripted(
      empty(200, { "content-length": "1234", etag: '"abc"', "content-type": "image/png", "last-modified": "Fri, 24 May 2013 00:00:00 GMT", "x-amz-meta-carton-sha256": "ab12" }),
      empty(404),
    );
    const s3 = makeClient(fetch);
    assert.deepEqual(await s3.headObject("k"), {
      size: 1234, etag: '"abc"', contentType: "image/png", lastModified: new Date(Date.UTC(2013, 4, 24)), metadata: { "carton-sha256": "ab12" },
    });
    assert.equal(await s3.headObject("k"), null);
    assert.equal(calls[0].method, "HEAD");
  });

  test("deleteObject and abort treat missing as done, but not a missing bucket", async () => {
    const { fetch } = scripted(empty(204), errorXml(404, "NoSuchKey"), errorXml(404, "NoSuchUpload"), errorXml(404, "NoSuchBucket"));
    const s3 = makeClient(fetch);
    await s3.deleteObject("k");
    await s3.deleteObject("k");
    await s3.abortMultipartUpload("k", "u");
    await rejectsWith(s3.abortMultipartUpload("k", "u"), 404, "NoSuchBucket");
  });

  test("listObjects returns a page and the next token; keys are decoded exactly", async () => {
    const { fetch, calls } = scripted(
      xml(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bkt</Name><Prefix>p/</Prefix><KeyCount>2</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>true</IsTruncated>
  <Contents><Key>p/a &amp; b </Key><LastModified>2026-10-31T00:00:00.000Z</LastModified><ETag>&quot;e1&quot;</ETag><Size>5</Size><StorageClass>STANDARD</StorageClass></Contents>
  <Contents><Key>p/&#x1F600;&#233;</Key><ETag>e2</ETag><Size>0</Size></Contents>
  <NextContinuationToken>tok+/=</NextContinuationToken>
</ListBucketResult>`),
      xml(`<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`),
    );
    const s3 = makeClient(fetch);
    const page = await s3.listObjects("p/", { maxKeys: 2 });
    assert.deepEqual(page, {
      objects: [{ key: "p/a & b ", size: 5, etag: '"e1"' }, { key: "p/😀é", size: 0, etag: '"e2"' }],
      next: "tok+/=",
    });
    const last = await s3.listObjects("p/", { continuationToken: page.next });
    assert.deepEqual(last, { objects: [] });
    assert.equal(calls[0].url.search, "?list-type=2&prefix=p%2F&max-keys=2");
    assert.equal(calls[1].url.search, "?list-type=2&prefix=p%2F&continuation-token=tok%2B%2F%3D");
    assert.equal(calls[1].url.pathname, "/bkt");
  });

  test("multipart: create, list parts across pages, complete with sorted and quoted ETags", async () => {
    const page = (parts: string, truncated: boolean, next?: number): Response =>
      xml(`<ListPartsResult><IsTruncated>${truncated}</IsTruncated>${next === undefined ? "" : `<NextPartNumberMarker>${next}</NextPartNumberMarker>`}${parts}</ListPartsResult>`);
    const part = (n: number, etag: string, size: number): string => `<Part><PartNumber>${n}</PartNumber><ETag>${etag}</ETag><Size>${size}</Size></Part>`;
    const { fetch, calls } = scripted(
      xml(`<InitiateMultipartUploadResult><Bucket>bkt</Bucket><Key>k</Key><UploadId>up/1+x</UploadId></InitiateMultipartUploadResult>`),
      page(part(1, "&quot;a&quot;", 5) + part(2, "b", 5), true, 2),
      page(part(4, '"d"', 1), false),
      xml(`\n   \n<?xml version="1.0"?><CompleteMultipartUploadResult><Location>x</Location><Bucket>bkt</Bucket><Key>k</Key><ETag>"m-3"</ETag></CompleteMultipartUploadResult>`),
    );
    const s3 = makeClient(fetch);
    const uploadId = await s3.createMultipartUpload("k", { contentType: "video/mp4" });
    assert.equal(uploadId, "up/1+x");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url.search, "?uploads");
    assert.equal(calls[0].headers["content-type"], "video/mp4");

    const parts = await s3.listParts("k", uploadId);
    assert.deepEqual(parts, [
      { partNumber: 1, etag: '"a"', size: 5 },
      { partNumber: 2, etag: '"b"', size: 5 },
      { partNumber: 4, etag: '"d"', size: 1 },
    ]);
    assert.equal(calls[1].url.search, "?uploadId=up%2F1%2Bx");
    assert.equal(calls[2].url.search, "?uploadId=up%2F1%2Bx&part-number-marker=2");

    const done = await s3.completeMultipartUpload("k", uploadId, [parts[2], { partNumber: 1, etag: "a" }, parts[1]]);
    assert.deepEqual(done, { etag: '"m-3"' });
    assert.equal(
      new TextDecoder().decode(calls[3].body),
      '<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        "<Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part>" +
        "<Part><PartNumber>2</PartNumber><ETag>&quot;b&quot;</ETag></Part>" +
        "<Part><PartNumber>4</PartNumber><ETag>&quot;d&quot;</ETag></Part></CompleteMultipartUpload>",
    );
    assert.equal(calls[3].headers["content-type"], "application/xml");
  });

  test("listParts refuses a pagination marker that does not move", async () => {
    const stuck = (): Response =>
      xml(`<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker><Part><PartNumber>1</PartNumber><ETag>"a"</ETag><Size>1</Size></Part></ListPartsResult>`);
    const { fetch, calls } = scripted(stuck);
    await rejectsWith(makeClient(fetch).listParts("k", "u"), 200, "InvalidResponse");
    assert.equal(calls.length, 2);
  });

  test("CompleteMultipartUpload: a 200 carrying <Error> is an error", async () => {
    const { fetch, calls } = scripted(
      xml(`\n\n<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message><RequestId>R9</RequestId></Error>`),
    );
    const error = await rejectsWith(makeClient(fetch).completeMultipartUpload("k", "u", [{ partNumber: 1, etag: '"a"' }]), 200, "InternalError");
    assert.equal(error.requestId, "R9");
    assert.equal(calls.length, 1);
  });

  test("presign uses the client's addressing, region and credentials", async () => {
    const { fetch } = scripted(empty());
    const s3 = makeClient(fetch, { credentials: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "T" } });
    const url = new URL(await s3.presign("PUT", "a b/c+d", { expiresSeconds: 300, datetime: new Date(Date.UTC(2026, 9, 31)) }));
    assert.equal(url.origin + url.pathname, "https://acct.r2.example.com/bkt/a%20b/c%2Bd");
    assert.equal(url.searchParams.get("X-Amz-Credential"), "AK/20261031/auto/s3/aws4_request");
    assert.equal(url.searchParams.get("X-Amz-Date"), "20261031T000000Z");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
    assert.equal(url.searchParams.get("X-Amz-Security-Token"), "T");
    await assert.rejects(s3.presign("GET", "k", { expiresSeconds: 0 }), RangeError);
  });

  test("normalizeEtag", () => {
    assert.equal(normalizeEtag('"abc"'), '"abc"');
    assert.equal(normalizeEtag(" abc "), '"abc"');
    assert.equal(normalizeEtag('W/"abc"'), 'W/"abc"');
    assert.equal(normalizeEtag(null), "");
  });
});

describe("xml", () => {
  test("entities, character references, CDATA, comments and namespace prefixes", () => {
    assert.equal(decodeXmlEntities("&lt;&gt;&amp;&quot;&apos;&#65;&#x42;&#X1F600;&unknown;"), `<>&"'AB😀&unknown;`);
    assert.equal(decodeXmlEntities("&#0;&#x110000;"), "��");
    assert.equal(escapeXml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
    const root = parseXml(`<?xml version="1.0"?><!-- lead --><s3:Root xmlns:s3="urn:x" attr="a>b"><s3:Key><![CDATA[<raw &amp;>]]> &amp; more</s3:Key><Empty/><Empty /></s3:Root>`);
    assert.equal(root.name, "Root");
    assert.deepEqual(root.children.map((c) => c.name), ["Key", "Empty", "Empty"]);
    assert.equal(root.children[0].text, "<raw &amp;> & more");
  });

  test("refuses DTDs and malformed documents", () => {
    assert.throws(() => parseXml(`<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>`), /DTDs are not accepted/);
    for (const bad of ["", "text only", "<a>", "<a></b>", "<a/><b/>", "<a><!-- x </a>", "<a attr='x></a>"]) {
      assert.throws(() => parseXml(bad), SyntaxError, bad);
    }
    assert.equal(parseErrorXml("<html>not s3</html>"), null);
    assert.equal(parseErrorXml("not xml <"), null);
  });

  test("S3 documents", () => {
    assert.deepEqual(parseErrorXml(`<Error><Code>NoSuchKey</Code><Message>gone</Message><Resource>/b/k</Resource><RequestId>R</RequestId></Error>`), {
      code: "NoSuchKey", message: "gone", requestId: "R", resource: "/b/k",
    });
    assert.deepEqual(parseListParts(`<ListPartsResult><IsTruncated>false</IsTruncated><NextPartNumberMarker></NextPartNumberMarker></ListPartsResult>`), {
      parts: [], isTruncated: false, nextPartNumberMarker: undefined,
    });
    assert.throws(() => parseListParts(`<ListPartsResult><Part><PartNumber>x</PartNumber><ETag>e</ETag><Size>1</Size></Part></ListPartsResult>`), /not an integer/);
    assert.throws(() => parseListObjectsV2(`<ListAllMyBucketsResult/>`), /expected <ListBucketResult>/);
    assert.equal(
      buildCompleteMultipartUpload([{ partNumber: 1, etag: '"a&b"' }]),
      '<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        "<Part><PartNumber>1</PartNumber><ETag>&quot;a&amp;b&quot;</ETag></Part></CompleteMultipartUpload>",
    );
  });
});
