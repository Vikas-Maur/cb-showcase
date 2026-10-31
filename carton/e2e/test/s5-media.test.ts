// Scenario 5: media between two machines (PLAN §11, §22 phase 4). The owner and a teammate each run in their own
// process with their own disk cache and upload record; the store is real: a shared folder (blob-fs), a local S3
// gateway (blob-s3 on VersityGW), or a server-node host through its HTTP media API (resumable uploads, signed URLs).
// Links between a machine and its store are TCP proxies, so a cut link is a connection reset mid-request.
//   - share the sample project's clip (the camera original, opted in, and Cardboard's own proxy reused as the collab
//     proxy); the teammate's process reads both back and every byte verifies against the manifest; sharing it again,
//     or from the teammate's machine with the same footage, sends nothing; offline, the teammate replays from cache;
//   - resume after the uploader's process is killed mid-upload, after its link is cut mid-part, and after the host
//     restarts: only the parts that never landed go up again, well under twice the file, and the object verifies; a
//     host that lost the open upload makes the uploader start over instead of failing; two processes of one machine
//     resuming the same saved upload both succeed; a teammate's download reset mid-stream carries on from the break;
//   - a teammate streaming the proxy before its upload finishes (the plan's behaviour: a known gap, kept as todo), and
//     what is promised today: the uploader plays its own proxy at once, the teammate as soon as the upload completes
//     (ranges, tools through the loopback range server), and bad bytes in the store are never handed to a tool;
//   - bugs and gaps found here, each a minimal `todo` test named after its id (S5-2 … S5-5): signed media URLs from a
//     host reached through a proxy or a port map; an upload the store dropped mid-way; a damaged object repaired by
//     sharing again; the same footage in two projects of one team.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { closeHashWorkers, hashFile } from "@carton/media/node";
import { makeMachine, type Machine } from "../support/project.ts";
import { Procs, type Proc } from "../support/procs.ts";
import { scratch, until } from "../support/env.ts";
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
  test(`S5 share a clip through ${kind}: the teammate's process reads every byte back verified; sharing it again, or from the teammate's machine with the same footage, uploads nothing; offline, the teammate replays from its cache`, { timeout: 240_000, skip: NO_FF || skipFor(kind) }, async (t) => {
    const w = await world(t, kind);
    const original = placeOriginal(w.owner, clips.original);
    const hostProxy = placeHostProxy(w.owner, clips.hostProxy);
    const { record } = sampleVideo(w.owner);
    const want = { original: await hashFile(original), proxy: await hashFile(hostProxy) };
    const ownerLink = await w.link();
    const mateLink = await w.link();

    // --- the owner shares the clip: the original (opted in) and Cardboard's own proxy as the collab proxy
    const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner", ownerLink));
    const r = await owner.ask({ cmd: "share", record, original, hostProxy, originals: true }, 120_000);
    assert.equal(r.record.hash, want.original.hash, "the clip is named by its content");
    assert.equal(r.record.size, want.original.size);
    assert.equal(r.record.original, "shared");
    assert.deepEqual([r.record.proxy?.hash, r.record.proxy?.size, r.record.proxy?.encoder], [want.proxy.hash, want.proxy.size, "cardboard-proxy"], "Cardboard's proxy is the collab proxy, as it is");
    assert.ok(r.events.some((e: any) => e.type === "proxy" && e.how === "host's"));
    const up = uploaded(r.events, "original");
    assert.equal(up.deduped, false);
    assert.ok(up.partsSent >= 2, `the original went up in parts (${up.partsSent} × ${up.partSize})`);
    assert.equal(up.partsSent, Math.ceil(want.original.size / up.partSize));
    if (ownerLink) assert.ok(ownerLink.upBytes >= want.original.size + want.proxy.size, "the bytes went over the owner's link");

    // --- the teammate's process reads both back: every byte verifies against the manifest
    const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate", mateLink));
    assert.deepEqual((await mate.ask({ cmd: "stat", hash: want.proxy.hash })).stat, { size: want.proxy.size, contentType: "video/mp4" });
    const px = await mate.ask({ cmd: "read", hash: want.proxy.hash, mode: "play" }, 60_000);
    assert.equal(px.failed, undefined, px.failed);
    assert.equal(px.bytes, want.proxy.size);
    assert.equal(px.mediaHash, want.proxy.hash, "the proxy's bytes hash to its id");
    assert.equal(px.sha256, fileSha(hostProxy), "byte for byte the owner's file");
    assert.deepEqual(px.events, [], "no leaf failed its check");
    const og = await mate.ask({ cmd: "read", hash: want.original.hash, mode: "tool" }, 60_000);
    assert.equal(og.failed, undefined, og.failed);
    assert.equal(og.mediaHash, want.original.hash, "the original's bytes hash to its id");
    assert.equal(og.sha256, fileSha(original));

    // --- sharing the same clip again (the record lost its ids, as after a re-import): nothing goes up
    const before = ownerLink?.upBytes ?? 0;
    const again = await owner.ask({ cmd: "share", record, original, hostProxy, originals: true }, 60_000);
    assert.equal(again.record.hash, want.original.hash);
    assert.equal(again.record.proxy?.hash, want.proxy.hash);
    assert.deepEqual([uploaded(again.events, "original")?.deduped, uploaded(again.events, "original")?.bytesSent], [true, 0], "the original is already there");
    assert.ok(again.events.some((e: any) => e.type === "proxy" && e.how === "teammate's"), "the proxy is found through its pointer");
    assert.equal(uploaded(again.events, "proxy"), undefined, "the proxy is not uploaded again");
    if (ownerLink) assert.ok(ownerLink.upBytes - before < CHATTER, `sharing again sent ${ownerLink.upBytes - before} bytes up`);

    // --- the teammate has the same footage (the camera card's copy): their share uploads nothing either
    const theirs = placeOriginal(w.mate, clips.original);
    const mateBefore = mateLink?.upBytes ?? 0;
    const s = await mate.ask({ cmd: "share", record: sampleVideo(w.mate).record, original: theirs, hostProxy: null, originals: true }, 60_000);
    assert.equal(s.record.hash, want.original.hash, "the same footage has the same id on another machine");
    assert.equal(s.record.proxy?.hash, want.proxy.hash, "the teammate gets the owner's proxy, with no encode");
    assert.equal(uploaded(s.events, "original")?.deduped, true);
    if (mateLink) assert.ok(mateLink.upBytes - mateBefore < CHATTER, `the teammate's share sent ${mateLink.upBytes - mateBefore} bytes up`);

    // --- offline: a restarted teammate process plays the proxy from its disk cache
    if (mateLink) {
      await mate.kill();
      mateLink.drop();
      const off = await startMachine(w.procs, "mate-offline", w.mate.home, w.side.storeFor("mate", mateLink));
      assert.deepEqual((await off.ask({ cmd: "stat", hash: want.proxy.hash })).stat, { size: want.proxy.size, contentType: "video/mp4" }, "stat works offline");
      const o2 = await off.ask({ cmd: "read", hash: want.proxy.hash, mode: "play" }, 60_000);
      assert.equal(o2.failed, undefined, o2.failed);
      assert.equal(o2.sha256, fileSha(hostProxy), "served from the teammate's disk cache with the store unreachable");
    }
  });
}

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
test("S5-4 an upload the store dropped mid-way (expired, or completed by another process) costs at most the parts that were in flight (host-http)", {
  timeout: 180_000,
  todo: "S5-4, media: uploadMedia retries uploadPart on NoSuchUpload, re-sending every in-flight part up to 5 times to an upload that can never take it",
}, async (t) => {
  const w = await world(t, "host-http");
  const want = await hashFile(clips.big);
  const link = (await w.link(8 * MiB))!;
  const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner", link));
  const up = owner.ask({ cmd: "upload", path: clips.big, contentType: "video/mp4", retryDelayMs: 50 }, 120_000).then((r) => r.result, (e: Error) => e);
  await until(() => partsRecorded(w.owner, want.hash) >= 1, 60_000, "a first part recorded by the uploader", POLL);
  const st = JSON.parse(readFileSync(statePath(w.owner, want.hash), "utf8")) as { uploadId: string; partSize: number };
  rmSync(join(w.side.host!.blobRoot, "uploads", st.uploadId), { recursive: true, force: true }); // the host drops it
  const atDrop = link.upBytes;
  const outcome = await up;
  const after = link.upBytes - atDrop;
  t.diagnostic(JSON.stringify({ size: want.size, partSize: st.partSize, bytesUpAfterTheDrop: after, outcome: outcome instanceof Error ? outcome.message : outcome }));
  assert.equal(partsRecorded(w.owner, want.hash), 0, "the dead upload is forgotten, so the next attempt starts a new one");
  assert.ok(after <= 2 * st.partSize + CHATTER, `${after} bytes went up after the host dropped the upload; at most the 2 parts in flight should`);
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

/** The owner uploads the collab proxy over a slow link; resolves once its first part has landed. */
async function proxyMidUpload(w: World): Promise<{ owner: Proc; hash: string; size: number; upload: Promise<any>; uploading: () => boolean }> {
  const link = (await w.link(3 * MiB))!;
  const owner = await startMachine(w.procs, "owner", w.owner.home, w.side.storeFor("owner", link));
  const upload = owner.ask({ cmd: "upload", path: clips.proxy, contentType: "video/mp4" }, 120_000);
  const done = settled(upload);
  const { hashed: hash, size } = await owner.next((x) => x.hashed);
  await owner.next((x) => x.progress && x.progress.done > 0 && x.progress.done < x.progress.total, 60_000);
  return { owner, hash, size, upload, uploading: () => !done() };
}

test("S5 a teammate streams the proxy before its upload finishes (PLAN §22 phase 4)", {
  timeout: 180_000,
  todo: "S5-1, media (decision pending with the orchestrator): a multipart object is invisible until it completes (one object per variant, §11), so a teammate can't play a proxy until its upload finishes",
}, async (t) => {
  const w = await world(t, "host-http");
  const up = await proxyMidUpload(w);
  try {
    const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate"));
    assert.ok(up.uploading(), "the upload is still running");
    assert.ok((await mate.ask({ cmd: "stat", hash: up.hash })).stat, "the teammate sees the proxy while it uploads");
    const first = await mate.ask({ cmd: "read", hash: up.hash, offset: 0, length: MiB, mode: "play" });
    assert.equal(first.failed, undefined, first.failed);
    assert.equal(first.sha256, fileSha(clips.proxy, 0, MiB), "the first leaf plays, verified, before the upload ends");
  } finally {
    await up.upload.catch(() => {});
  }
});

test("S5 while its proxy uploads, the uploader plays it at once; the teammate plays it as soon as the upload completes (ranges, tools), and a damaged store never hands a tool a bad byte", { timeout: 240_000, skip: NO_FF }, async (t) => {
  const w = await world(t, "host-http");
  const up = await proxyMidUpload(w);

  // --- the uploader plays its own proxy at once, from its disk, through the loopback range server
  const local = await up.owner.ask({ cmd: "serveLocal", path: clips.proxy, hash: up.hash });
  await run(FFMPEG, ["-v", "error", "-ss", "1", "-i", local.toolUrl, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"], { timeout: 60_000 });
  assert.ok(up.uploading(), "the uploader played a frame while its upload was still running");
  const mate = await startMachine(w.procs, "mate", w.mate.home, w.side.storeFor("mate"));
  assert.equal((await mate.ask({ cmd: "stat", hash: up.hash })).stat, null, "today the teammate waits for the upload (S5-1)");

  // --- the upload completes: the teammate plays it at once, no waiting or polling
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
  todo: "S5-5, media with hosts-plugins: nothing reports a bad range or marks the object missing, and uploadMedia dedups by size alone, so a damaged object of the right size is never re-uploaded",
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
