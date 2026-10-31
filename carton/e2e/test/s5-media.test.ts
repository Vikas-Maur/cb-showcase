// Scenario 5: media between two machines (PLAN §11, §22 phase 4). The owner and a teammate each run in their own
// process with their own disk cache and upload record; the store is real: a shared folder (blob-fs), a local S3
// gateway (blob-s3 on VersityGW), or a server-node host through its HTTP media API (resumable uploads, signed URLs).
// Links between a machine and its store are TCP proxies, so a cut link is a connection reset mid-request.
//   - share the sample project's clip (the camera original, opted in, and Cardboard's own proxy reused as the collab
//     proxy); the teammate's process reads both back and every byte verifies against the manifest; sharing it again,
//     or from the teammate's machine with the same footage, sends nothing; offline, the teammate replays from cache;
//   - the clip's content id rides in the project: the owner commits the share result into the media record through
//     Carton, and a teammate with a copy of the project finds it in its own head, follows it to the proxy and plays;
//   - resume after the uploader's process is killed mid-upload, after its link is cut mid-part, and after the host
//     restarts: only the parts that never landed go up again, well under twice the file, and the object verifies; a
//     host that lost the open upload makes the uploader start over instead of failing; two processes of one machine
//     resuming the same saved upload both succeed; a teammate's download reset mid-stream carries on from the break;
//   - a teammate streaming the proxy before its upload finishes (the plan's behaviour: a known gap, kept as todo), and
//     what is promised today: the uploader plays its own proxy at once, the teammate as soon as the upload completes
//     (ranges, tools through the loopback range server), and bad bytes in the store are never handed to a tool. The
//     upload's completion is held in those cases (s5-machine's `holdComplete`), so "while it uploads" is a fact, not
//     a race with the runner's speed;
//   - bugs and gaps found here, each a minimal `todo` test named after its id while open (S5-2, S5-3): signed media
//     URLs from a host reached through a proxy or a port map; the same footage in two projects of one team. Fixed ones
//     stay as normal tests (S5-1, S5-4, S5-5, S5-6 offline replay of a proxy stream, S5-7 re-sharing through a host,
//     and an upload the store dropped mid-way, which now starts over once within the same call).
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { closeHashWorkers, hashFile } from "@carton/media/node";
import { locateCartonDb } from "@carton/store-sqlite";
import { cbWrite, setOp } from "../support/cb.ts";
import { makeMachine, readEnvelope, type Machine } from "../support/project.ts";
import { Procs, runOnce, type Proc } from "../support/procs.ts";
import { dataDirFor, scratch, support, until } from "../support/env.ts";
import { Link } from "../support/s5-link.ts";
import { FFMPEG, FFPROBE, haveFfmpeg, hostStore, makeClips, MiB, openSide, placeHostProxy, placeOriginal, s3MissingReason, sampleVideo, startHost, startMachine, stopGateway, type Clips, type StoreKind, type StoreSide } from "../support/s5-stores.ts";

const run = promisify(execFile);
const FF = haveFfmpeg();
const NO_FF = !FF && "ffmpeg/ffprobe not on PATH";
const S3_SKIP = (await s3MissingReason()) ?? false;
const KEEP = !!process.env.CARTON_E2E_KEEP;
const skipFor = (kind: StoreKind) => (kind === "blob-s3" ? S3_SKIP : false);
/** Requests with no body (HEADs, a signed-URL request): what "uploads nothing" may still send up. */
const CHATTER = 64 * 1024;

let clipsDir = "";
let clips: Clips;
before(() => {
  clipsDir = scratch("s5-clips");
  clips = makeClips(clipsDir);
});
after(async () => {
  closeHashWorkers();
  await stopGateway();
  if (!KEEP) rmSync(clipsDir, { recursive: true, force: true });
});

const fileSha = (path: string, from = 0, to?: number) => createHash("sha256").update(readFileSync(path).subarray(from, to)).digest("hex");
/**
 * A file's packets per track as ffprobe reads them: each packet's size and SHA-256 of its payload, in order, keyed by
 * track type ("video", "audio"). Equal across containers exactly when every track's coded frames are the same bytes in
 * the same order (a repackaging, no re-encode, nothing dropped).
 */
async function mediaPackets(path: string): Promise<Record<string, string[]>> {
  const r = await run(FFPROBE, ["-v", "error", "-show_data_hash", "sha256", "-show_entries", "packet=codec_type,size,data_hash", "-of", "csv=p=0", path], { timeout: 60_000, maxBuffer: 64 << 20 });
  const tracks: Record<string, string[]> = {};
  for (const line of r.stdout.trim().split(/\r?\n/)) {
    const [type, size, hash] = line.split(",");
    if (type && hash) (tracks[type] ??= []).push(`${size} ${hash}`);
  }
  return tracks;
}

