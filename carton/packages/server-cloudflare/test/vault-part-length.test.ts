// A part whose bytes don't match its declared length is refused by the vault (blob-do.ts), whichever way the length
// was declared: the `len` the Worker's streamed parts pass, or the request's content-length. Run on the DO SQL
// emulation (the vault binds BLOBs as Uint8Array; the emulation wants ArrayBuffer, so a wrapper converts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BlobVault } from "../src/blob-do.ts";
import type { DurableObjectState } from "../src/cf.ts";
import { emulatedDoStorage } from "./do-sql-emulation.ts";

function vault() {
  const st = emulatedDoStorage();
  const sql = st.sql;
  const storage = { ...st, sql: { exec: (q: string, ...b: unknown[]) => sql.exec(q, ...b.map((x) => (x instanceof Uint8Array ? x.slice().buffer : x))), databaseSize: 0 } };
  return new BlobVault({ storage } as unknown as DurableObjectState);
}
const put = (v: BlobVault, path: string, body: Uint8Array, length: number) =>
  v.fetch(new Request(`https://vault${path}`, { method: "PUT", body: new Blob([body as Uint8Array<ArrayBuffer>]).stream(), duplex: "half", headers: { "content-length": String(length) } } as RequestInit));

test("a part shorter than its declared content-length is refused, never stored truncated", async () => {
  const v = vault();
  const { uploadId } = (await (await v.fetch(new Request("https://vault/mp?k=m%2Fx", { method: "POST" }))).json()) as { uploadId: string };
  const part = `/mp/part?k=m%2Fx&id=${uploadId}&n=1`;
  const short = await put(v, part, new Uint8Array(60).fill(1), 100);
  assert.equal(short.status, 400, await short.clone().text());
  assert.equal(((await short.json()) as { code: string }).code, "InvalidPart");
  assert.deepEqual(await (await v.fetch(new Request(`https://vault/mp/parts?k=m%2Fx&id=${uploadId}`))).json(), [], "nothing stored");
  const whole = await put(v, part, new Uint8Array(100).fill(2), 100);
  assert.equal(whole.status, 200);
  assert.deepEqual(((await (await v.fetch(new Request(`https://vault/mp/parts?k=m%2Fx&id=${uploadId}`))).json()) as { size: number }[]).map((p) => p.size), [100]);
});
