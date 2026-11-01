// Realistic rows for the store benchmarks: a confirmed change shaped like core's ConfirmedChange (a two-field time
// edit by a Director subagent, ~0.7 KB of JSON, close to P5's measured 0.66 KB per change), and a keyframe doc of
// Cardboard-like items.

export function change(seq: number, cut = "c0ffee00c0ffee00") {
  const item = `item-${(seq * 7919) % 1000}`;
  const t = (seq % 600) / 2;
  return {
    id: `a1b2c3d4e5f6a7b8c9d0e1f2.${seq}`,
    hash: (seq.toString(16).padStart(8, "0") + "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08").slice(0, 64),
    author: { kind: "agent", id: "director/chat-12/turn-3", name: "Director", group: "local:ana", agentId: "sub-ab12cd", agentType: "editor" },
    branchId: cut,
    base: { seq: seq - 1, pending: [] },
    ops: [
      { op: "set", path: ["items", item, "startTime"], value: t },
      { op: "set", path: ["items", item, "endTime"], value: t + 2.5 },
    ],
    intent: null,
    kinds: { [item]: "move" },
    policy: "cas",
    at: 1793000000000 + seq * 1000,
    paths: [`items/${item}/#time`],
    reads: [`items/${item}`],
    spans: [{ track: "track-2", lo: t - 1, hi: t + 3.5 }],
    seq,
  };
}

export function doc(items: number) {
  return {
    name: "Promo cut",
    description: "",
    aspectRatio: "16:9",
    tracks: Array.from({ length: 6 }, (_, i) => ({ id: `track-${i}`, pos: `a${i}`, name: `Track ${i + 1}`, type: i < 3 ? "video" : "audio", locked: false, visible: true, muted: false })),
    items: Array.from({ length: items }, (_, i) => ({
      id: `item-${i}`,
      pos: `a${i.toString(36)}`,
      trackId: `track-${i % 6}`,
      mediaId: `media-${i % 40}`,
      startTime: i * 0.5,
      endTime: i * 0.5 + 0.45,
      trimStart: 0,
      trimEnd: 0.45,
      playbackSpeed: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      opacity: 1,
      name: `Clip ${i}`,
    })),
  };
}