/** `played` carries the same coded video and audio as `source`, and the source has both tracks. */
async function assertSameMedia(played: string, source: string, what: string): Promise<void> {
  const [got, want] = [await mediaPackets(played), await mediaPackets(source)];
  assert.ok(want.video?.length && want.audio?.length, `the source has video and audio: ${Object.keys(want)}`);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${what}: the same tracks`);
  for (const k of Object.keys(want)) assert.ok(got[k]!.length === want[k]!.length && got[k]!.every((x, n) => x === want[k]![n]), `${what}: every ${k} packet the same bytes (${got[k]!.length} vs ${want[k]!.length})`);
}
const statePath = (m: Machine, hash: string) => join(m.home, "uploads", `m_${hash}.json`);
/** The parts a machine's FsUploadStateStore has recorded for an open upload (read briefly: the app renames over it). */
function recorded(m: Machine, hash: string): { parts: number; bytes: number } {
  try {
    const parts = (JSON.parse(readFileSync(statePath(m, hash), "utf8")) as { parts: { size: number }[] }).parts;
    return { parts: parts.length, bytes: parts.reduce((n, p) => n + p.size, 0) };
  } catch {
    return { parts: 0, bytes: 0 };
  }
}
const partsRecorded = (m: Machine, hash: string) => recorded(m, hash).parts;
/** How often the state file is polled: rarely, since on Windows a reader can make the uploader's rename retry. */
const POLL = 200;
const uploaded = (events: any[], what: string) => events.find((e) => e.type === "uploaded" && e.what === what)?.result;

interface World {
  procs: Procs;
  dir: string;
  owner: Machine;
  mate: Machine;
  side: StoreSide;
  /** A new link to the store (null for a shared folder, which has none). */
  link(rate?: number): Promise<Link | null>;
}

async function world(t: TestContext, kind: StoreKind, moreProjects: string[] = []): Promise<World> {
  const procs = new Procs();
  const dir = scratch(`s5-${kind}`);
  const owner = makeMachine("s5-owner");
  const mate = makeMachine("s5-mate", owner); // the project's files, before any media is on the owner's disk
  const links: Link[] = [];
  t.after(async () => {
    await procs.close();
    await Promise.all(links.map((l) => l.close()));
    if (!KEEP) for (const d of [dir, owner.home, mate.home]) rmSync(d, { recursive: true, force: true });
  });
  const side = await openSide(kind, procs, dir, owner.projectId, moreProjects);
  const link = async (rate = 0) => {
    if (side.target === null) return null;
    const l = await Link.open(side.target, { rate });
    links.push(l);
    return l;
  };
  return { procs, dir, owner, mate, side, link };
}

/** Reads a response to its end, or to where the server broke it off. */
async function fetchAll(url: string, init?: RequestInit): Promise<{ status: number; headers: Headers; bytes: Buffer; complete: boolean }> {
  const res = await fetch(url, init);
  const parts: Buffer[] = [];
  let complete = true;
  try {
    for await (const c of res.body ?? []) parts.push(Buffer.from(c as Uint8Array));
  } catch {
    complete = false;
  }
  return { status: res.status, headers: res.headers, bytes: Buffer.concat(parts), complete };
}

/** A promise's state without waiting for it. */
function settled(p: Promise<unknown>): () => boolean {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  return () => done;
}

// ------------------------------------------------------------------ 1. share a clip, read it back, dedup

for (const kind of ["blob-fs", "blob-s3", "host-http"] as const) {
  test(`S5 share a clip through ${kind}: the teammate's process reads every byte back verified; sharing it again, or from the teammate's machine with the same footage, uploads nothing; offline, the teammate replays from its cache`, {
    timeout: 240_000,
    skip: NO_FF || skipFor(kind),
  }, async (t) => {
    const w = await world(t, kind);
    const original = placeOriginal(w.owner, clips.original);
    const hostProxy = placeHostProxy(w.owner, clips.hostProxy);
    const { record } = sampleVideo(w.owner);
    const want = { original: await hashFile(original) };
    const ownerLink = await w.link();
    const mateLink = await w.link();

    // --- the owner shares the clip: the original (opted in), and Cardboard's own proxy as the collab proxy, repackaged
    // (no encode) into a segmented stream a teammate can play while it uploads (media's stream model, §11)
    const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner", ownerLink));
    const r = await owner.ask({ cmd: "share", record, original, hostProxy, originals: true }, 120_000);
    assert.equal(r.record.hash, want.original.hash, "the clip is named by its content");
    assert.equal(r.record.size, want.original.size);
    assert.equal(r.record.original, "shared");
    const proxy = r.record.proxy;
    assert.match(String(proxy?.stream), /^[0-9a-f]{64}$/, `the collab proxy is a stream: ${JSON.stringify(proxy)}`);
    assert.deepEqual([proxy.encoder, proxy.hash], ["cardboard-proxy", undefined], "Cardboard's proxy, repackaged, not encoded; no single object");
    assert.ok(Number.isInteger(proxy.size) && proxy.size > 0, "the finished stream's size is in the record");
    assert.ok(r.events.some((e: any) => e.type === "proxy" && e.how === "host's" && e.stream === proxy.stream), "made from the host's proxy");
    const up = uploaded(r.events, "original");
    assert.equal(up.deduped, false);
    assert.ok(up.partsSent >= 2, `the original went up in parts (${up.partsSent} × ${up.partSize})`);
    assert.equal(up.partsSent, Math.ceil(want.original.size / up.partSize));
    if (ownerLink) assert.ok(ownerLink.upBytes >= want.original.size + proxy.size, "the bytes went over the owner's link");

    // --- the teammate's process plays the stream as a player does: every part verifies, and what it played is the
    // owner's proxy, packet for packet (ffprobe); then reads the original back, verified against its id
    const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate", mateLink));
    const played = join(w.mate.home, "played.mp4");
    const px = await mate.ask({ cmd: "play", stream: proxy.stream, save: played }, 60_000);
    assert.equal(px.failed, undefined, px.failed);
    assert.equal(px.bytes, proxy.size, "init plus every segment: the record's size");
    assert.ok(px.init > 0 && px.segments >= 1 && px.ended?.segments === px.segments, `played to the stream's end: ${JSON.stringify(px)}`);
    assert.deepEqual(px.events, [], "no leaf failed its check");
    if (FF) await assertSameMedia(played, hostProxy, "the played stream is the owner's proxy");
    const og = await mate.ask({ cmd: "read", hash: want.original.hash, mode: "tool" }, 60_000);
    assert.equal(og.failed, undefined, og.failed);
    assert.equal(og.mediaHash, want.original.hash, "the original's bytes hash to its id");
    assert.equal(og.sha256, fileSha(original));

    // --- sharing the same clip again (the record lost its ids, as after a re-import): nothing goes up
    const before = ownerLink?.upBytes ?? 0;
    const again = await owner.ask({ cmd: "share", record, original, hostProxy, originals: true }, 60_000);
    assert.equal(again.record.hash, want.original.hash);
    assert.equal(again.record.proxy?.stream, proxy.stream, "the same stream");
    assert.deepEqual([uploaded(again.events, "original")?.deduped, uploaded(again.events, "original")?.bytesSent], [true, 0], "the original is already there");
    assert.ok(again.events.some((e: any) => e.type === "proxy" && e.how === "teammate's" && e.stream === proxy.stream), "the proxy is found through its pointer");
    assert.ok(!again.events.some((e: any) => e.type === "proxy" && (e.how === "streaming" || e.how === "host's" || e.how === "encoded")), "no new stream is made");
    if (ownerLink) assert.ok(ownerLink.upBytes - before < CHATTER, `sharing again sent ${ownerLink.upBytes - before} bytes up`);

    // --- the teammate has the same footage (the camera card's copy): their share uploads nothing either
    const theirs = placeOriginal(w.mate, clips.original);
    const mateBefore = mateLink?.upBytes ?? 0;
    const s = await mate.ask({ cmd: "share", record: sampleVideo(w.mate).record, original: theirs, hostProxy: null, originals: true }, 60_000);
    assert.equal(s.record.hash, want.original.hash, "the same footage has the same id on another machine");
    assert.equal(s.record.proxy?.stream, proxy.stream, "the teammate gets the owner's proxy stream, with no encode");
    assert.equal(uploaded(s.events, "original")?.deduped, true);
    if (mateLink) assert.ok(mateLink.upBytes - mateBefore < CHATTER, `the teammate's share sent ${mateLink.upBytes - mateBefore} bytes up`);
  });
}

