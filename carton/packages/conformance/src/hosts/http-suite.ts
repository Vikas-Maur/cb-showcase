// The HTTP API every Carton host serves (@carton/host-http), checked over real HTTP: the invite flow and the
// device credential, role checks, signed media URLs with ranges, and resumable multipart uploads. A host that mounts
// handleHttp passes this; one that serves its own API must answer the same way.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mediaHash, toBase64, webCryptoHasher } from "@carton/media";

export interface HttpFixture {
  origin: string;
  adminToken: string;
  // R2 and S3 refuse parts under 5 MiB but the last; 0 when the host's store has no minimum
  minPartSize?: number;
  // the host serves a static web client at "/"
  servesStatic?: boolean;
}

const enc = new TextEncoder();
const installKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
let projN = 0;

export function httpApiSuite(name: string, make: () => Promise<HttpFixture>): void {
  describe(`Host HTTP API: ${name}`, () => {
    let fx: HttpFixture;
    const project = () => `http-${Date.now().toString(36)}-${++projN}`;
    const call = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
      const headers = new Headers(init.headers);
      if (init.token) headers.set("authorization", `Bearer ${init.token}`);
      const body = init.json !== undefined ? JSON.stringify(init.json) : init.body;
      if (init.json !== undefined) headers.set("content-type", "application/json");
      return fetch(fx.origin + path, { ...init, headers, ...(body !== undefined ? { body } : {}) });
    };
    const owner = async (p: string) => {
      const inv = (await (await call(`/api/admin/projects/${p}/invites`, { method: "POST", token: fx.adminToken, json: { role: "owner" } })).json()) as { invite: string };
      const key = installKey();
      const j = (await (await call(`/api/projects/${p}/join`, { method: "POST", json: { invite: inv.invite, account: "owner", installKey: key } })).json()) as { token: string; context: { credential: string } };
      return { token: j.token, key, credential: j.context.credential };
    };
    const joinAs = async (p: string, ownerToken: string, role: string) => {
      const inv = (await (await call(`/api/projects/${p}/invites`, { method: "POST", token: ownerToken, json: { role } })).json()) as { invite: string };
      return ((await (await call(`/api/projects/${p}/join`, { method: "POST", json: { invite: inv.invite, account: role, installKey: installKey() } })).json()) as { token: string }).token;
    };

    test("setup", async () => {
      fx = await make();
      assert.equal((await call("/api/health")).status, 200);
    });

    test("the first owner comes from the admin token; without it, no invite", async () => {
      const p = project();
      assert.equal((await call(`/api/admin/projects/${p}/invites`, { method: "POST", json: { role: "owner" } })).status, 401);
      assert.equal((await call(`/api/admin/projects/${p}/invites`, { method: "POST", token: "wrong", json: { role: "owner" } })).status, 401);
      const o = await owner(p);
      assert.match(o.credential, /^owner\//);
    });

    test("join: a bad invite is 401, another project's invite is 403", async () => {
      const p = project(), q = project();
      assert.equal((await call(`/api/projects/${p}/join`, { method: "POST", json: { invite: "ci1.bogus.x", account: "a", installKey: installKey() } })).status, 401);
      const inv = (await (await call(`/api/admin/projects/${q}/invites`, { method: "POST", token: fx.adminToken, json: { role: "editor" } })).json()) as { invite: string };
      assert.equal((await call(`/api/projects/${p}/join`, { method: "POST", json: { invite: inv.invite, account: "a", installKey: installKey() } })).status, 403);
    });

    test("only an owner invites; a session is refused on another project's routes", async () => {
      const p = project(), q = project();
      const o = await owner(p);
      const editor = await joinAs(p, o.token, "editor");
      assert.equal((await call(`/api/projects/${p}/invites`, { method: "POST", token: editor, json: { role: "editor" } })).status, 403);
      assert.equal((await call(`/api/projects/${q}/blobs/sign`, { method: "POST", token: o.token, json: { key: "k", method: "GET" } })).status, 403);
      assert.equal((await call(`/api/projects/${p}/blobs/sign`, { method: "POST", json: { key: "k", method: "GET" } })).status, 401);
    });

    test("refresh keeps the device credential, and needs the device's install key", async () => {
      const p = project();
      const o = await owner(p);
      const bad = await call(`/api/projects/${p}/refresh`, { method: "POST", json: { token: o.token, installKey: installKey() } });
      assert.equal(bad.status, 401);
      const r = (await (await call(`/api/projects/${p}/refresh`, { method: "POST", json: { token: o.token, installKey: o.key } })).json()) as { token: string; context: { credential: string } };
      assert.equal(r.context.credential, o.credential);
      assert.equal((await call(`/api/projects/${p}/blobs/head?key=x`, { token: r.token })).status, 404, "the new session works");
    });

    test("the WebSocket route takes the session in the subprotocol and answers carton.v1", async () => {
      const p = project();
      const o = await owner(p);
      const ws = new WebSocket(`${fx.origin.replace(/^http/, "ws")}/api/projects/${p}/ws`, ["carton.v1", `carton.auth.${o.token}`]);
      const protocol = await new Promise<string>((ok, fail) => {
        ws.onopen = () => ok(ws.protocol);
        ws.onerror = () => fail(new Error("socket refused"));
      });
      assert.equal(protocol, "carton.v1");
      ws.close();
      const refused = new WebSocket(`${fx.origin.replace(/^http/, "ws")}/api/projects/${p}/ws`, ["carton.v1", "carton.auth.nope"]);
      const opened = await new Promise<boolean>((ok) => {
        refused.onopen = () => ok(true);
        refused.onclose = () => ok(false);
        refused.onerror = () => ok(false);
      });
      assert.equal(opened, false, "a bad token opened a socket");
    });

    // web-demo's REQ-10: a create-only PUT costs no read-back. S3 and R2 answer 412 when the key is there.
    test("a signed PUT with If-None-Match: * answers 412 when the key is there, and both answers carry the stored info", async () => {
      const p = project();
      const o = await owner(p);
      const url = async (key: string) => ((await (await call(`/api/projects/${p}/blobs/sign`, { method: "POST", token: o.token, json: { key, method: "PUT", expiresIn: 60 } })).json()) as { url: string }).url;
      const head = async (key: string) => (await (await call(`/api/projects/${p}/blobs/head?key=${encodeURIComponent(key)}`, { token: o.token })).json()) as Record<string, unknown>;
      const first = enc.encode("the first writer's bytes");
      const made = await fetch(await url("media/once"), { method: "PUT", body: first, headers: { "if-none-match": "*", "content-type": "image/png" } });
      assert.equal(made.status, 200);
      const info = (await made.json()) as Record<string, unknown>;
      assert.equal(info.size, first.byteLength);
      assert.equal(info.contentType, "image/png");
      assert.equal(made.headers.get("etag"), (info.etag as string | undefined) ?? null);
      const stored = await head("media/once");
      for (const k of ["size", "etag", "contentType"] as const) assert.equal(info[k], stored[k], k);
      const again = await fetch(await url("media/once"), { method: "PUT", body: enc.encode("another"), headers: { "if-none-match": "*", "content-type": "text/plain" } });
      assert.equal(again.status, 412);
      const kept = (await again.json()) as Record<string, unknown>;
      for (const k of ["size", "etag", "contentType"] as const) assert.equal(kept[k], stored[k], `the first object's ${k}`);
      const get = ((await (await call(`/api/projects/${p}/blobs/sign`, { method: "POST", token: o.token, json: { key: "media/once", method: "GET", expiresIn: 60 } })).json()) as { url: string }).url;
      assert.deepEqual(new Uint8Array(await (await fetch(get)).arrayBuffer()), first, "the first writer's bytes stay");
    });

    // Round 3: two create-only PUTs racing on a key the host doesn't lock both got 200 when their bodies had one size.
    test("create-only signed PUTs racing on one key: exactly one 200, and the stored bytes are its body", async () => {
      const p = project();
      const o = await owner(p);
      const sign = async (key: string, method: string) => ((await (await call(`/api/projects/${p}/blobs/sign`, { method: "POST", token: o.token, json: { key, method, expiresIn: 60 } })).json()) as { url: string }).url;
      for (let i = 0; i < 6; i++) {
        const key = `media/race-${i}`;
        const bodies = [enc.encode(`first-${i}`), enc.encode(`other-${i}`)]; // the same size
        const [u1, u2] = [await sign(key, "PUT"), await sign(key, "PUT")];
        const rs = await Promise.all([fetch(u1, { method: "PUT", body: bodies[0], headers: { "if-none-match": "*" } }), fetch(u2, { method: "PUT", body: bodies[1], headers: { "if-none-match": "*" } })]);
        for (const r of rs) await r.body?.cancel();
        const statuses = rs.map((r) => r.status);
        assert.deepEqual([...statuses].sort(), [200, 412], `${key}: ${statuses}`);
        const stored = new Uint8Array(await (await fetch(await sign(key, "GET"))).arrayBuffer());
        assert.deepEqual(stored, bodies[statuses.indexOf(200)], `${key}: the 200's bytes are what is stored`);
      }
    });

    // REQ-11: media's reuse check of a long stream heads every part. One request answers up to 1,000 keys, for a prefix
    // of them when the host's budget is smaller (the client asks again for the rest).
    test("POST /blobs/heads: HEAD's answer for each key, in order, by HEAD's rules; at most 1,000 keys and 1 MiB", async () => {
      const p = project();
      const o = await owner(p);
      const hexOf = (i: number) => i.toString(16).padStart(64, "0");
      const a = `m/${hexOf(0xa)}`, b = `m/${hexOf(0xb)}`;
      for (const [key, body] of [[a, "abc"], [b, "hello"]] as const) {
        const url = ((await (await call(`/api/projects/${p}/blobs/sign`, { method: "POST", token: o.token, json: { key, method: "PUT", expiresIn: 60 } })).json()) as { url: string }).url;
        assert.ok((await fetch(url, { method: "PUT", body: enc.encode(body) })).ok);
      }
      const heads = (keys: unknown, token = o.token) => call(`/api/projects/${p}/blobs/heads`, { method: "POST", token, json: { keys } });
      const all = async (keys: string[], token = o.token) => {
        const out: unknown[] = [];
        while (out.length < keys.length) {
          const r = await heads(keys.slice(out.length, out.length + 1000), token);
          assert.equal(r.status, 200);
          const { blobs } = (await r.json()) as { blobs: unknown[] };
          assert.ok(blobs.length >= 1 && blobs.length <= Math.min(1000, keys.length - out.length), `${blobs.length} answers`);
          out.push(...blobs);
        }
        return out;
      };
      const keys = Array.from({ length: 1300 }, (_, i) => (i % 5 === 0 ? a : i % 5 === 1 ? b : `m/${hexOf(i)}`));
      assert.deepEqual(await all(keys), keys.map((k) => (k === a ? { size: 3 } : k === b ? { size: 5 } : null)));
      assert.deepEqual(await (await heads([])).json(), { blobs: [] });
      // caps, and keys a store refuses: the whole request is refused
      assert.equal((await heads(Array(1001).fill(a))).status, 400);
      for (const bad of [a, [a, 7], [a, "m/../x"]]) assert.equal((await heads(bad)).status, 400, JSON.stringify(bad));
      assert.equal((await call(`/api/projects/${p}/blobs/heads`, { method: "POST", token: o.token, json: { keys: [a], pad: "x".repeat(1024 * 1024) } })).status, 413);
      // 1,000 long keys fit (a project's scope leaves about 1,000 bytes a key; short segments, for POSIX-backed stores)
      const long = Array.from({ length: 1000 }, (_, i) => `m/${String(i).padStart(4, "0")}/${`${"x".repeat(99)}/`.repeat(9)}end`);
      assert.equal((await heads(long)).status, 200, "1,000 keys of 910 bytes fit");
      // HEAD's scope: a viewer heads anything; a watch link, media named by content only
      const viewer = await joinAs(p, o.token, "viewer");
      assert.deepEqual(await all([a, b], viewer), [{ size: 3 }, { size: 5 }]);
      const inv = (await (await call(`/api/projects/${p}/invites`, { method: "POST", token: o.token, json: { role: "viewer", branches: ["pub-1"] } })).json()) as { invite: string };
      const watcher = ((await (await call(`/api/projects/${p}/join`, { method: "POST", json: { invite: inv.invite, account: "watcher", installKey: installKey() } })).json()) as { token: string }).token;
      assert.deepEqual(await all([a, b], watcher), [{ size: 3 }, { size: 5 }]);
      assert.equal((await heads([a, "project.json"], watcher)).status, 403);
      assert.equal((await heads([a])).status, 200);
      assert.equal((await call(`/api/projects/${p}/blobs/heads`, { method: "POST", json: { keys: [a] } })).status, 401, "a session is needed");
    });

    test("signed media URLs: PUT, then GET with ranges, bound to their key; viewers can't sign a PUT", async () => {
      const p = project();
      const o = await owner(p);
      const sign = async (key: string, method: string, token = o.token) => call(`/api/projects/${p}/blobs/sign`, { method: "POST", token, json: { key, method, expiresIn: 60 } });
      const put = ((await (await sign("media/clip.mp4", "PUT")).json()) as { url: string }).url;
      const data = enc.encode("0123456789".repeat(100));
      assert.ok((await fetch(put, { method: "PUT", body: data, headers: { "content-type": "video/mp4" } })).ok);
      const get = ((await (await sign("media/clip.mp4", "GET")).json()) as { url: string }).url;
      const whole = await fetch(get);
      assert.equal(whole.status, 200);
      assert.equal(whole.headers.get("content-type"), "video/mp4");
      assert.equal((await whole.arrayBuffer()).byteLength, 1000);
      const part = await fetch(get, { headers: { range: "bytes=10-19" } });
      assert.equal(part.status, 206);
      assert.equal(new TextDecoder().decode(await part.arrayBuffer()), "0123456789");
      assert.equal((await fetch(get.replace("clip.mp4", "other.mp4"))).status, 403, "a URL opened another key");
      // the same key in another project: the URL is bound to its project's route, not only to the key
      const q = project();
      const qo = await owner(q);
      const qput = ((await (await call(`/api/projects/${q}/blobs/sign`, { method: "POST", token: qo.token, json: { key: "media/clip.mp4", method: "PUT", expiresIn: 60 } })).json()) as { url: string }).url;
      assert.ok((await fetch(qput, { method: "PUT", body: enc.encode("project q's bytes") })).ok);
      assert.equal((await fetch(get.replace(`/blob/${p}/`, `/blob/${q}/`))).status, 403, "a URL for one project opened another's");
      assert.equal((await fetch(put.replace(`/blob/${p}/`, `/blob/${q}/`), { method: "PUT", body: enc.encode("overwrite") })).status, 403, "a PUT URL wrote into another project");
      assert.equal((await fetch(put)).status, 403, "a PUT URL used for GET");
      const head = (await (await call(`/api/projects/${p}/blobs/head?key=media/clip.mp4`, { token: o.token })).json()) as { size: number };
      assert.equal(head.size, 1000);
      const viewer = await joinAs(p, o.token, "viewer");
      assert.equal((await sign("media/x", "PUT", viewer)).status, 403);
      assert.equal((await sign("media/clip.mp4", "GET", viewer)).status, 200);
    });

    // @carton/media records damage append-only (damage.ts): a reader's report `bad/<id>`, and the repair that answers
    // it `repaired/<id>`, naming the report it saw. Nothing is deleted, so a host needs only PUT and GET for them.
    test("media's damage reports and repairs (bad/<id>, repaired/<hash>): editors write and read them, viewers read, a watch link reaches neither", async () => {
      const p = project();
      const o = await owner(p);
      const id = "ab".repeat(32);
      const sign = (key: string, method: string, token: string) => call(`/api/projects/${p}/blobs/sign`, { method: "POST", token, json: { key, method, expiresIn: 60 } });
      const editor = await joinAs(p, o.token, "editor");
      const report = enc.encode(JSON.stringify({ leaf: 3, nonce: "r1" }));
      const answer = enc.encode(JSON.stringify({ report: "7b", at: 1 }));
      for (const [key, body] of [[`bad/${id}`, report], [`repaired/${id}`, answer]] as const) {
        const put = (await (await sign(key, "PUT", editor)).json()) as { url: string };
        assert.ok((await fetch(put.url, { method: "PUT", body, headers: { "content-type": "application/json" } })).ok, `PUT ${key}`);
        const get = (await (await sign(key, "GET", editor)).json()) as { url: string };
        assert.deepEqual(new Uint8Array(await (await fetch(get.url)).arrayBuffer()), body, `GET ${key}`);
        assert.equal(((await (await call(`/api/projects/${p}/blobs/head?key=${encodeURIComponent(key)}`, { token: editor })).json()) as { size: number }).size, body.byteLength);
      }
      const viewer = await joinAs(p, o.token, "viewer");
      assert.equal((await sign(`repaired/${id}`, "GET", viewer)).status, 200, "a viewer reads a repair");
      assert.equal((await sign(`repaired/${id}`, "PUT", viewer)).status, 403, "a viewer can't record one");
      // a Published cut's watch link: neither, as with every non-content key (its scope is its cut)
      const inv = (await (await call(`/api/projects/${p}/invites`, { method: "POST", token: o.token, json: { role: "viewer", branches: ["pub-1"] } })).json()) as { invite: string };
      const watcher = ((await (await call(`/api/projects/${p}/join`, { method: "POST", json: { invite: inv.invite, account: "watcher", installKey: installKey() } })).json()) as { token: string }).token;
      for (const key of [`bad/${id}`, `repaired/${id}`]) assert.equal((await sign(key, "GET", watcher)).status, 403, key);
    });

    test("multipart upload over HTTP: parts out of order, listed to resume, completed, then streamed", async () => {
      const p = project();
      const o = await owner(p);
      const size = Math.max(fx.minPartSize ?? 0, 256 * 1024);
      const p1 = new Uint8Array(size).fill(1), p2 = new Uint8Array(size).fill(2), p3 = new Uint8Array(1000).fill(3);
      const up = (await (await call(`/api/projects/${p}/uploads`, { method: "POST", token: o.token, json: { key: "media/big.mp4", contentType: "video/mp4" } })).json()) as { uploadId: string };
      const at = (sub: string) => `/api/projects/${p}/uploads/${encodeURIComponent(up.uploadId)}${sub}?key=media/big.mp4`;
      const e2 = (await (await call(at("/2"), { method: "PUT", token: o.token, body: p2 })).json()) as { partNumber: number; etag: string };
      const e1 = (await (await call(at("/1"), { method: "PUT", token: o.token, body: p1 })).json()) as { partNumber: number; etag: string };
      const listed = (await (await call(at(""), { token: o.token })).json()) as { parts: { partNumber: number; size: number }[] };
      assert.deepEqual(listed.parts.map((x) => [x.partNumber, x.size]), [[1, size], [2, size]]);
      const e3 = (await (await call(at("/3"), { method: "PUT", token: o.token, body: p3 })).json()) as { partNumber: number; etag: string };
      const done = await call(at("/complete"), { method: "POST", token: o.token, json: { parts: [e1, e2, e3] } });
      assert.equal(done.status, 200, await done.clone().text());
      assert.equal(((await done.json()) as { size: number }).size, 2 * size + 1000);
      const get = ((await (await call(`/api/projects/${p}/blobs/sign`, { method: "POST", token: o.token, json: { key: "media/big.mp4", method: "GET" } })).json()) as { url: string }).url;
      const tail = new Uint8Array(await (await fetch(get, { headers: { range: `bytes=${size - 2}-${size + 1}` } })).arrayBuffer());
      assert.deepEqual([...tail], [1, 1, 2, 2]);
      const viewer = await joinAs(p, o.token, "viewer");
      assert.equal((await call(`/api/projects/${p}/uploads`, { method: "POST", token: viewer, json: { key: "media/v" } })).status, 403);
    });

    // cf-proxy-path: a proxy stream's batch routes (host-http streams.ts), over this host's real store and HTTP stack.
    test("stream routes: a batch appended in one request (an editor's), read back in one with its bytes; a live read is held, then ends", async () => {
      const p = project();
      const o = await owner(p);
      const id = "ab".repeat(32);
      const hasher = webCryptoHasher();
      const bytes = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * 13 + seed) & 0xff);
      const init = bytes(600, 1), s0 = bytes(70_000, 2), s1 = bytes(1_100_000, 3); // s1 spans two leaves
      const [mi, m0, m1] = await Promise.all([init, s0, s1].map((b) => mediaHash(b, hasher)));
      const frame = (header: unknown, ...parts: Uint8Array[]) => {
        const h = enc.encode(JSON.stringify(header));
        const out = new Uint8Array(4 + h.length + parts.reduce((n, b) => n + b.length, 0));
        new DataView(out.buffer).setUint32(0, h.length);
        out.set(h, 4);
        let at = 4 + h.length;
        for (const b of parts) out.set(b, (at += b.length) - b.length);
        return out;
      };
      const part = (kind: string, m: { hash: string; size: number; bytes: Uint8Array }, index?: number) => ({ kind, hash: m.hash, size: m.size, manifest: toBase64(m.bytes), bytes: true, ...(index !== undefined ? { index, durationSec: 2, at: Date.now() } : {}) });
      const append = (token: string, body: Uint8Array) => call(`/api/projects/${p}/streams/${id}/append`, { method: "POST", token, body, headers: { "content-type": "application/octet-stream" } });
      const viewer = await joinAs(p, o.token, "viewer");
      assert.equal((await append(viewer, frame({ v: 1, parts: [part("init", mi!)] }, init))).status, 403, "a viewer can't append");
      const first = await append(o.token, frame({ v: 1, parts: [part("init", mi!), part("segment", m0!, 0)] }, init, s0));
      assert.equal(first.status, 200, await first.clone().text());
      // read: header, then u32 length + bytes per part
      const read = async (q: string, token = viewer) => {
        const r = await call(`/api/projects/${p}/streams/${id}/read?${q}`, { token });
        assert.equal(r.status, 200);
        const b = new Uint8Array(await r.arrayBuffer());
        const view = new DataView(b.buffer, b.byteOffset);
        const n = view.getUint32(0);
        const header = JSON.parse(new TextDecoder().decode(b.subarray(4, 4 + n))) as { init?: { hash: string; bytes: boolean; manifest?: string } | null; segments: { index: number; hash: string; bytes: boolean; manifest?: string }[]; end?: unknown };
        const parts: Uint8Array[] = [];
        let at = 4 + n;
        while (at < b.length) {
          const len = view.getUint32(at);
          parts.push(b.subarray(at + 4, at + 4 + len));
          at += 4 + len;
        }
        return { header, parts };
      };
      const a = await read("from=0&init=1");
      assert.equal(a.header.init?.hash, mi!.hash);
      assert.equal(a.header.init?.manifest, toBase64(mi!.bytes));
      assert.deepEqual(a.header.segments.map((s) => [s.index, s.hash, s.bytes]), [[0, m0!.hash, true]]);
      assert.equal(a.header.end, null, "looked for the end at the edge: not there");
      assert.deepEqual(a.parts, [init, s0]);
      // held at the edge while nothing comes, then answered
      const t0 = Date.now();
      const held = await read("from=1&wait=1500");
      assert.ok(Date.now() - t0 >= 900, "held");
      assert.deepEqual(held.header.segments, []);
      // the next segment and the end, then read from 1: its bytes (two leaves) and the end
      const end = { segments: 2, durationSec: 4, size: mi!.size + m0!.size + m1!.size, at: Date.now(), parts: [mi!.hash, m0!.hash, m1!.hash], sizes: [mi!.size, m0!.size, m1!.size], durations: [2, 2] };
      assert.equal((await append(o.token, frame({ v: 1, parts: [part("segment", m1!, 1)], end }, s1))).status, 200);
      const b = await read("from=1&wait=5000");
      assert.deepEqual(b.header.segments.map((s) => s.index), [1]);
      assert.deepEqual(b.parts, [s1]);
      const c = await read("from=2&wait=5000");
      assert.deepEqual(c.header.end, end, "an ended stream answers at once with its end");
      // entries only
      const e = await read("from=0&bytes=0");
      assert.deepEqual(e.header.segments.map((s) => [s.index, s.bytes]), [[0, false], [1, false]]);
      assert.deepEqual(e.parts, []);
      // the same layout the part-by-part path reads: a signed GET of the entry
      const sign = (await (await call(`/api/projects/${p}/blobs/sign`, { method: "POST", token: viewer, json: { key: `ps/${id}/s/000001`, method: "GET", expiresIn: 60 } })).json()) as { url: string };
      assert.equal(((await (await fetch(sign.url)).json()) as { hash: string }).hash, m1!.hash);
    });

    test("unknown API routes are 404; static files are served when the host has a client", async () => {
      assert.equal((await call("/api/nothing-here")).status, 404);
      if (fx.servesStatic) {
        const r = await call("/");
        assert.equal(r.status, 200);
        assert.match(r.headers.get("content-type") ?? "", /html/);
      }
    });
  });
}
