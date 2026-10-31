// The control socket: Cardboard's wire format (JSON-RPC 2.0 lines, auth with the token file), ping before auth,
// timeouts, framing across chunk boundaries, and the Windows pipe name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { ControlClient, ControlServer, pipeName, tokenPath, RpcError } from "../src/ipc.ts";
import { holderSocketPath } from "../src/holder.ts";
import { scratch } from "./support/scratch.ts";

const dir = mkdtempSync(join(scratch(), "ipc-"));

test("pipeName maps a socket path to our build's named pipe on Windows, and leaves POSIX paths alone", () => {
  assert.equal(pipeName("/x/cardboard.sock", "linux"), "/x/cardboard.sock");
  // the same mapping as scripts/patch-main.js __cbSock: sha256 of the lowercased path, first 16 hex
  const p = pipeName("C:\\Users\\José\\AppData\\Roaming\\ai.cardboard.desktop\\cardboard.sock", "win32");
  assert.match(p, /^\\\\\.\\pipe\\cardboard-[0-9a-f]{16}$/);
  assert.equal(p, pipeName("c:\\users\\josé\\appdata\\roaming\\ai.cardboard.desktop\\CARDBOARD.SOCK", "win32"), "case-insensitive, as NTFS");
  assert.equal(pipeName("\\\\.\\pipe\\already", "win32"), "\\\\.\\pipe\\already");
});

test("auth first, ping open, unknown methods and thrown errors come back as JSON-RPC errors", async () => {
  const path = join(dir, "a.sock");
  const srv = await ControlServer.listen({
    path,
    open: ["carton.ping"],
    methods: {
      "carton.ping": () => ({ nonce: "n1" }),
      echo: (p) => p,
      boom: () => { throw new RpcError("nope", -32003, { why: "test" }); },
    },
  });
  try {
    assert.equal(readFileSync(tokenPath(path), "utf8").trim(), srv.token);
    if (process.platform !== "win32") assert.equal(statSync(tokenPath(path)).mode & 0o077, 0, "token file is private to the user");
    const anon = await ControlClient.connect(path, { auth: false });
    assert.deepEqual(await anon.call("carton.ping"), { nonce: "n1" });
    await assert.rejects(anon.call("echo", { a: 1 }), (e: any) => e.code === -32000);
    anon.close();
    const c = await ControlClient.connect(path);
    assert.deepEqual(await c.call("echo", { a: [1, "x"] }), { a: [1, "x"] });
    await assert.rejects(c.call("nope"), (e: any) => e.code === -32601);
    await assert.rejects(c.call("boom"), (e: any) => e instanceof RpcError && e.code === -32003 && (e.data as any).why === "test");
    c.close();
    await assert.rejects(ControlClient.connect(path, { token: "wrong" }), (e: any) => e.code === -32000);
  } finally {
    await srv.close();
  }
});

test("framing: messages split across chunks and several messages in one chunk; a big message", async () => {
  const path = join(dir, "b.sock");
  const srv = await ControlServer.listen({ path, open: ["echo"], methods: { echo: (p) => p } });
  try {
    const raw = createConnection(pipeName(path));
    raw.setEncoding("utf8");
    let buf = "";
    raw.on("data", (d: string) => { buf += d; });
    await new Promise((r) => raw.once("connect", r));
    const m1 = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: { x: "é".repeat(10) } }) + "\n";
    const m2 = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "echo", params: { y: 2 } }) + "\n";
    raw.write(m1.slice(0, 7));
    await new Promise((r) => setTimeout(r, 20));
    raw.write(m1.slice(7) + m2);
    while (buf.split("\n").filter(Boolean).length < 2) await new Promise((r) => setTimeout(r, 5));
    const got = buf.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(got.map((g) => g.id), [1, 2]);
    assert.equal(got[0].result.x, "é".repeat(10));
    raw.destroy();
    const c = await ControlClient.connect(path, { auth: false });
    const big = "x".repeat(3 * 1024 * 1024);
    assert.equal((await c.call("echo", { big }, 10000)).big.length, big.length);
    c.close();
  } finally {
    await srv.close();
  }
});

test("a call times out; a connection to nothing fails fast; closing the server fails waiting calls", async () => {
  const path = join(dir, "c.sock");
  const srv = await ControlServer.listen({ path, open: ["slow", "hang"], methods: { slow: () => new Promise((r) => setTimeout(() => r(1), 300)), hang: () => new Promise(() => {}) } });
  const c = await ControlClient.connect(path, { auth: false });
  await assert.rejects(c.call("slow", {}, 50), (e: any) => e.code === "ETIMEDOUT");
  const t0 = Date.now();
  await assert.rejects(ControlClient.connect(join(dir, "nobody.sock"), { auth: false, timeoutMs: 1000 }));
  assert.ok(Date.now() - t0 < 500, "no listener: refused at once, not after the timeout");
  const waiting = c.call("hang", {}, 10000);
  await new Promise((r) => setTimeout(r, 20));
  await srv.close();
  await assert.rejects(waiting, (e: any) => e.code === "ECONNRESET");
});

test("holder socket paths fit sun_path: a deep folder falls back to the temp folder (POSIX only)", async () => {
  const deep = join(dir, "x".repeat(120));
  const p = holderSocketPath(deep, "helper", "linux");
  assert.ok(Buffer.byteLength(p) <= 104, p);
  assert.ok(!p.startsWith(deep));
  assert.ok(holderSocketPath(deep, "helper", "win32").startsWith(deep), "Windows pipes have no such limit");
  const short = holderSocketPath(dir, "worker", "linux");
  assert.ok(short.startsWith(dir));
  const srv = await ControlServer.listen({ path: p, open: ["ping"], methods: { ping: () => 1 } });
  const c = await ControlClient.connect(p, { auth: false });
  assert.equal(await c.call("ping"), 1);
  c.close();
  await srv.close();
});