// S5-6 (fixed by media; was todo): a teammate who played a stream proxy couldn't play it again offline. Its segments' bytes are in the disk cache
// (MediaReader), but the stream's entries (ps/<stream>/init, /s/<n>, /end) are read from the store on every play and
// never cached, so the player can't even find the init segment with the store unreachable. Before streams, a whole
// proxy replayed offline (this scenario's old check).
test("S5-6 offline: a teammate who played the proxy stream replays it from the disk cache with the store unreachable", {
  timeout: 240_000,
  skip: NO_FF || S3_SKIP,
}, async (t) => {
  const w = await world(t, "blob-s3");
  const original = placeOriginal(w.owner, clips.original);
  const hostProxy = placeHostProxy(w.owner, clips.hostProxy);
  const { record } = sampleVideo(w.owner);
  const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner", await w.link()));
  const stream = (await owner.ask({ cmd: "share", record, original, hostProxy, originals: false }, 120_000)).record.proxy?.stream;
  assert.ok(stream, "shared as a stream");
  const mateLink = (await w.link())!;
  const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate", mateLink));
  const online = await mate.ask({ cmd: "play", stream }, 60_000);
  assert.equal(online.failed, undefined, online.failed);
  await mate.kill();
  mateLink.drop();
  const off = await startMachine(w.procs, "mate-offline", w.mate.home, w.side.storeFor("mate", mateLink));
  const again = await off.ask({ cmd: "play", stream }, 60_000);
  assert.equal(again.failed, undefined, again.failed);
  assert.equal(again.sha256, online.sha256, "the same bytes, from this machine's cache");
});

// The teammate learns which footage the project uses, and where its proxy is, from the project itself: `contentHash`
// and `shared` (S5-G3: size, original, the proxy ref) are versioned fields of the media entry (PLAN §4.2, §11). Nothing
// in the product writes the share result into the record yet (S5-G2, routed in the notes), so the owner's side does it
// as the app would: one `cb` write handed to its app's lease holder.
test("S5 the shared clip's record rides in the project: the owner commits it through Carton, the teammate finds the clip and its proxy stream in its own copy's head and plays both, verified", { timeout: 240_000, skip: NO_FF }, async (t) => {
  const w = await world(t, "host-http");
  w.procs.watchHelpers(w.owner.dbDir);
  const app = w.procs.start("owner-app", [support("app.ts"), w.owner.bundle, w.owner.projectId, "{}"]);
  const { dbPath } = await app.next((x) => x.ready, 60_000);
  const original = placeOriginal(w.owner, clips.original);
  const hostProxy = placeHostProxy(w.owner, clips.hostProxy);
  const { record } = sampleVideo(w.owner);
  const want = { original: await hashFile(original) };

  // --- the owner shares the clip, then commits its content id into the project's media record
  const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner"));
  const shared = (await owner.ask({ cmd: "share", record, original, hostProxy, originals: true }, 120_000)).record;
  assert.equal(shared.hash, want.original.hash);
  // the content id and the shared record (S5-G3, cardboard-adapter 82d8c70: `media[].shared` is versioned field by field)
  const at = (...path: string[]) => ["media", String(record.id), ...path];
  const put = await cbWrite(w.owner, { kind: "commit", ops: [
    setOp("media", String(record.id), "contentHash", shared.hash),
    { op: "set", path: at("shared", "size"), value: shared.size },
    { op: "set", path: at("shared", "original"), value: shared.original },
    { op: "set", path: at("shared", "proxy"), value: shared.proxy },
  ] });
  assert.equal(put.status, "confirmed", JSON.stringify(put));

  // --- the teammate gets the project: a copy of the owner's carton.db (support/clone.ts). Its files were copied before
  // anything was shared, so the id can only come from its Carton
  const mateDb = locateCartonDb({ bundleDir: w.mate.bundle, projectId: w.mate.projectId, appDataDir: dataDirFor(w.mate.bundle) }).dbPath;
  const cl = await runOnce("clone", [support("clone.ts"), dbPath, mateDb]);
  assert.equal(cl.code, 0, cl.stderr);
  const filed = readEnvelope(w.mate).project.media.find((m: any) => m.id === record.id);
  assert.equal(filed?.contentHash, undefined, "the teammate's project.json doesn't carry the id");
  const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate"));
  const proj = await mate.ask({ cmd: "project", bundle: w.mate.bundle, projectId: w.mate.projectId });
  assert.equal(proj.dbPath, mateDb, "read from the teammate's own carton.db");
  const entry = proj.media.find((m: any) => m.id === record.id);
  const hash = entry?.contentHash;
  assert.equal(hash, want.original.hash, "the teammate's head names the clip by its content");
  assert.deepEqual(entry?.shared, { size: shared.size, original: "shared", proxy: shared.proxy }, "and carries the shared record (S5-G3)");

  // --- from the project alone: the proxy stream its record names (the store's pointer agrees), then both read back,
  // every byte verified
  const stream = entry.shared.proxy.stream;
  assert.match(String(stream), /^[0-9a-f]{64}$/);
  const { pointer } = await mate.ask({ cmd: "proxyOf", hash });
  assert.equal(pointer?.stream, stream, `the store's pointer names the same stream: ${JSON.stringify(pointer)}`);
  const px = await mate.ask({ cmd: "play", stream, save: join(w.mate.home, "played.mp4") }, 60_000);
  assert.equal(px.failed, undefined, px.failed);
  assert.equal(px.bytes, shared.proxy.size, "every part, as the owner's record sizes it");
  assert.deepEqual(px.events, [], "no leaf failed its check");
  await assertSameMedia(join(w.mate.home, "played.mp4"), hostProxy, "the played stream is the owner's proxy");
  const og = await mate.ask({ cmd: "read", hash, mode: "tool" }, 60_000);
  assert.equal(og.failed, undefined, og.failed);
  assert.equal(og.mediaHash, want.original.hash, "the original's bytes hash to the id the project names");
  assert.equal(og.sha256, fileSha(original));
});

