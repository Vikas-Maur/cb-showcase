// A host may sign URLs that go straight to its bucket (S3's or R2's presigned URLs), not through serveSignedBlob: the
// answer to a PUT is then the bucket's, 200 with an etag and no body, or 412 with an XML error, never the stored
// info. hostMediaBlobs.put decides by the answer, not by who gave it: info in a JSON body is taken; without it, a
// create-only PUT reads back what is stored (REQ-10).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { BlobInfo } from "@carton/core/plugins";
import { hostMediaBlobs } from "../src/client.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

const bodyOf = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

// The host's API (sign, head) and, on the same server, a bucket answering its presigned PUTs as S3 and R2 do.
async function presigningHost(bucketPut: "s3" | "json-not-info") {
  const stored = new Map<string, BlobInfo & { bytes: Buffer }>();
  const calls: string[] = [];
  let n = 0;
  const server = createServer(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    const body = await bodyOf(req);
    if (req.method === "POST" && u.pathname === "/api/projects/p/blobs/sign") {
      calls.push("POST sign");
      const { key } = JSON.parse(body.toString()) as { key: string };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ url: `${origin}/bucket/${encodeURIComponent(key)}?X-Amz-Signature=x` }));
    }
    if (req.method === "GET" && u.pathname === "/api/projects/p/blobs/head") {
      calls.push("GET head");
      const s = stored.get(u.searchParams.get("key")!);
      if (!s) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "not found" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ...s, bytes: undefined }));
    }
    if (req.method === "PUT" && u.pathname.startsWith("/bucket/")) {
      calls.push("PUT bucket");
      const key = decodeURIComponent(u.pathname.slice("/bucket/".length));
      if (req.headers["if-none-match"] === "*" && stored.has(key)) {
        res.writeHead(412, { "content-type": "application/xml" });
        return res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message></Error>`);
      }
      const etag = `"etag-${++n}"`;
      stored.set(key, { key, size: body.byteLength, etag, ...(req.headers["content-type"] ? { contentType: req.headers["content-type"] } : {}), bytes: body });
      if (bucketPut === "s3") {
        res.writeHead(200, { etag });
        return res.end();
      }
      // a gateway that answers JSON of its own: not the stored info, so the client must not take it for that
      res.writeHead(200, { etag, "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { media: hostMediaBlobs({ origin, projectId: "p", token: "t" }), stored, calls };
}

for (const bucketPut of ["s3", "json-not-info"] as const) {
  test(`presigned URLs straight to a bucket (${bucketPut}): put reads back after a create-only PUT, since the answer holds no info`, async () => {
    const { media, stored, calls } = await presigningHost(bucketPut);
    // a new key: the bucket's 200 says nothing of what is stored, so the client heads
    const made = await media.put("m/new", new Uint8Array([1, 2, 3]), { ifAbsent: true, contentType: "image/png" });
    assert.deepEqual(calls.splice(0), ["POST sign", "PUT bucket", "GET head"]);
    assert.deepEqual(made, { key: "m/new", size: 3, etag: stored.get("m/new")!.etag, contentType: "image/png" });
    // the key already there: the bucket's 412 (XML) is no failure, and the earlier object's info comes from the head
    const kept = await media.put("m/new", new Uint8Array([9, 9, 9, 9, 9]), { ifAbsent: true, contentType: "text/plain" });
    assert.deepEqual(calls.splice(0), ["POST sign", "PUT bucket", "GET head"]);
    assert.deepEqual(kept, made, "the earlier object's info, not the refused bytes'");
    assert.deepEqual([...stored.get("m/new")!.bytes], [1, 2, 3]);
    // a plain PUT replaces: its bytes are what is stored, so nothing is read back
    const plain = await media.put("m/plain", new Uint8Array([4, 5]));
    assert.deepEqual(calls.splice(0), ["POST sign", "PUT bucket"]);
    assert.deepEqual(plain, { key: "m/plain", size: 2, etag: stored.get("m/plain")!.etag });
  });
}
