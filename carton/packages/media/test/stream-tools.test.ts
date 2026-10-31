// Segmented proxies with real fMP4 segments: ffmpeg's own HLS muxer makes them here, so this tests the upload, the
// reader and the tools' route (the loopback server's live playlist) independently of the segment encoder.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { MemoryLeafCache } from "../src/cache.ts";
import { nodeHasher } from "../src/node/node-hasher.ts";
import { startRangeServer } from "../src/node/range-server.ts";
import { MediaReader } from "../src/read.ts";
import { ProxyStreamReader, ProxyStreamWriter, streamRangeSource } from "../src/stream.ts";
import { CountingMemoryStore } from "../src/testing.ts";
import { FFMPEG, FFPROBE, haveFfmpeg, scratchDir } from "./helpers.ts";

const run = promisify(execFile);
const s = scratchDir("stream-tools");
let segs: { path: string; durationSec: number }[] = [];
let initPath = "";
before(() => {
  if (!haveFfmpeg()) return;
  // ffmpeg runs IN the scratch folder with relative output names, as segment-encoder.ts does: ffmpeg 8's hlsenc.c finds
  // the init segment's folder with strrchr(playlist, '/') only, so with a Windows path (backslashes) it wrote init.mp4
  // into its own current folder instead (CI #20).
  execFileSync(FFMPEG, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=6", "-f", "lavfi", "-i", "sine=duration=6",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-force_key_frames", "expr:gte(t,n_forced*2)",
    "-c:a", "aac", "-shortest",
    "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", "seg_%03d.m4s", "index.m3u8",
  ], { cwd: s.dir, windowsHide: true });
  initPath = join(s.dir, "init.mp4");
  const lines = readFileSync(join(s.dir, "index.m3u8"), "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXTINF:([\d.]+),/.exec(lines[i]);
    if (m) segs.push({ durationSec: Number(m[1]), path: join(s.dir, lines[i + 1].trim()) });
  }
});
after(() => s.cleanup());

test("a tool reads a segmented proxy through the loopback server while it is still uploading, and as one file once done", { skip: !haveFfmpeg() && "no ffmpeg" }, async () => {
  assert.ok(segs.length >= 3, `ffmpeg made ${segs.length} segments of ${readdirSync(s.dir).join(", ")}`);
  const store = new CountingMemoryStore();
  const writer = new ProxyStreamWriter({ store, hasher: nodeHasher });
  const media = new MediaReader({ store, hasher: nodeHasher, cache: new MemoryLeafCache() });
  const streams = (id: string) => (id === writer.id ? new ProxyStreamReader({ store, media, id, pollMs: 20 }) : null);
  const server = await startRangeServer({
    source: streamRangeSource({ streams, media: media.toolSource() }),
    playlist: async (id, urlFor) => streams(id)?.playlist(urlFor) ?? null,
  });
  try {
    await writer.init(new Uint8Array(readFileSync(initPath)));
    await writer.segment(new Uint8Array(readFileSync(segs[0].path)), segs[0].durationSec);
    // Live: one segment up, no end. A tool grabs the first frame already.
    await run(FFMPEG, ["-v", "error", "-i", server.playlistUrl(writer.id), "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"], { timeout: 30_000 });
    for (const sg of segs.slice(1)) await writer.segment(new Uint8Array(readFileSync(sg.path)), sg.durationSec);
    await writer.end();
    // Finished: the playlist ends, and the stream is also one fragmented MP4 by range.
    const viaPlaylist = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", server.playlistUrl(writer.id)], { timeout: 30_000 });
    const viaFile = await run(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_name", "-show_entries", "format=duration", "-of", "csv=p=0", server.url(writer.id)], { timeout: 30_000 });
    const total = segs.reduce((a, b) => a + b.durationSec, 0);
    assert.ok(Math.abs(Number(viaPlaylist.stdout.trim()) - total) < 0.5, `playlist duration ${viaPlaylist.stdout.trim()} vs ${total}`);
    assert.match(viaFile.stdout, /h264/);
    assert.match(viaFile.stdout, /aac/);
  } finally {
    await server.close();
  }
});
