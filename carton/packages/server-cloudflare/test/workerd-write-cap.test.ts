// The daily write cap (src/write-cap.ts) inside real workerd: the Worker as deployed, R2 and TEAMS bound, a cap of a
// few operations a day, the counter in its room. Once the cap is reached writes are refused, and reads go on: an
// editor's media HEAD and batch HEAD claim team media (host-http team.ts), and must not be charged for it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHmacAuth } from "@carton/server";
import { hostMediaBlobs, HostApiError } from "@carton/host-http/client";
import { mediaHash, manifestKey, mediaKey, webCryptoHasher, uploadMedia, bytesSource, LEAF_SIZE } from "@carton/media";
import type { Role } from "@carton/core/plugins";
import { startDev, type DevServer } from "./dev-server.ts";
import { stateDir } from "./state.ts";

const SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const TEAMS = { "cap-a": "studio", "cap-b": "studio" };
const dev: DevServer = await startDev({
  config: join(import.meta.dirname, "wrangler.r2.dev.toml"),
  state: stateDir(`dev-cap-${Date.now()}`),
  vars: { AUTH_SECRET: SECRET, TEAMS: JSON.stringify(TEAMS), WRITE_CAP_OPS_PER_DAY: "30" },
});
after(() => dev.stop());

const auth = createHmacAuth({ secret: SECRET });
const client = async (projectId: keyof typeof TEAMS, role: Role = "editor") =>
  hostMediaBlobs({ origin: dev.origin, projectId, token: await auth.issue({ account: "o", credential: "o/dev", role, projectId, ttlMs: 3600_000 }) });
const capped = (e: unknown) => e instanceof HostApiError && e.status === 429 && e.code === "DailyWriteCap";

test("once the daily operations cap is reached, writes are refused and HEADs of readable media go on (cf review finding 4)", async () => {
  const hasher = webCryptoHasher();
  const bytes = new Uint8Array(LEAF_SIZE + 999).map((_, i) => (i * 13 + 5) & 0xff);
  const manifest = await mediaHash(bytes, hasher);
  const key = mediaKey(manifest.hash), mf = manifestKey(manifest.hash);
  const a = await client("cap-a");
  assert.equal((await uploadMedia({ store: a, hasher, source: bytesSource(bytes), manifest })).deduped, false);
  // use up what is left of the day's operations with small writes of the project's own
  let refused: unknown = null;
  for (let i = 0; i < 40 && !refused; i++) await a.put(`notes/n${i}`, new Uint8Array([i])).catch((e: unknown) => (refused = e));
  assert.ok(capped(refused), `the cap never refused a write: ${refused}`);
  // the writer's project holds a grant; HEADs and batch HEADs, again and again, are answered, never 429
  for (let i = 0; i < 5; i++) assert.equal((await a.head(key))?.size, bytes.byteLength, `HEAD ${i}`);
  for (let i = 0; i < 3; i++) assert.deepEqual(await a.heads([key, mf]), [{ size: bytes.byteLength }, { size: manifest.bytes.byteLength }], `batch HEAD ${i}`);
  // a teammate's editor finds the team's copy (its first claim grants it), then HEADs it again
  const b = await client("cap-b");
  assert.deepEqual(await b.heads([key, mf]), [{ size: bytes.byteLength }, { size: manifest.bytes.byteLength }]);
  for (let i = 0; i < 3; i++) assert.equal((await b.head(key))?.size, bytes.byteLength);
  assert.deepEqual(await (await client("cap-b", "viewer")).get(key, { offset: LEAF_SIZE, length: 4 }), bytes.subarray(LEAF_SIZE, LEAF_SIZE + 4));
  // and the cap still holds for writes
  await assert.rejects(a.put("notes/after", new Uint8Array([1])), capped);
  await assert.rejects(b.put("notes/after", new Uint8Array([1])), capped);
});
