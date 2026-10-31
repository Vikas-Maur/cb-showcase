import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaInput, MediaOutput, ProxyEncoder, ProxyProfile } from "@carton/core/plugins";
import {
  COLLAB_PROXY_720P,
  collabProfile,
  encodeProxy,
  moovBeforeMdat,
  pickEncoder,
  ProxyChainError,
  ProxyDeclinedError,
  reusableProxy,
  type ProxyFacts,
} from "../src/proxy.ts";

type Behaviour = "ok" | "decline" | "fail" | "abort-wait" | "fail-after-abort";

/** An in-memory encoder that logs every call, so the tests can check what the chain touched and in what order. */
function fake(name: string, probe: boolean | "throws", behaviour: Behaviour, log: string[], progress: number[] = []): ProxyEncoder {
  return {
    name,
    hardware: name !== "libx264",
    async probe() {
      log.push(`${name}.probe`);
      if (probe === "throws") throw new Error("driver exploded");
      return probe;
    },
    async encode(_input: MediaInput, _output: MediaOutput, _profile: ProxyProfile, opts = {}) {
      log.push(`${name}.encode`);
      for (const f of progress) opts.onProgress?.(f);
      switch (behaviour) {
        case "ok":
          return { bytes: 1234, durationMs: 5 };
        case "decline":
          throw new ProxyDeclinedError("no reusable proxy");
        case "fail":
          throw new Error(`${name} ran out of sessions`);
        case "abort-wait":
          // Waits for the abort, then rejects as a cancelled job does.
          return new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true }));
        case "fail-after-abort":
          // A killed ffmpeg: the error is an exit code, not an AbortError.
          return new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(new Error("ffmpeg was killed (SIGKILL)")), { once: true }));
      }
    },
  };
}

const IN: MediaInput = { path: "/media/clip.mov" };
const OUT: MediaOutput = { path: "/cache/clip.mp4" };

test("the collab profile is 720p H.264 at about 2 Mb/s, and a plain profile gets the defaults", () => {
  assert.deepEqual(COLLAB_PROXY_720P, {
    id: "collab-720p-h264-v1", height: 720, bitrate: 2_000_000, maxBitrate: 2_500_000, codec: "h264", audio: "aac", audioBitrate: 128_000, keyframeSeconds: 2,
  });
  assert.equal(collabProfile(COLLAB_PROXY_720P).maxBitrate, 2_500_000, "a full profile is kept as it is");
  const plain = collabProfile({ height: 480, bitrate: 1_000_000, codec: "h264", audio: "aac" });
  assert.equal(plain.maxBitrate, 1_250_000);
  assert.equal(plain.audioBitrate, 128_000);
  assert.equal(plain.keyframeSeconds, 2);
  assert.equal(plain.id, "h264-480p-1000k-v1");
});

test("the first encoder that works wins, and the ones after it are never probed", async () => {
  const log: string[] = [];
  const out = await encodeProxy([fake("a", true, "ok", log), fake("b", true, "ok", log)], IN, OUT, COLLAB_PROXY_720P);
  assert.equal(out.encoder, "a");
  assert.equal(out.hardware, true);
  assert.equal(out.bytes, 1234);
  assert.deepEqual(out.attempts, [{ encoder: "a", outcome: "ok" }]);
  assert.deepEqual(log, ["a.probe", "a.encode"]);
});

test("unavailable, declined and failed encoders are passed over in order, each recorded", async () => {
  const log: string[] = [];
  const seen: string[] = [];
  const chain = [
    fake("cardboard-proxy", true, "decline", log),
    fake("h264_nvenc", true, "fail", log),
    fake("h264_qsv", false, "ok", log),
    fake("h264_amf", "throws", "ok", log),
    fake("libx264", true, "ok", log),
  ];
  const out = await encodeProxy(chain, IN, OUT, COLLAB_PROXY_720P, { onAttempt: (a) => seen.push(`${a.encoder}:${a.outcome}`) });
  assert.equal(out.encoder, "libx264");
  assert.equal(out.hardware, false);
  assert.deepEqual(out.attempts, [
    { encoder: "cardboard-proxy", outcome: "declined", error: "no reusable proxy" },
    { encoder: "h264_nvenc", outcome: "failed", error: "h264_nvenc ran out of sessions" },
    { encoder: "h264_qsv", outcome: "unavailable" },
    { encoder: "h264_amf", outcome: "unavailable" },
    { encoder: "libx264", outcome: "ok" },
  ]);
  assert.deepEqual(seen, ["cardboard-proxy:declined", "h264_nvenc:failed", "h264_qsv:unavailable", "h264_amf:unavailable", "libx264:ok"]);
  assert.deepEqual(log, ["cardboard-proxy.probe", "cardboard-proxy.encode", "h264_nvenc.probe", "h264_nvenc.encode", "h264_qsv.probe", "h264_amf.probe", "libx264.probe", "libx264.encode"]);
});