// ------------------------------------------------------------------ 2. resume after a cut link

for (const kind of ["blob-s3", "host-http"] as const) {
  test(`S5 resume after the uploader's process is killed mid-upload (${kind}): the restarted share sends only the missing parts and the object verifies`, { timeout: 240_000, skip: skipFor(kind) }, async (t) => {
    const w = await world(t, kind);
    const original = placeOriginal(w.owner, clips.big);
    const { record } = sampleVideo(w.owner);
    const want = await hashFile(original);
    const link = (await w.link(8 * MiB))!; // a slow link, so the kill lands mid-upload
    const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner", link));
    const share = owner.ask({ cmd: "share", record, original, originals: true, proxies: false }, 120_000);
    share.catch(() => {}); // it dies with the process
    await until(() => partsRecorded(w.owner, want.hash) >= 1, 60_000, "a first part recorded by the uploader", POLL);
    await owner.kill(); // the app is killed (crash, power loss)
    const sentBefore = link.upBytes;
    const atKill = recorded(w.owner, want.hash);
    assert.ok(sentBefore < want.size && atKill.bytes < want.size, "killed before the upload finished");

    const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate"));
    assert.equal((await mate.ask({ cmd: "stat", hash: want.hash })).stat, null, "the teammate doesn't see a half-uploaded original");

    link.rate = 0;
    const again = await startMachine(w.procs, "owner-again", w.owner.home, w.side.storeFor("owner", link));
    const r = await again.ask({ cmd: "share", record, original, originals: true, proxies: false }, 120_000);
    const u = uploaded(r.events, "original");
    t.diagnostic(JSON.stringify({ size: want.size, partSize: u.partSize, recordedAtKill: atKill, resumedParts: u.resumedParts, partsSent: u.partsSent, bytesSent: u.bytesSent, sentBeforeKill: sentBefore, sentAfter: link.upBytes - sentBefore }));
    assert.equal(u.deduped, false);
    // the store's part list is the truth: a part that landed after the record was last written still counts
    assert.ok(u.resumedParts >= atKill.parts && u.resumedParts >= 1, "the restarted upload resumed from the parts that landed");
    assert.equal(u.resumedParts + u.partsSent, Math.ceil(want.size / u.partSize), "every part once");
    assert.ok(u.bytesSent <= want.size - atKill.bytes, `sent ${u.bytesSent} bytes after the restart; ${want.size - atKill.bytes} were missing`);
    assert.ok(link.upBytes < 2 * want.size, `${link.upBytes} bytes went up for a ${want.size}-byte file`);
    assert.equal(partsRecorded(w.owner, want.hash), 0, "the upload record is gone once complete");

    const back = await mate.ask({ cmd: "read", hash: want.hash, mode: "tool" }, 60_000);
    assert.equal(back.failed, undefined, back.failed);
    assert.equal(back.mediaHash, want.hash, "the resumed object verifies");
    assert.equal(back.sha256, fileSha(original));
  });

  test(`S5 resume after the link is cut mid-part (${kind}): a TCP reset after 20 MiB, the upload stops, a restarted process resumes`, { timeout: 240_000, skip: skipFor(kind) }, async (t) => {
    const w = await world(t, kind);
    const want = await hashFile(clips.big);
    const link = (await w.link())!;
    const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner", link));
    const cut = link.cutAfter(20 * MiB);
    const first = owner.ask({ cmd: "upload", path: clips.big, contentType: "video/mp4", retries: 2, retryDelayMs: 100 }, 120_000);
    await cut;
    await assert.rejects(first, /fetch failed|terminated|ECONNRESET|socket|other side closed|network/i, "the upload stops while the link is down");
    await owner.kill();
    const landed = recorded(w.owner, want.hash);
    assert.ok(landed.parts >= 1, "parts that landed before the cut are recorded");

    link.restore();
    const sentBefore = link.upBytes;
    const again = await startMachine(w.procs, "owner-again", w.owner.home, w.side.storeFor("owner", link));
    const r = (await again.ask({ cmd: "upload", path: clips.big, contentType: "video/mp4" }, 120_000)).result;
    t.diagnostic(JSON.stringify({ size: want.size, partSize: r.partSize, recordedAtCut: landed, resumedParts: r.resumedParts, partsSent: r.partsSent, sentBeforeCut: sentBefore, sentAfter: link.upBytes - sentBefore }));
    assert.ok(r.resumedParts >= landed.parts, "resumed from the recorded parts");
    assert.equal(r.resumedParts + r.partsSent, Math.ceil(want.size / r.partSize), "every part once");
    assert.ok(r.bytesSent <= want.size - landed.bytes, `sent ${r.bytesSent} bytes after the restart; ${want.size - landed.bytes} were missing`);
    assert.ok(link.upBytes < 2 * want.size, `${link.upBytes} bytes went up for a ${want.size}-byte file`);

    const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate"));
    const back = await mate.ask({ cmd: "read", hash: want.hash, mode: "play" }, 60_000);
    assert.equal(back.failed, undefined, back.failed);
    assert.equal(back.mediaHash, want.hash);
    assert.deepEqual(back.events, []);
  });
}

