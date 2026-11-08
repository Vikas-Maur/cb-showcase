// `cb restore <version> --clip <clip> --remove` on a shared cut (demo rehearsal, scripts/demo/FINDINGS.md §4.4): it
// took the clip out, and its version is "Took out '…'" (core's recall.test.ts), but cb's own answer said "Brought back
// “…” as it was in …": the lease holder waits for the sharing server on a shared cut, and that answer dropped what the
// write said of itself (`brought`), so cb couldn't tell a removal. Now it says "Took out “…”", as on a local cut.
// Through Cardboard 1.4.0's real (patched) library worker holding the shared cut, and Cardboard's real cb.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/restore-remove-shared.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { spawnSync } = require("child_process");
const { randomUUID } = require("crypto");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
let b, host, pc, id;

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  host = await S.startHost(path.join(S.TMP, "restore-remove-shared-host"));
  pc = await S.computer("restore-remove-shared", b);
  S.seed(pc, b);
  await pc.startWorker();
  [{ id }] = await pc.call("projects.list");
  const r = await pc.call("carton.liveShare", { projectId: id, host: host.origin, adminToken: S.ADMIN, name: "Alice" });
  assert.equal(r.status, "shared", JSON.stringify(r));
  await S.until(async () => (await pc.call("carton.liveStatus", { projectId: id })).status === "up-to-date", 20_000, "shared and up to date");
}, { timeout: S.SETUP_MS });
test.after(async () => {
  if (pc?.worker()) fs.writeFileSync(path.join(S.TMP, "restore-remove-shared-worker.log"), pc.worker().stderr());
  pc?.kill();
  S.killHelpers();
  await host?.stop().catch(() => {});
}, { timeout: S.STOP_MS });

test("on a shared cut, cb restore --clip --remove answers \"Took out “…”\", never \"Brought back\"", t, async () => {
  const before = pc.cb(["history", "Demo", "--limit", "1"]).json().versions[0].version;
  // a title the version before didn't have, added in the editor
  const doc = await S.projectOf(pc, id);
  const mediaId = randomUUID(), now = new Date().toISOString(), words = "Remove me later";
  const entry = { id: mediaId, createdAt: now, addedAt: now, data: { type: "text", presetId: "custom", content: words, fileName: "Text: " + words, format: "text", size: 0 } };
  const item = { id: randomUUID(), trackId: doc.tracks[0].id, type: "text", startTime: 8, endTime: 9, trimStart: 0, trimEnd: 1, name: words, textContent: words, mediaItemId: mediaId, fontSize: 60 };
  await pc.call("projects.updateScoped", { ...doc, timelineItems: [...doc.timelineItems, item], media: [...doc.media, entry], stateUpdatedAt: Math.max(Date.now(), doc.stateUpdatedAt + 1) }, { ownedFields: ["tracks", "timelineItems"], ownedMediaIds: [mediaId], carton: { base: doc.stateUpdatedAt, actor: "person" } });
  await S.until(async () => (await pc.call("carton.liveStatus", { projectId: id })).pending === 0 && pc.cb(["history", "Demo", "--limit", "1"]).json().versions[0].version !== before, 20_000, "the title confirmed");
  // as an agent runs it: text, not --json
  const r = spawnSync(process.execPath, [path.join(b.cli, "cardboard.mjs"), "--root", pc.root, "restore", "Demo", before, "--clip", words, "--remove"], { env: { ...pc.env, CARDBOARD_ACTOR: "director/chat1/turn9" }, encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^Took out “Remove me later”: it wasn't in /m, r.stdout);
  assert.doesNotMatch(r.stdout, /Brought back/);
  assert.ok(!S.fileOf(pc).timelineItems.some((i) => i.name === words), "taken out");
});