test("when nothing works the error lists every attempt", async () => {
  const log: string[] = [];
  const chain = [fake("cardboard-proxy", true, "decline", log), fake("h264_nvenc", false, "ok", log), fake("libx264", true, "fail", log)];
  const err = await encodeProxy(chain, IN, OUT, COLLAB_PROXY_720P).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof ProxyChainError);
  assert.match(err.message, /cardboard-proxy declined: no reusable proxy/);
  assert.match(err.message, /h264_nvenc unavailable/);
  assert.match(err.message, /libx264 failed: libx264 ran out of sessions/);
  assert.equal(err.attempts.length, 3);
  await assert.rejects(encodeProxy([], IN, OUT, COLLAB_PROXY_720P), /no encoders/);
});

test("an abort stops the chain: no fallback, whatever error the killed encoder reports", async () => {
  for (const behaviour of ["abort-wait", "fail-after-abort"] as const) {
    const log: string[] = [];
    const ac = new AbortController();
    const run = encodeProxy([fake("h264_nvenc", true, behaviour, log), fake("libx264", true, "ok", log)], IN, OUT, COLLAB_PROXY_720P, { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(run, { name: "AbortError" });
    assert.deepEqual(log, ["h264_nvenc.probe", "h264_nvenc.encode"], behaviour);
  }
  const log: string[] = [];
  await assert.rejects(encodeProxy([fake("libx264", true, "ok", log)], IN, OUT, COLLAB_PROXY_720P, { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.deepEqual(log, [], "an already aborted job starts nothing");
});

test("progress over the chain stays in [0, 1] and never goes back after a fallback", async () => {
  const seen: number[] = [];
  const chain = [fake("h264_nvenc", true, "fail", [], [0.1, 0.4]), fake("libx264", true, "ok", [], [0, 0.2, 0.5, 1.3, 1])];
  await encodeProxy(chain, IN, OUT, COLLAB_PROXY_720P, { onProgress: (f) => seen.push(f) });
  assert.deepEqual(seen, [0.1, 0.4, 0.5, 1]);
});

test("pickEncoder returns the first encoder whose probe passes, or null", async () => {
  const log: string[] = [];
  const chain = [fake("h264_nvenc", false, "ok", log), fake("h264_qsv", "throws", "ok", log), fake("libx264", true, "ok", log), fake("late", true, "ok", log)];
  assert.equal((await pickEncoder(chain))?.name, "libx264");
  assert.deepEqual(log, ["h264_nvenc.probe", "h264_qsv.probe", "libx264.probe"]);
  assert.equal(await pickEncoder([fake("h264_nvenc", false, "ok", [])]), null);
  assert.equal(await pickEncoder([]), null);
});

test("the reuse rule: only small, faststart, browser-playable H.264 is shared as it is", () => {
  const good: ProxyFacts = { codec: "h264", bitrateKbps: 2900, longEdge: 1920, moovBeforeMdat: true, hasVideo: true, pixFmt: "yuv420p" };
  const table: [string, Partial<ProxyFacts>, boolean, RegExp][] = [
    ["Cardboard's NVENC proxy under the cap", {}, true, /H\.264, 2900 kbit\/s, long edge 1920, faststart/],
    ["exactly 4 Mb/s", { bitrateKbps: 4000 }, true, /4000/],
    ["just over 4 Mb/s", { bitrateKbps: 4001 }, false, /above 4000/],
    ["Cardboard's 12 Mb/s proxy", { bitrateKbps: 12000 }, false, /12000 kbit\/s is above 4000/],
    ["HEVC", { codec: "hevc" }, false, /hevc, not H\.264/],
    ["codec unknown", { codec: null }, false, /unknown, not H\.264/],
    ["moov at the end", { moovBeforeMdat: false }, false, /faststart/],
    ["moov unknown", { moovBeforeMdat: null }, false, /faststart/],
    ["4K", { longEdge: 3840 }, false, /long edge 3840 is above 1920/],
    ["size unknown", { longEdge: null }, false, /size unknown/],
    ["bitrate unknown", { bitrateKbps: null }, false, /bitrate unknown/],
    ["bitrate NaN", { bitrateKbps: Number.NaN }, false, /bitrate unknown/],
    ["no video", { hasVideo: false }, false, /no video/],
    ["10-bit", { pixFmt: "yuv420p10le" }, false, /yuv420p10le/],
    ["full-range 4:2:0", { pixFmt: "yuvj420p" }, true, /faststart/],
    ["pixel format not probed", { pixFmt: undefined }, true, /faststart/],
  ];
  for (const [name, change, ok, reason] of table) {
    const d = reusableProxy({ ...good, ...change });
    assert.equal(d.ok, ok, name);
    assert.match(d.reason, reason, name);
  }
});

/** Top-level MP4 boxes from [type, payload length] pairs; `large` writes a 64-bit size, `toEnd` a size of 0. */
function boxes(spec: { type: string; payload: number; large?: boolean; toEnd?: boolean }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const b of spec) {
    const header = b.large ? 16 : 8;
    const box = new Uint8Array(header + b.payload);
    const v = new DataView(box.buffer);
    if (b.large) {
      v.setUint32(0, 1);
      v.setUint32(8, Math.floor(box.length / 0x1_0000_0000));
      v.setUint32(12, box.length >>> 0);
    } else {
      v.setUint32(0, b.toEnd ? 0 : box.length);
    }
    for (let i = 0; i < 4; i++) box[4 + i] = b.type.charCodeAt(i);
    parts.push(box);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function source(bytes: Uint8Array) {
  let reads = 0;
  return {
    size: bytes.length,
    read: async (offset: number, length: number) => {
      reads++;
      return bytes.subarray(offset, Math.min(bytes.length, offset + length));
    },
    get reads() {
      return reads;
    },
  };
}

test("moov before mdat is read from the top-level boxes, including 64-bit and to-the-end sizes", async () => {
  const cases: [string, Uint8Array, boolean][] = [
    ["faststart", boxes([{ type: "ftyp", payload: 24 }, { type: "moov", payload: 500 }, { type: "mdat", payload: 4000 }]), true],
    ["moov at the end", boxes([{ type: "ftyp", payload: 24 }, { type: "mdat", payload: 4000 }, { type: "moov", payload: 500 }]), false],
    ["QuickTime wide + free before moov", boxes([{ type: "ftyp", payload: 20 }, { type: "wide", payload: 0 }, { type: "free", payload: 100 }, { type: "moov", payload: 50 }, { type: "mdat", payload: 10 }]), true],
    ["a 64-bit box before moov is skipped by its 64-bit size", boxes([{ type: "ftyp", payload: 24 }, { type: "free", payload: 70_000, large: true }, { type: "moov", payload: 50 }, { type: "mdat", payload: 10 }]), true],
    ["a 64-bit mdat first", boxes([{ type: "ftyp", payload: 24 }, { type: "mdat", payload: 300, large: true }, { type: "moov", payload: 50 }]), false],
    ["still being written: mdat runs to the end, no moov", boxes([{ type: "ftyp", payload: 24 }, { type: "mdat", payload: 3000, toEnd: true }]), false],
    ["a size-0 box before any moov", boxes([{ type: "ftyp", payload: 24 }, { type: "free", payload: 40, toEnd: true }]), false],
    ["no moov at all", boxes([{ type: "ftyp", payload: 24 }, { type: "free", payload: 40 }]), false],
    ["a box smaller than its header", (() => { const b = boxes([{ type: "ftyp", payload: 24 }]); new DataView(b.buffer).setUint32(0, 4); return b; })(), false],
    ["empty file", new Uint8Array(0), false],
    ["truncated header", new Uint8Array([0, 0, 0, 20, 0x66]), false],
  ];
  for (const [name, bytes, want] of cases) {
    assert.equal(await moovBeforeMdat(source(bytes)), want, name);
  }
  // A large mdat is skipped by its size, not read.
  const big = source(boxes([{ type: "ftyp", payload: 24 }, { type: "free", payload: 5_000_000 }, { type: "moov", payload: 8 }]));
  assert.equal(await moovBeforeMdat(big), true);
  assert.equal(big.reads, 3);
});