for (const kind of ["blob-s3", "host-http"] as const) {
  test(`S5 a teammate's download is reset mid-stream twice (${kind}): the read carries on from each break and every byte verifies`, { timeout: 180_000, skip: skipFor(kind) }, async (t) => {
    const w = await world(t, kind);
    const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner"));
    const { result } = await owner.ask({ cmd: "upload", path: clips.big, contentType: "video/mp4" }, 120_000);
    const link = (await w.link())!;
    const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate", link));
    let cuts = 0;
    const read = mate.ask({ cmd: "read", hash: result.hash, mode: "play" }, 120_000);
    // a flaky link: every connection is reset once 6 MiB more came down, then it works again
    void link.cutAfter(6 * MiB + 1234, { direction: "down", stayDown: false }).then(() => {
      cuts++;
      return link.cutAfter(9 * MiB + 77, { direction: "down", stayDown: false }).then(() => cuts++);
    });
    const r = await read;
    t.diagnostic(JSON.stringify({ size: result.size, downBytes: link.downBytes, cuts, events: r.events }));
    assert.equal(cuts, 2, "the download was reset twice");
    assert.equal(r.failed, undefined, r.failed);
    assert.equal(r.bytes, result.size);
    assert.equal(r.mediaHash, result.hash, "every byte verifies");
    assert.deepEqual(r.events.filter((e: any) => e.type === "served-bad"), [], "nothing bad went to the player");
    assert.ok(link.downBytes < 1.5 * result.size, `${link.downBytes} bytes came down for ${result.size}: resumed from the breaks, not from scratch`);
  });
}

for (const kind of ["blob-s3", "host-http"] as const) {
  test(`S5 two processes on one machine (the app and a cb call) resume the same saved upload at once (${kind}): both succeed and the object verifies`, { timeout: 240_000, skip: skipFor(kind) }, async (t) => {
    const w = await world(t, kind);
    const want = await hashFile(clips.big);
    const link = (await w.link(8 * MiB))!;
    const first = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner", link));
    first.ask({ cmd: "upload", path: clips.big, contentType: "video/mp4" }, 120_000).catch(() => {}); // dies with it
    await until(() => partsRecorded(w.owner, want.hash) >= 1, 60_000, "a first part recorded by the uploader", POLL);
    await first.kill();
    link.rate = 0;
    // both find the same saved upload (one FsUploadStateStore on this machine) and resume it together
    const [app, cb] = await Promise.all([startMachine(w.procs, "app", w.owner.home, w.side.storeFor("owner", link)), startMachine(w.procs, "cb", w.owner.home, w.side.storeFor("owner", link))]);
    const ask = { cmd: "upload", path: clips.big, contentType: "video/mp4" };
    const [a, b] = (await Promise.all([app.ask(ask, 120_000), cb.ask(ask, 120_000)])).map((x) => x.result);
    t.diagnostic(JSON.stringify({ size: want.size, app: a, cb: b }));
    for (const r of [a, b]) assert.equal(r.hash, want.hash);
    assert.equal(partsRecorded(w.owner, want.hash), 0, "the shared upload record is gone");
    const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate"));
    const got = await mate.ask({ cmd: "read", hash: want.hash, mode: "tool" }, 60_000);
    assert.equal(got.failed, undefined, got.failed);
    assert.equal(got.mediaHash, want.hash, "the object both completed verifies");
  });
}

// Minimal case for S5-4 on the host only: an S3 gateway aborted while a part is in flight can take that part and
// revive the upload (VersityGW does; S3 documents in-flight parts "might or might not succeed"), which makes the drop
// racy there. The concurrent-resume test above shows the same waste on S3 in its diagnostics.
// (S5-4, fixed in media d5508fb1: uploadMedia retried uploadPart on NoSuchUpload, re-sending every in-flight part up to
// 5 times to an upload that could never take it)
// The host drops an open upload (expired, or completed by another process) with no object behind it. Since media's CI
// #27 fix (14222eb) the uploader starts the upload over within the same call (the orchestrator's decision, CI #28: the
// person never has to retry, and a retry would re-send the whole file anyway). Bound: the parts that were in flight when
// it was dropped, plus at most one full re-upload; one restart at most (a new upload on the host), and the object intact.
test("an upload the store dropped mid-way starts over once within the same call: at most the parts in flight plus one full re-upload, and the object verifies (host-http)", {
  timeout: 180_000,
}, async (t) => {
  const w = await world(t, "host-http");
  const want = await hashFile(clips.big);
  const link = (await w.link(8 * MiB))!;
  const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner", link));
  const up = owner.ask({ cmd: "upload", path: clips.big, contentType: "video/mp4", retryDelayMs: 50 }, 120_000).then((r) => r.result, (e: Error) => e);
  await until(() => partsRecorded(w.owner, want.hash) >= 1, 60_000, "a first part recorded by the uploader", POLL);
  const st = JSON.parse(readFileSync(statePath(w.owner, want.hash), "utf8")) as { uploadId: string; partSize: number };
  const uploadsDir = join(w.side.host!.blobRoot, "uploads");
  rmSync(join(uploadsDir, st.uploadId), { recursive: true, force: true }); // the host drops it
  const atDrop = link.upBytes;
  // every upload the host opens after the drop (a folder per upload id; a full re-upload lives for seconds on this link)
  const opened = new Set<string>();
  const watch = setInterval(() => { try { for (const id of readdirSync(uploadsDir)) if (id !== st.uploadId) opened.add(id); } catch { /* not there yet */ } }, 25);
  const outcome = await up;
  clearInterval(watch);
  const after = link.upBytes - atDrop;
  t.diagnostic(JSON.stringify({ size: want.size, partSize: st.partSize, bytesUpAfterTheDrop: after, uploadsOpenedAfterTheDrop: opened.size, outcome: outcome instanceof Error ? outcome.message : outcome }));
  assert.ok(!(outcome instanceof Error), `the call carried on to the end: ${outcome instanceof Error ? outcome.message : ""}`);
  assert.deepEqual([outcome.hash, outcome.size, outcome.deduped], [want.hash, want.size, false], "the whole object, uploaded");
  assert.ok(opened.size <= 1, `started over at most once (${opened.size} new uploads on the host)`);
  assert.ok(after <= 2 * st.partSize + want.size + CHATTER, `${after} bytes went up after the drop; at most the 2 parts in flight plus one full re-upload should`);
  assert.equal(partsRecorded(w.owner, want.hash), 0, "no open upload left recorded");
  // the object is intact: a teammate's process reads every byte back, verified against its id
  const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate"));
  const back = await mate.ask({ cmd: "read", hash: want.hash, mode: "verified" }, 120_000);
  assert.equal(back.failed, undefined, back.failed);
  assert.equal(back.mediaHash, want.hash, "every byte verifies against the clip's id");
});

