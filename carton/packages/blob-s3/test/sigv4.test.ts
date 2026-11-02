// SigV4 against AWS's published examples. Every expected value below is copied from the cited AWS document;
// none was produced by this code. Each canonical request is also hashed here with node:crypto, which checks
// the quoted canonical request and its quoted hash against each other independently of sigv4.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  EMPTY_SHA256,
  UNSIGNED_PAYLOAD,
  encodeRfc3986,
  encodeS3Path,
  explainSignRequest,
  presignUrl,
  sha256Hex,
  signRequest,
  toAmzDate,
} from "../src/sigv4.ts";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// Source: AWS "Signature Version 4 test suite" (aws-sig-v4-test-suite.zip), case get-vanilla:
// get-vanilla.creq, get-vanilla.sts, get-vanilla.authz.
test("AWS SigV4 test suite: get-vanilla", async () => {
  const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const creq = [
    "GET",
    "/",
    "",
    "host:example.amazonaws.com",
    "x-amz-date:20150830T123600Z",
    "",
    "host;x-amz-date",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ].join("\n");
  assert.equal(sha256(creq), "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");

  const out = await explainSignRequest({
    method: "GET",
    url: "https://example.amazonaws.com/",
    credentials,
    region: "us-east-1",
    service: "service",
    datetime: "20150830T123600Z",
  });
  assert.equal(out.canonicalRequest, creq);
  assert.equal(
    out.stringToSign,
    "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n" +
      "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
  );
  assert.equal(
    out.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
  // A generic service gets no x-amz-content-sha256 header (the vector does not sign one).
  assert.equal(out.headers["x-amz-content-sha256"], undefined);
});

// Source for the four S3 cases: Amazon S3 API reference, "Signature Calculations for the Authorization Header:
// Transferring Payload in a Single Chunk (AWS Signature Version 4)" (sig-v4-header-based-auth.html), section
// "Examples: Signature Calculations". Bucket examplebucket, us-east-1, 20130524T000000Z.
const s3Credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const s3Base = { credentials: s3Credentials, region: "us-east-1", service: "s3", datetime: "20130524T000000Z" };
const s3Scope = "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request";

test("S3 docs: GET object with Range", async () => {
  const creq = [
    "GET",
    "/test.txt",
    "",
    "host:examplebucket.s3.amazonaws.com",
    "range:bytes=0-9",
    "x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "x-amz-date:20130524T000000Z",
    "",
    "host;range;x-amz-content-sha256;x-amz-date",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ].join("\n");
  assert.equal(sha256(creq), "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972");

  // The doc's request has a trailing space after the Range value: values are trimmed before signing.
  const out = await explainSignRequest({
    ...s3Base,
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    headers: { Range: "bytes=0-9 " },
  });
  assert.equal(out.canonicalRequest, creq);
  assert.equal(
    out.headers.authorization,
    `AWS4-HMAC-SHA256 Credential=${s3Scope}, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ` +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  assert.equal(out.headers["x-amz-content-sha256"], EMPTY_SHA256);
  assert.equal(out.headers["x-amz-date"], "20130524T000000Z");
});

test("S3 docs: PUT object", async () => {
  const body = new TextEncoder().encode("Welcome to Amazon S3.");
  const bodyHash = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";
  assert.equal(createHash("sha256").update(body).digest("hex"), bodyHash);
  assert.equal(await sha256Hex(body), bodyHash);

  const creq = [
    "PUT",
    "/test%24file.text",
    "",
    "date:Fri, 24 May 2013 00:00:00 GMT",
    "host:examplebucket.s3.amazonaws.com",
    `x-amz-content-sha256:${bodyHash}`,
    "x-amz-date:20130524T000000Z",
    "x-amz-storage-class:REDUCED_REDUNDANCY",
    "",
    "date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class",
    bodyHash,
  ].join("\n");
  assert.equal(sha256(creq), "9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d");

  // The doc sends the key raw (`test$file.text`) and signs it encoded once: the canonical URI re-encodes.
  const out = await explainSignRequest({
    ...s3Base,
    method: "PUT",
    url: "https://examplebucket.s3.amazonaws.com/test$file.text",
    headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
    body,
  });
  assert.equal(out.canonicalRequest, creq);
  assert.equal(
    out.headers.authorization,
    `AWS4-HMAC-SHA256 Credential=${s3Scope}, ` +
      "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, " +
      "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
  );
});

test("S3 docs: GET bucket lifecycle (?lifecycle)", async () => {
  const creq = [
    "GET",
    "/",
    "lifecycle=",
    "host:examplebucket.s3.amazonaws.com",
    "x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "x-amz-date:20130524T000000Z",
    "",
    "host;x-amz-content-sha256;x-amz-date",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ].join("\n");
  assert.equal(sha256(creq), "9766c798316ff2757b517bc739a67f6213b4ab36dd5da2f94eaebf79c77395ca");

  const out = await explainSignRequest({ ...s3Base, method: "GET", url: "https://examplebucket.s3.amazonaws.com/?lifecycle" });
  assert.equal(out.canonicalRequest, creq);
  assert.equal(out.signature, "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
});

test("S3 docs: GET bucket list (?max-keys=2&prefix=J), query given out of order", async () => {
  const creq = [
    "GET",
    "/",
    "max-keys=2&prefix=J",
    "host:examplebucket.s3.amazonaws.com",
    "x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "x-amz-date:20130524T000000Z",
    "",
    "host;x-amz-content-sha256;x-amz-date",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ].join("\n");
  assert.equal(sha256(creq), "df57d21db20da04d7fa30298dd4488ba3a2b47ca3a489c74750e0f1e7df1b9b7");

  const out = await explainSignRequest({
    ...s3Base,
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2",
  });
  assert.equal(out.canonicalRequest, creq);
  assert.equal(out.signature, "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
});

// Source: Amazon S3 API reference, "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)"
// (sigv4-query-string-auth.html), "An Example": GET /test.txt from examplebucket, expires 86400.
test("S3 docs: presigned GET URL", async () => {
  const creq = [
    "GET",
    "/test.txt",
    "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host",
    "host:examplebucket.s3.amazonaws.com",
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  assert.equal(sha256(creq), "3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04");

  const url = await presignUrl({
    ...s3Base,
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    expiresSeconds: 86400,
  });
  assert.equal(
    url,
    "https://examplebucket.s3.amazonaws.com/test.txt" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20130524T000000Z" +
      "&X-Amz-Expires=86400" +
      "&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

// An independent HMAC chain on node:crypto, checking the WebCrypto key derivation and the signing-key cache
// for inputs the published vectors do not cover (other regions, session tokens, odd keys).
function referenceSignature(secret: string, amzDate: string, region: string, service: string, sts: string): string {
  let key: Buffer = createHmac("sha256", "AWS4" + secret).update(amzDate.slice(0, 8)).digest();
  for (const part of [region, service, "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  return createHmac("sha256", key).update(sts).digest("hex");
}

test("signature matches a node:crypto HMAC chain across regions, dates and secrets", async () => {
  const cases = [
    { secret: "s3cr3t", region: "auto", date: "20261031T101010Z" },
    { secret: "s3cr3t", region: "auto", date: "20261101T000000Z" },
    { secret: "other/secret+with=chars", region: "eu-west-3", date: "20261031T235959Z" },
    { secret: "s3cr3t", region: "auto", date: "20261031T101010Z" }, // cached key reused
  ];
  for (const c of cases) {
    const out = await explainSignRequest({
      method: "PUT",
      url: "http://127.0.0.1:7070/bucket/a%20b/%E2%9C%93?partNumber=3&uploadId=x%2By",
      headers: { "Content-Type": "  application/octet-stream  " },
      payloadHash: UNSIGNED_PAYLOAD,
      credentials: { accessKeyId: "AK", secretAccessKey: c.secret, sessionToken: "tok/en=" },
      region: c.region,
      service: "s3",
      datetime: c.date,
    });
    assert.equal(out.signature, referenceSignature(c.secret, c.date, c.region, "s3", out.stringToSign));
    assert.equal(out.headers["x-amz-security-token"], "tok/en=");
    assert.match(out.headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
    assert.equal(
      out.canonicalRequest.split("\n").slice(0, 4).join("\n"),
      "PUT\n/bucket/a%20b/%E2%9C%93\npartNumber=3&uploadId=x%2By\ncontent-type:application/octet-stream",
    );
  }
});

test("canonicalization: encoding, sorting, whitespace, repeated headers", async () => {
  assert.equal(encodeRfc3986("AZaz09-_.~"), "AZaz09-_.~");
  assert.equal(encodeRfc3986("a b+c%d/e!'()*"), "a%20b%2Bc%25d%2Fe%21%27%28%29%2A");
  assert.equal(encodeRfc3986("é✓😀"), "%C3%A9%E2%9C%93%F0%9F%98%80");
  assert.equal(encodeS3Path("/bkt/dir a/b+c/%"), "/bkt/dir%20a/b%2Bc/%25");
  assert.equal(toAmzDate(new Date(Date.UTC(2013, 4, 24, 0, 0, 0, 999))), "20130524T000000Z");

  const out = await explainSignRequest({
    method: "get",
    url: "https://h.example/k?b=2&a=2&a=1&B=0&empty=&c=x%20y+z",
    headers: { "X-Amz-Meta-A": "one   two\t three", "x-amz-meta-a": "  four " },
    payloadHash: UNSIGNED_PAYLOAD,
    credentials: { accessKeyId: "AK", secretAccessKey: "SK" },
    region: "us-east-1",
    service: "s3",
    datetime: "20261031T000000Z",
  });
  const [method, uri, query, firstHeader] = out.canonicalRequest.split("\n");
  assert.equal(method, "GET");
  assert.equal(uri, "/k");
  // Uppercase sorts before lowercase (byte order); equal names sort by value; `+` stays a literal plus.
  assert.equal(query, "B=0&a=1&a=2&b=2&c=x%20y%2Bz&empty=");
  assert.equal(firstHeader, "host:h.example");
  assert.match(out.canonicalRequest, /\nx-amz-meta-a:one two three,four\n/);
});

test("presign: validates expiry, signs the session token and extra headers", async () => {
  const base = {
    method: "PUT",
    url: "http://127.0.0.1:9000/b/k",
    credentials: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "TOKEN" },
    region: "auto",
    service: "s3",
    datetime: "20261031T000000Z",
  };
  await assert.rejects(presignUrl({ ...base, expiresSeconds: 0 }), RangeError);
  await assert.rejects(presignUrl({ ...base, expiresSeconds: 604801 }), RangeError);
  await assert.rejects(presignUrl({ ...base, expiresSeconds: 1.5 }), RangeError);
  const url = new URL(await presignUrl({ ...base, expiresSeconds: 604800, extraSignedHeaders: { "Content-Type": "video/mp4" } }));
  assert.equal(url.searchParams.get("X-Amz-Security-Token"), "TOKEN");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-type;host");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "604800");
  assert.match(url.searchParams.get("X-Amz-Signature") ?? "", /^[0-9a-f]{64}$/);
});

test("signRequest rejects malformed input instead of signing something else", async () => {
  const base = { method: "GET", credentials: { accessKeyId: "AK", secretAccessKey: "SK" }, region: "auto", service: "s3" };
  await assert.rejects(signRequest({ ...base, url: "http://h/%zz" }), /malformed percent-encoding/);
  await assert.rejects(signRequest({ ...base, url: "http://h/k", datetime: "2026-10-31" }), TypeError);
});
