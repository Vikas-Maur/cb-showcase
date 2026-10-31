// Migration (§16): a bundle Cardboard's CLI wrote is read as main@1; a print of exactly that state maps its
// timestamp rev to main@1, an older print doesn't.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProjectForImport, recordLegacyRev } from "../src/node/migrate.ts";
import { toHost } from "../src/index.ts";

const SCRATCH = process.env.CARTON_SCRATCH ?? path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "test");
const FIX = fileURLToPath(new URL("../../conformance/src/cardboard/fixtures/sample/", import.meta.url));

test("a CLI-made bundle reads as main@1 with its project id; its own print's rev maps to it", async (t) => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const bundle = fs.mkdtempSync(path.join(SCRATCH, "migrate-"));
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  fs.copyFileSync(path.join(FIX, "project.json"), path.join(bundle, "project.json"));
  fs.copyFileSync(path.join(FIX, "timeline.tsx"), path.join(bundle, "timeline.tsx"));
  const env = JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8"));
  const imp = readProjectForImport(bundle);
  assert.equal(imp.projectId, env.project.id);
  assert.equal(imp.legacyRev, env.project.stateUpdatedAt, "the bundle's print shows this state");
  assert.equal(toHost(imp.doc).timelineItems!.length, env.project.timelineItems.length);
  const meta = new Map<string, unknown>();
  await recordLegacyRev({ putMeta: async (k, v) => void meta.set(JSON.stringify(k), v) }, imp.legacyRev, "main@1");
  assert.equal(meta.get(JSON.stringify(["legacy", String(env.project.stateUpdatedAt)])), "main@1");
  // an older print (its rev isn't this state's) gets no mapping: its base is gone, so it stays "state unknown"
  fs.writeFileSync(path.join(bundle, "timeline.tsx"), fs.readFileSync(path.join(bundle, "timeline.tsx"), "utf8").replace(/cardboard:rev \d+/, "cardboard:rev 1700000000000"));
  assert.equal(readProjectForImport(bundle).legacyRev, null);
});