test("S5 the host restarts mid-upload, then loses an open upload: the uploader resumes after the restart, and starts over when the host no longer knows its upload", { timeout: 240_000 }, async (t) => {
  const w = await world(t, "host-http");
  const want = await hashFile(clips.big);
  const link = (await w.link(8 * MiB))!; // the host's public address; it points at whichever port the host has now
  const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner", link));
  const first = owner.ask({ cmd: "upload", path: clips.big, contentType: "video/mp4", retries: 1, retryDelayMs: 100 }, 120_000);
  await until(() => partsRecorded(w.owner, want.hash) >= 1, 60_000, "a first part recorded by the uploader", POLL);
  await w.side.host!.proc.kill(); // the host crashes mid-upload
  await assert.rejects(first, "the upload stops while the host is gone");
  const atCrash = recorded(w.owner, want.hash);

  // the host comes back (another port, same data): the same uploader process tries again
  const back = await startHost(w.procs, join(w.dir, "host"), [w.owner.projectId]);
  link.retarget(back.port);
  link.rate = 0;
  const r = (await owner.ask({ cmd: "upload", path: clips.big, contentType: "video/mp4" }, 120_000)).result;
  t.diagnostic(JSON.stringify({ size: want.size, recordedAtCrash: atCrash, resumedParts: r.resumedParts, partsSent: r.partsSent, bytesSent: r.bytesSent }));
  assert.ok(r.resumedParts >= Math.max(1, atCrash.parts), "the parts the old host process stored survive its restart");
  assert.ok(r.bytesSent <= want.size - atCrash.bytes);
  const mate = await startMachine(w.procs, "mate", w.mate.home, hostStore(back, w.owner.projectId, "mate"));
  const got = await mate.ask({ cmd: "read", hash: want.hash, mode: "tool" }, 60_000);
  assert.equal(got.mediaHash, want.hash);

  // another clip: the uploader is killed mid-upload, and the host loses the open upload (expired, cleaned up)
  const other = await hashFile(clips.original);
  link.rate = 4 * MiB;
  const o2 = await startMachine(w.procs, "owner-2", w.owner.home, w.side.storeFor("owner", link));
  const second = o2.ask({ cmd: "upload", path: clips.original, contentType: "video/mp4" }, 120_000);
  second.catch(() => {});
  await until(() => partsRecorded(w.owner, other.hash) >= 1, 60_000, "a first part of the second clip recorded", POLL);
  await o2.kill();
  // what an expiry does: the open upload's own folder goes (blob-fs keeps uploads/<id>/)
  const open = join(back.blobRoot, "uploads");
  assert.ok(readdirSync(open).length >= 1, "the host holds the open upload");
  for (const id of readdirSync(open)) rmSync(join(open, id), { recursive: true, force: true });
  link.rate = 0;
  const o3 = await startMachine(w.procs, "owner-3", w.owner.home, w.side.storeFor("owner", link));
  const fresh = (await o3.ask({ cmd: "upload", path: clips.original, contentType: "video/mp4" }, 120_000)).result;
  assert.equal(fresh.resumedParts, 0, "nothing to resume: the host forgot the upload");
  assert.equal(fresh.partsSent, Math.ceil(other.size / fresh.partSize), "started over instead of failing");
  assert.equal(partsRecorded(w.owner, other.hash), 0, "the stale record is gone");
  const got2 = await mate.ask({ cmd: "read", hash: other.hash, mode: "tool" }, 60_000);
  assert.equal(got2.mediaHash, other.hash);
});

// ------------------------------------------------------------------ 3. a proxy while it uploads

interface HeldUpload {
  owner: Proc;
  hash: string;
  size: number;
  upload: Promise<any>;
  /** Neither the store's `complete` was called nor the upload answered: true until `release()`, on any runner. */
  incomplete(): boolean;
  /** Lets the upload complete. */
  release(): Promise<void>;
}

/**
 * The owner uploads the collab proxy with its completion held (s5-machine's `holdComplete`): the parts go up, the
 * object can't be completed until `release()`. Resolves once the first part has landed.
 */
async function heldProxyUpload(w: World): Promise<HeldUpload> {
  const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner"));
  const upload = owner.ask({ cmd: "upload", path: clips.proxy, contentType: "video/mp4", holdComplete: true }, 120_000);
  const done = settled(upload);
  const { hashed: hash, size } = await owner.next((x) => x.hashed);
  await owner.next((x) => x.progress && x.progress.done > 0, 60_000);
  return {
    owner,
    hash,
    size,
    upload,
    incomplete: () => !done() && !owner.lines.some((x) => x.completeSent),
    release: async () => assert.equal((await owner.ask({ cmd: "release" })).released, true, "the upload's completion was held"),
  };
}

