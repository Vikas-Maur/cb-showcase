// H-SV: the Worker as shipped takes the current Cardboard client. With SCHEMA_VERSION unset (wrangler.toml no longer
// pins it), the room accepts the adapter's CARDBOARD_SCHEMA_VERSION; a deployment may still pin one. (workerd.test.ts
// checks a hello through the real Worker.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CARDBOARD_SCHEMA_VERSION } from "@carton/cardboard";
import { schemaVersionOf } from "../src/room.ts";

test("H-SV: the room's schema version is the Cardboard adapter's unless a deployment pins one; wrangler.toml pins none below it", () => {
  assert.equal(schemaVersionOf({}), CARDBOARD_SCHEMA_VERSION);
  assert.equal(schemaVersionOf({ SCHEMA_VERSION: "" }), CARDBOARD_SCHEMA_VERSION);
  assert.equal(schemaVersionOf({ SCHEMA_VERSION: "7" }), 7);
  assert.throws(() => schemaVersionOf({ SCHEMA_VERSION: "two" }), /positive integer/);
  for (const f of ["wrangler.toml", "test/wrangler.r2.dev.toml", "test/wrangler.vault.dev.toml", "test/wrangler.r2.toml"]) {
    const pinned = /^\s*SCHEMA_VERSION\s*=\s*"(\d+)"/m.exec(readFileSync(join(import.meta.dirname, "..", f), "utf8"));
    if (pinned) assert.ok(Number(pinned[1]) >= CARDBOARD_SCHEMA_VERSION, `${f} pins SCHEMA_VERSION ${pinned[1]}, below the client's ${CARDBOARD_SCHEMA_VERSION}`);
  }
});
