// H-SV (e2e-qa): every Cardboard client sends CARDBOARD_SCHEMA_VERSION in `hello`, and a host's sequencer refuses a
// client newer than the version it accepts. When `82d8c70` raised it to 2, both hosts still defaulted to 1 and live
// sync stalled without a word to the person. This reads each host's default from its source, in a workspace that has
// it (the integration branch, CI), and fails until a bump is matched there. A host whose default moved elsewhere fails
// too, so the check is updated rather than skipped.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CARDBOARD_SCHEMA_VERSION } from "@carton/cardboard";

const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const HOSTS: { file: string; what: string; pattern: RegExp }[] = [
  { file: "server-node/src/host.ts", what: "server-node's startNodeHost schemaVersion default", pattern: /schemaVersion:\s*opts\.schemaVersion\s*\?\?\s*(\d+)/ },
  { file: "server-cloudflare/src/room.ts", what: "server-cloudflare's SCHEMA_VERSION fallback", pattern: /SCHEMA_VERSION\s*\?\?\s*(\d+)/ },
  { file: "server-cloudflare/wrangler.toml", what: "server-cloudflare's wrangler.toml SCHEMA_VERSION", pattern: /^\s*SCHEMA_VERSION\s*=\s*"?(\d+)"?/m },
];

test("hosts accept the Cardboard schema version (H-SV): each host's default is at least CARDBOARD_SCHEMA_VERSION", (t) => {
  let checked = 0;
  for (const h of HOSTS) {
    const file = path.join(PACKAGES, h.file);
    if (!fs.existsSync(file)) {
      t.diagnostic(`${h.file}: not in this workspace, not checked`);
      continue;
    }
    const m = h.pattern.exec(fs.readFileSync(file, "utf8"));
    assert.ok(m, `${h.file}: ${h.what} is no longer where this check looks; update hosts-schema.ts`);
    assert.ok(Number(m[1]) >= CARDBOARD_SCHEMA_VERSION, `${h.what} accepts schemaVersion ${m[1]}, Cardboard clients send ${CARDBOARD_SCHEMA_VERSION}: live sync stalls (H-SV). Raise it with the bump.`);
    checked++;
  }
  t.diagnostic(`${checked} host defaults checked`);
});