// PLAN §22 phase 4 (S5-1, fixed by media's segmented proxies): the owner's share holds the stream's entry for segment 1
// (and so everything after it), so the stream is still uploading while the teammate plays: the player gets the init
// segment and segment 0, then waits; once the entry goes up the same playback carries on to the stream's end.
test("S5 a teammate streams the proxy before its upload finishes (PLAN §22 phase 4)", { timeout: 240_000, skip: NO_FF }, async (t) => {
  const w = await world(t, "host-http");
  const original = placeOriginal(w.owner, clips.original);
  const hostProxy = placeHostProxy(w.owner, clips.hostProxy);
  const { record } = sampleVideo(w.owner);
  const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner"));
  const sharing = owner.ask({ cmd: "share", record, original, hostProxy, originals: false, holdSegment: 1 }, 180_000);
  sharing.catch(() => {});
  try {
    const held = await Promise.race([
      owner.next((x) => x.entryHeld, 120_000),
      sharing.then((r) => { throw new Error(`the share finished without reaching segment 1 (a one-segment proxy?): ${JSON.stringify(r.record?.proxy)}`); }),
    ]);
    const stream = String(held.entryHeld).split("/")[1]!;
    const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate"));
    // the teammate learns the stream from the source's pointer, as from the project's record, while it uploads
    const { pointer } = await mate.ask({ cmd: "proxyOf", hash: (await hashFile(original)).hash });
    assert.equal(pointer?.stream, stream, "the teammate finds the stream while it uploads");
    const playing = mate.ask({ cmd: "play", stream }, 180_000);
    const done = settled(playing);
    await mate.next((x) => x.played?.stream === stream && x.played.index === 0, 60_000);
    // the player has segment 0 and is waiting for segment 1, which is still on its way
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(!done(), "the player waits for the segment still uploading (it doesn't stop at what is up)");
    assert.ok(!mate.lines.some((x) => x.played?.stream === stream && x.played.index === 1), "segment 1 isn't played before it is up");
    assert.ok(!owner.lines.some((x) => x.entrySent), "the owner's upload was still going");
    // the entry goes up: the same playback carries on to the end, every part verified, the record sized
    await owner.ask({ cmd: "release" });
    const r = await sharing;
    const all = await playing;
    assert.equal(all.failed, undefined, all.failed);
    assert.ok(all.segments >= 2 && all.ended?.segments === all.segments, `played on to the stream's end: ${JSON.stringify({ segments: all.segments, ended: all.ended })}`);
    assert.equal(all.bytes, r.record.proxy?.size, "the whole stream, as the record sizes it");
    assert.deepEqual(all.events, [], "no leaf failed its check");
    assert.equal(r.record.proxy?.stream, stream);
  } finally {
    await owner.ask({ cmd: "release" }).catch(() => {});
  }
});

