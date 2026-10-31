// The HTTP API every Carton host serves (@carton/host-http), checked over real HTTP: the invite flow and the
// device credential, role checks, signed media URLs with ranges, and resumable multipart uploads. A host that mounts
// handleHttp passes this; one that serves its own API must answer the same way.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

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
      assert.equal((await fetch(put)).status, 403, "a PUT URL used for GET");
      const head = (await (await call(`/api/projects/${p}/blobs/head?key=media/clip.mp4`, { token: o.token })).json()) as { size: number };
      assert.equal(head.size, 1000);
      const viewer = await joinAs(p, o.token, "viewer");
      assert.equal((await sign("media/x", "PUT", viewer)).status, 403);
      assert.equal((await sign("media/clip.mp4", "GET", viewer)).status, 200);
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
