// Reusing Cardboard's own proxy: real generated files, probed with the real ffprobe.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { MediaInput, ProxyEncoder } from "@carton/core/plugins";
import { COLLAB_PROXY_720P, encodeProxy, ProxyDeclinedError } from "../src/proxy.ts";
import { ffmpegEncoder } from "../src/node/ffmpeg-encoder.ts";
import { hostProxyEncoder, type HostProxyDecision } from "../src/node/host-proxy.ts";
import { FFMPEG, FFPROBE, haveFfmpeg, makeClip, scratchDir } from "./helpers.ts";

const skip = haveFfmpeg() ? false : "ffmpeg is not installed";
const { dir, cleanup } = scratchDir("host-proxy");
after(cleanup);

const PROXIES = join(dir, "My Project.cardboard", "proxies");
const OUT = join(dir, "carton cache");
const files = { low: "", high: "", moovAtEnd: "", hevc: "" };

before(() => {
  if (skip) return;
  mkdirSync(PROXIES, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  files.low = makeClip(join(PROXIES, "low 1 Mbps.mp4"), { size: "640x360", seconds: 2, kbps: 1000, faststart: true });
  files.high = makeClip(join(PROXIES, "high 12 Mbps.mp4"), { size: "1280x720", seconds: 2, kbps: 12000, faststart: true });
  files.moovAtEnd = makeClip(join(PROXIES, "moov at end.mp4"), { size: "640x360", seconds: 2, kbps: 1000 });
  files.hevc = join(PROXIES, "hevc.mp4");
  execFileSync(FFMPEG, [
    "-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2",
    "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-b:v", "500k", "-tag:v", "hvc1", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", files.hevc,
  ]);
});

/** A host whose "media" are the proxy paths themselves: locate maps the input straight to a proxy file. */
function host(decisions: HostProxyDecision[] = [], ffprobe: string = FFPROBE) {
  return hostProxyEncoder({ locate: (input: MediaInput) => ("path" in input ? input.path : null), ffprobe, onDecide: (d) => decisions.push(d) });
}

test("a low-rate faststart H.264 proxy is reused: reusable() gives its path, encode() hard-links it", { skip }, async () => {
  const decisions: HostProxyDecision[] = [];
  const h = host(decisions);
  assert.equal(h.name, "cardboard-proxy");
  assert.equal(h.hardware, false);
  assert.equal(await h.probe(), true);
  assert.equal(await h.reusable({ path: files.low }), files.low);
  assert.equal(decisions[0].ok, true);
  assert.match(decisions[0].reason, /^H\.264, \d+ kbit\/s, long edge 640, faststart$/);
  assert.ok(decisions[0].facts?.bitrateKbps && decisions[0].facts.bitrateKbps < 4000, `measured ${decisions[0].facts?.bitrateKbps}`);

  const out = join(OUT, "linked.mp4");
  const seen: number[] = [];
  const r = await h.encode({ path: files.low }, { path: out }, COLLAB_PROXY_720P, { onProgress: (f) => seen.push(f) });
  const a = statSync(files.low);
  const b = statSync(out);
  assert.equal(r.bytes, a.size);
  assert.equal(b.ino, a.ino, "the same file: a hard link, not a copy");
  assert.equal(a.nlink, 2);
  assert.deepEqual(seen, [1]);
  assert.equal(existsSync(`${out}.partial.mp4`), false);

  // Encoding again over an existing output (already a link to the same file) leaves no partial behind.
  await h.encode({ path: files.low }, { path: out }, COLLAB_PROXY_720P);
  assert.equal(statSync(out).ino, a.ino);
  assert.equal(existsSync(`${out}.partial.mp4`), false);
  assert.equal(statSync(files.low).nlink, 2);
});

test("a reused proxy can be streamed into a sink byte for byte", { skip }, async () => {
  const chunks: Uint8Array[] = [];
  const sink = new WritableStream<Uint8Array>({ write: (c) => void chunks.push(c) });
  const r = await host().encode({ path: files.low }, { sink }, COLLAB_PROXY_720P);
  const want = readFileSync(files.low);
  assert.equal(r.bytes, want.length);
  assert.ok(Buffer.concat(chunks).equals(want));
});

test("12 Mb/s, moov-at-end, HEVC and missing proxies are declined, each with its reason", { skip }, async () => {
  const cases: [string, string | null, RegExp][] = [
    ["Cardboard's 12 Mb/s local proxy", files.high, /\d+ kbit\/s is above 4000/],
    ["moov at the end", files.moovAtEnd, /not faststart/],
    ["HEVC", files.hevc, /hevc, not H\.264/],
    ["file not there (yet)", join(PROXIES, "not encoded yet.mp4"), /doesn't exist/],
    ["no proxy at all", null, /has no proxy/],
  ];
  for (const [name, path, reason] of cases) {
    const decisions: HostProxyDecision[] = [];
    const h = hostProxyEncoder({ locate: () => path, ffprobe: FFPROBE, onDecide: (d) => decisions.push(d) });
    assert.equal(await h.reusable({ path: "/any/original.mov" }), null, name);
    assert.match(decisions[0].reason, reason, name);
    const out = join(OUT, "declined.mp4");
    await assert.rejects(h.encode({ path: "/any/original.mov" }, { path: out }, COLLAB_PROXY_720P), (e: unknown) => e instanceof ProxyDeclinedError && reason.test(e.message), name);
    assert.equal(existsSync(out), false, name);
  }
});

test("moov at the end is decided from the file's boxes without running ffprobe; an unreadable proxy is declined, not thrown", { skip }, async () => {
  const noProbe = join(dir, "no such ffprobe");
  const decisions: HostProxyDecision[] = [];
  assert.equal(await host(decisions, noProbe).reusable({ path: files.moovAtEnd }), null);
  assert.match(decisions[0].reason, /not faststart/, "ffprobe wasn't needed");
  assert.equal(await host(decisions, noProbe).reusable({ path: files.low }), null);
  assert.match(decisions[1].reason, /couldn't check Cardboard's proxy: ffprobe failed/);
  await assert.rejects(host([], FFPROBE).reusable({ path: files.low }, { signal: AbortSignal.abort() }), { name: "AbortError" });
});

test("in the chain: a reusable proxy means nothing is encoded; a declined one falls through to libx264", { skip }, async () => {
  const probed: string[] = [];
  const x264 = ffmpegEncoder("libx264", { ffmpeg: FFMPEG });
  const watched: ProxyEncoder = { ...x264, probe: () => (probed.push("libx264"), x264.probe()) };

  const reused = await encodeProxy([host(), watched], { path: files.low }, { path: join(OUT, "chain reused.mp4") }, COLLAB_PROXY_720P);
  assert.equal(reused.encoder, "cardboard-proxy");
  assert.deepEqual(reused.attempts, [{ encoder: "cardboard-proxy", outcome: "ok" }]);
  assert.deepEqual(probed, [], "libx264 never even probed");

  const out = join(OUT, "chain encoded.mp4");
  const encoded = await encodeProxy([host(), watched], { path: files.high }, { path: out }, COLLAB_PROXY_720P);
  assert.equal(encoded.encoder, "libx264");
  assert.equal(encoded.attempts[0].outcome, "declined");
  assert.match(encoded.attempts[0].error ?? "", /above 4000/);
  assert.equal(encoded.bytes, statSync(out).size);
  assert.notEqual(statSync(out).ino, statSync(files.high).ino);
});
