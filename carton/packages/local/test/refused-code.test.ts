// Review of fix/recover-save #2: a write the lease holder refuses with a domain code (core's EMPTY_VERSION: an undo that
// would leave the project empty) keeps that code across the control socket, so the app's undo can say why instead of
// reading an unknown failure. A string code travels in the JSON-RPC error's `data`; retries still read the transport's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createMemoryStore } from "@carton/store-memory";
import { ControlClient, ControlServer, RpcError } from "../src/ipc.ts";
import { Lease } from "../src/lease.ts";
import { submit } from "../src/client.ts";
import { scratch } from "./support/scratch.ts";

const dir = mkdtempSync(join(scratch(), "refused-code-"));
const refusal = () => Object.assign(new Error("Can't undo that: the project would be left empty"), { code: "EMPTY_VERSION" });

test("a holder's refusal with a string code reaches the caller with it, through the socket and submit, and is not retried", async () => {
  const path = join(dir, "holder.sock");
  let nonce = "", calls = 0;
  const srv = await ControlServer.listen({ path, open: ["carton.ping"], methods: { "carton.ping": () => ({ pid: process.pid, nonce }), "carton.commit": () => { calls++; throw refusal(); } } });
  const lease = new Lease(createMemoryStore());
  nonce = (await lease.take(null, { pid: process.pid, socketPath: path, kind: "helper" }))!.nonce;
  try {
    const c = await ControlClient.connect(path);
    await assert.rejects(c.call("carton.commit", {}), (e: any) => e instanceof RpcError && e.code === -32603 && (e.data as { code?: string })?.code === "EMPTY_VERSION" && /Can't undo that/.test(e.message));
    c.close();
    calls = 0;
    const r = await submit("carton.commit", { id: "r.1", op: { kind: "undo" } }, { lease, idempotent: true, needsHelper: async () => true, spawnHelper: () => {}, helperStartMs: 100 });
    assert.deepEqual(r, { via: "error", error: "Can't undo that: the project would be left empty", code: "EMPTY_VERSION" });
    assert.equal(calls, 1, "a refusal isn't retried");
  } finally {
    await srv.close();
  }
});
