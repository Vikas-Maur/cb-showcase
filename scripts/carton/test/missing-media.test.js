// UI audit P1-9: a teammate who opens a shared project never lands on Cardboard's "Missing Media Files" with its red
// "Remove and Open" for clips that were never on their computer. The editor patch (scripts/carton/sync/patches/media.js),
// run here on its own text with a stand-in bridge: no app needed.
//   node --test scripts/carton/test/missing-media.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const part = require("../sync/patches/media.js");

// The patch's replaces and preamble, as patch-carton-sync.js would apply them.
function load(bridge) {
  const edits = { main: [], editor: [] }, pre = { main: "", editor: "" };
  const file = (k) => ({ replace: (from, to, n = 1) => edits[k].push([from, to, n]), prepend: (t) => { pre[k] = t + pre[k]; } });
  part.app({ main: file("main"), editor: file("editor") });
  const events = [];
  const window = { __carton: bridge, dispatchEvent: (e) => events.push(e.detail) };
  class CustomEvent { constructor(type, o) { this.type = type; this.detail = o?.detail; } }
  const api = new Function("window", "CustomEvent", pre.editor + "\nreturn { inspect: __cbCartonInspect, split: __cbCartonSplit };")(window, CustomEvent);
  return { ...api, edits: edits.editor, events, window };
}

const media = [
  { id: "mine", data: { fileName: "mine.mp4" } },
  { id: "theirs-ready", data: { fileName: "intro.mp4", src: "cardboard-media://media/theirs-ready" } },
  { id: "theirs-later", data: { fileName: "broll.mp4", src: "cardboard-media://media/theirs-later" } },
  { id: "moved", data: { fileName: "moved.mp4" } },
];
const inspected = () => new Map([["mine", { status: "available", item: media[0] }], ["theirs-ready", { status: "missing" }], ["theirs-later", { status: "missing" }], ["moved", { status: "missing" }]]);
const missingItem = (id) => ({ mediaId: id, fileName: id, status: "not_found", reason: "local_gone" });

test("the loader's two anchors are the media check and the hand-off to the offline list, once each", () => {
  const { edits } = load({ on: true });
  assert.deepEqual(edits.map(([from, , n]) => [from, n]), [
    ["inspections:await kr.inspect(e.id,e.media)", 1],
    ["return t.missingItems.length>0&&zn.getState().addOfflineMediaBatch(t.missingItems),t}", 1],
  ]);
});

test("a teammate's clip plays from its shared preview; one not sent yet is Offline, never in Missing Media Files; a moved original still is", async () => {
  const asked = [];
  const p = load({ on: true, call: async (m, [a]) => { asked.push([m, a]); return { clips: { "theirs-ready": "playable", "theirs-later": "waiting", moved: "local" } }; } });
  const out = await p.inspect("proj", media, inspected());
  assert.deepEqual(asked, [["liveMediaHere", { projectId: "proj", mediaIds: ["theirs-ready", "theirs-later", "moved"] }]], "only the clips with no file are asked about");
  assert.deepEqual(out.get("theirs-ready"), { status: "available", item: media[1] }, "plays from cardboard-media://, which main answers from the host");
  assert.equal(out.get("theirs-later").status, "missing");
  assert.equal(out.get("moved").status, "missing");
  // What 1.4.0's loader would send to "Missing Media Files": only the clip that was on this computer.
  const offline = [];
  const left = p.split("proj", [missingItem("theirs-later"), missingItem("moved")], (w) => offline.push(...w));
  assert.deepEqual(left.map((i) => i.mediaId), ["moved"]);
  assert.deepEqual(offline.map((i) => [i.mediaId, i.status]), [["theirs-later", "carton_waiting"]], "Cardboard's Offline placeholder, under a status Remove and Open never removes");
  assert.deepEqual(p.events.at(-1), { projectId: "proj", waiting: [{ mediaId: "theirs-later", fileName: "broll.mp4" }], playable: 1 });
});

test("all of a teammate's footage playable: the notice still says the originals aren't here; nothing goes offline", async () => {
  const p = load({ on: true, call: async () => ({ clips: { "theirs-ready": "playable", "theirs-later": "playable" } }) });
  const out = await p.inspect("proj", media.slice(0, 3), new Map([...inspected()].slice(0, 3)));
  assert.equal(out.get("theirs-later").status, "available");
  assert.deepEqual(p.events, [{ projectId: "proj", waiting: [], playable: 2 }]);
  const offline = [];
  assert.deepEqual(p.split("proj", [], (w) => offline.push(...w)), []);
  assert.deepEqual(offline, []);
});

test("Carton off, a project that isn't shared, or a worker that fails: Cardboard's own path, untouched", async () => {
  const items = [missingItem("theirs-later"), missingItem("moved")];
  for (const bridge of [{ on: false }, { on: true, call: async () => null }, { on: true, call: async () => { throw new Error("no worker"); } }]) {
    const p = load(bridge);
    const before = inspected();
    const out = await p.inspect("proj", media, before);
    assert.equal(out, before, "the same map");
    const offline = [];
    assert.equal(p.split("proj", items, (w) => offline.push(...w)), items);
    assert.deepEqual(offline, []);
  }
});