test("S5 while its proxy uploads, the uploader plays it at once; the teammate plays it as soon as the upload completes (ranges, tools), and a damaged store never hands a tool a bad byte", { timeout: 240_000, skip: NO_FF }, async (t) => {
  const w = await world(t, "host-http");
  const up = await heldProxyUpload(w);

  // --- the uploader plays its own proxy at once, from its disk, through the loopback range server
  const local = await up.owner.ask({ cmd: "serveLocal", path: clips.proxy, hash: up.hash });
  await run(FFMPEG, ["-v", "error", "-ss", "1", "-i", local.toolUrl, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"], { timeout: 60_000 });
  assert.ok(up.incomplete(), "the uploader played a frame while its upload was still running");
  // the teammate meanwhile, once every part is up: not visible yet (S5-1), or, once S5-1 is fixed, only verified bytes
  await up.owner.next((x) => x.completeHeld, 60_000);
  const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate"));
  const early = (await mate.ask({ cmd: "stat", hash: up.hash })).stat;
  if (early) {
    assert.deepEqual(early, { size: up.size, contentType: "video/mp4" });
    const first = await mate.ask({ cmd: "read", hash: up.hash, offset: 0, length: MiB, mode: "verified" });
    assert.equal(first.failed, undefined, first.failed);
    assert.equal(first.sha256, fileSha(clips.proxy, 0, MiB), "what the teammate gets before the upload completes is the owner's");
  }
  assert.ok(up.incomplete(), "the teammate looked while the upload was still running");
  t.diagnostic(`the teammate during the upload: ${early ? "streams it" : "waits for it (S5-1)"}`);

  // --- the upload completes: the teammate plays it at once, no waiting or polling
  await up.release();
  const done = (await up.upload).result;
  assert.equal(done.hash, up.hash);
  assert.deepEqual((await mate.ask({ cmd: "stat", hash: up.hash })).stat, { size: up.size, contentType: "video/mp4" });
  const srv = await mate.ask({ cmd: "serve", hash: up.hash });
  const probe = await run(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_name,height", "-of", "csv=p=0", srv.toolUrl], { timeout: 60_000 });
  assert.match(probe.stdout, /h264,360/, "a tool probes the teammate's copy through the loopback range server");
  await run(FFMPEG, ["-v", "error", "-ss", "1.5", "-i", srv.toolUrl, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"], { timeout: 60_000 });

  // ranges through the player's route (serveMedia, as cardboard-media://), byte for byte the owner's file
  const mid = await fetchAll(srv.playUrl, { headers: { range: "bytes=1048000-2100000" } });
  assert.equal(mid.status, 206);
  assert.equal(mid.headers.get("content-range"), `bytes 1048000-2100000/${up.size}`);
  assert.equal(createHash("sha256").update(mid.bytes).digest("hex"), fileSha(clips.proxy, 1048000, 2100001));
  const tail = await fetchAll(srv.playUrl, { headers: { range: "bytes=-1000" } });
  assert.equal(tail.status, 206);
  assert.equal(createHash("sha256").update(tail.bytes).digest("hex"), fileSha(clips.proxy, up.size - 1000));
  const head = await fetch(srv.playUrl, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), String(up.size));
  // the whole proxy, so every leaf is verified into the teammate's cache
  const whole = await mate.ask({ cmd: "read", hash: up.hash, mode: "play" }, 60_000);
  assert.equal(whole.mediaHash, up.hash);

  // --- the stored object gets damaged (disk rot, a bad copy): one byte inside leaf 5
  const file = w.side.objectFile(up.hash);
  assert.ok(file, "the host's blob file for the proxy");
  const bad = 5 * MiB + 4321;
  flipByte(file, bad);
  // a teammate with no cache: a tool reading through the range server never gets a byte that isn't the owner's
  const fresh = makeMachine("s5-mate2", w.owner);
  t.after(() => { if (!KEEP) rmSync(fresh.home, { recursive: true, force: true }); });
  const mate2 = await startMachine(w.procs, "mate2", fresh.home, w.side.storeFor("mate"));
  const s2 = await mate2.ask({ cmd: "serve", hash: up.hash });
  const tool = await fetchAll(s2.toolUrl);
  assert.equal(tool.complete, false, "the tool's response is broken off, not completed with bad bytes");
  assert.ok(tool.bytes.length <= 5 * MiB, `the tool got ${tool.bytes.length} bytes: nothing past the last good leaf`);
  assert.ok(tool.bytes.equals(readFileSync(clips.proxy).subarray(0, tool.bytes.length)), "every byte the tool got is the owner's");
  const v = await mate2.ask({ cmd: "read", hash: up.hash, offset: 5 * MiB, length: MiB, mode: "verified" });
  assert.match(String(v.failed), /LeafMismatchError/, "a verified read of the bad leaf fails after its repair attempts");
  assert.ok(v.events.some((e: any) => e.type === "repair-failed" && e.leaf === 5));
  // play first: the player may already hold some of the bad leaf, so it is told (served-bad) and its body errors
  const play = await fetchAll(s2.playUrl);
  assert.equal(play.complete, false, "the player's body errors at the bad leaf");
  assert.ok(play.bytes.subarray(0, 5 * MiB).equals(readFileSync(clips.proxy).subarray(0, Math.min(5 * MiB, play.bytes.length))), "the leaves before it are the owner's");
  await until(() => mate2.lines.some((x) => x.readerEvent?.type === "served-bad" && x.readerEvent.leaf === 5), 10_000, "served-bad for leaf 5");
  // the first teammate verified leaf 5 before the damage: it still plays from its cache
  const cached = await mate.ask({ cmd: "read", hash: up.hash, offset: 5 * MiB, length: MiB, mode: "play" });
  assert.equal(cached.failed, undefined, cached.failed);
  assert.equal(cached.sha256, fileSha(clips.proxy, 5 * MiB, 6 * MiB), "verified leaves in the cache are not poisoned by the store");
});

test("S5-5 a damaged object in the store gets repaired: once a teammate hits a leaf that can never verify, the owner's next share replaces it (§11: there is a repair path)", {
  timeout: 180_000,
}, async (t) => {
  const w = await world(t, "host-http");
  const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner"));
  const first = (await owner.ask({ cmd: "upload", path: clips.proxy, contentType: "video/mp4" }, 120_000)).result;
  flipByte(w.side.objectFile(first.hash)!, 3 * MiB + 99); // disk rot on the host, or a bad copy into the bucket
  const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate"));
  const bad = await mate.ask({ cmd: "read", hash: first.hash, mode: "tool" }, 60_000);
  assert.match(String(bad.failed), /LeafMismatchError/, "precondition: the teammate's reader catches the damage");
  const again = (await owner.ask({ cmd: "upload", path: clips.proxy, contentType: "video/mp4" }, 120_000)).result;
  const after = await mate.ask({ cmd: "read", hash: first.hash, mode: "tool" }, 60_000);
  t.diagnostic(JSON.stringify({ ownersSecondUpload: again, teammateAfter: after.failed ?? "verified" }));
  assert.equal(after.failed, undefined, "the teammate plays the clip once the owner has shared it again");
  assert.equal(after.mediaHash, first.hash);
});

function flipByte(path: string, offset: number): void {
  const fd = openSync(path, "r+");
  try {
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, offset);
    b[0]! ^= 0xff;
    writeSync(fd, b, 0, 1, offset);
  } finally {
    closeSync(fd);
  }
  assert.ok(statSync(path).size > offset);
}

// ------------------------------------------------------------------ 4. signed URLs behind a proxy

test("S5-2 a signed media URL works at the address the client reached the host on (a reverse proxy, a port map, or a host listening on 0.0.0.0)", {
  timeout: 60_000,
  todo: "S5-2, hosts-plugins (server-node): signed blob URLs are built from the host's listen address, not the address the client used",
}, async (t) => {
  const w = await world(t, "host-http");
  const front = (await w.link())!; // what clients reach: another address than the one the host listens on
  const res = await fetch(`${front.url}/api/projects/${w.owner.projectId}/blobs/sign`, {
    method: "POST",
    headers: { authorization: `Bearer ${w.side.host!.tokens[w.owner.projectId]!.owner}`, "content-type": "application/json" },
    body: JSON.stringify({ key: "m/0000", method: "GET", expiresIn: 60 }),
  });
  assert.equal(res.status, 200);
  const url = new URL(((await res.json()) as { url: string }).url);
  assert.equal(url.origin, front.url, `the signed URL names ${url.origin}, which the client never reached the host on`);
});

test("S5-3 the same footage shared in a second project of the same team uploads nothing (§11: dedup is whole-file, within a team)", {
  timeout: 120_000,
  todo: "S5-3, hosts-plugins with media (plan decision): the hosts scope media per project (projects/<p>/media/), so the same clip in two projects of one team is uploaded and stored twice",
}, async (t) => {
  const second = "s5-second-project";
  const w = await world(t, "host-http", [second]);
  const host = w.side.host!;
  const link = (await w.link())!;
  const one = await startMachine(w.procs, "owner-p1", w.owner.home, hostStore(host, w.owner.projectId, "owner", link));
  const first = (await one.ask({ cmd: "upload", path: clips.original, contentType: "video/mp4" }, 120_000)).result;
  assert.equal(first.deduped, false);
  const before = link.upBytes;
  const two = await startMachine(w.procs, "owner-p2", join(w.owner.home, "p2"), hostStore(host, second, "owner", link));
  const again = (await two.ask({ cmd: "upload", path: clips.original, contentType: "video/mp4" }, 120_000)).result;
  t.diagnostic(JSON.stringify({ size: first.size, secondProjectBytesUp: link.upBytes - before, deduped: again.deduped }));
  assert.equal(again.deduped, true, "the team's store already holds this clip");
  assert.ok(link.upBytes - before < CHATTER, `the second project sent ${link.upBytes - before} bytes up`);
});
