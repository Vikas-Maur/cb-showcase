// Tests for Cardboard's own timeline codec in both copies (the store bridge's globalThis.__cartonTimelineCodec) and
// for the apply of a file whose rev line is Carton's (H3: headerRev and cartonBase in the store bridge, the facade's
// rev resolution), run under Node against Cardboard 1.4.0's own bundles, staged and patched by stage.js. They are not
// in git: CARDBOARD_PRISTINE names a folder with app-asar/ and cli/; without it the tests skip. The real-facade tests
// also need `npm ci` in carton/. Media import needs ffmpeg and ffprobe (CARDBOARD_FFMPEG / CARDBOARD_FFPROBE, or PATH).
//   CARDBOARD_PRISTINE=… node --test --test-concurrency=1 scripts/carton/test/codec.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync, execFileSync } = require("child_process");
const { stage } = require("./stage.js");

const PRISTINE = process.env.CARDBOARD_PRISTINE;
const skip = !PRISTINE || !fs.existsSync(path.join(PRISTINE ?? "", "app-asar")) ? "set CARDBOARD_PRISTINE to Cardboard 1.4.0's unpacked app and cli" : false;
const TMP = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.tmpdir(), "carton-patch-tests"), "codec");
const WORKSPACE = path.join(__dirname, "..", "..", "..", "carton");
const noBuild = skip || (!fs.existsSync(path.join(WORKSPACE, "node_modules", "esbuild")) && "run `npm ci` in carton/ to build the facade");

let win, carton, clip;
const env = (extra = {}) => ({ ...process.env, HOME: path.join(TMP, "home"), USERPROFILE: path.join(TMP, "home"), ...extra });
const cb = (cli, root, args, extra) => {
  const r = spawnSync(process.execPath, [path.join(cli, "cardboard.mjs"), "--root", root, "--json", ...args], { env: env(extra), encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
};
const json = (r) => JSON.parse(r.stdout.replace(/^\[carton\][^\n]*\n/gm, ""));
const ok = (r, what) => (assert.equal(r.code, 0, what + "\n" + r.out), r);
// Ids, times and the library's path differ between two runs; nothing else may.
const norm = (s) => s
  .replace(/[\\/]lib-[a-z0-9-]+/g, "/LIB")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "UUID")
  .replace(/\b1[78]\d{11}\b/g, "REV")
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g, "TIME");

// A clip, a title and a code graphic (whose source Cardboard keeps in the project's media, not in the item).
const EDIT1 = `export default (
  <timeline aspect="16:9">
    <track name="V1">
      <clip src="clip.mp4" start={0} end={2} />
    </track>
    <track name="Titles">
      <text name="Hello" start={0.5} end={2.5} fontSize={120} textContent="Hello" />
      <code name="Badge" start={0} end={2} codeComposition={{ width: 1920, height: 1080, source: "export default function Badge({ width, height }) { return <div style={{ width, height, fontFamily: 'Inter, sans-serif', color: '#fff' }}>Hi</div>; }" }} />
    </track>
  </timeline>
);
`;
const write = (name, text) => { const f = path.join(TMP, name); fs.writeFileSync(f, text); return f; };
// A library with the project "Demo": the clip imported and EDIT1 applied. Returns the bundle folder.
const setup = (cli, root, extra) => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  ok(cb(cli, root, ["project", "create", "Demo"], extra), "create");
  ok(cb(cli, root, ["media", "add", "Demo", clip], extra), "media add");
  ok(cb(cli, root, ["source", "apply", "Demo", write(path.basename(root) + "-edit1.tsx", EDIT1)], extra), "apply");
  return path.join(root, "Demo.cardboard");
};
const project = (bundle) => JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project;
const item = (p, type) => p.timelineItems.find((i) => i.type === type);
const codeSource = (p) => p.media.find((m) => m.id === item(p, "code").mediaItemId)?.data?.code?.source;
const timeline = (bundle) => fs.readFileSync(path.join(bundle, "timeline.tsx"), "utf8");
// Edits of a printed timeline.tsx, as an agent makes them.
const clipTo25 = (t) => t.replace(/(<clip[\s\S]*?)end=\{2\}([\s\S]*?)out=\{2\}/, "$1end={2.5}$2out={2.5}");
const withRev = (t, body) => t.replace(/^\/\/ cardboard:rev .*$/m, "// cardboard:rev " + body);
// Carton's header body for the project's head, as the Materializer prints it (header.ts renderRev): the cut's name as
// `cb history` gives it, the head's ref (with its state hash) as the facade reads it in a process of its own.
const cartonHeader = (cli, root, extra) => {
  const { cut } = json(ok(cb(cli, root, ["history", "Demo"], extra), "history"));
  const r = spawnSync(process.execPath, ["-e", `require(process.argv[1]).internals.local(process.argv[2]).then((l) => console.log(l.ref))`, path.join(extra.CARTON_DIR, "carton-node.cjs"), path.join(root, "Demo.cardboard")], { env: env(), encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const ref = JSON.parse(r.stdout.trim().split("\n").pop());
  // (core's branchToken: the id's first 8 characters when they are lowercase hex, else its SHA-256's)
  const token = /^[0-9a-f]{8}/.test(ref.branchId) ? ref.branchId.slice(0, 8) : require("crypto").createHash("sha256").update(ref.branchId).digest("hex").slice(0, 8);
  return `${cut.name}@${ref.seq}~${ref.hash.slice(0, 8)} b:${token} p:0a1b2c3d by codec-test`;
};
const PRINT_AGAIN = /This timeline was printed from version Main cut@\d+~deadbeef, which is no longer available\. Print it again \(cb source print\) and redo the edit\./;

// The recording fake facade (fake-carton-node.cjs), copied as carton-node.cjs into a folder of this file's own.
const withFake = () => ({ CARDBOARD_CARTON: "1", CARTON_DIR: path.join(TMP, "fake"), FAKE_CARTON_LOG: path.join(TMP, "fake.log") });
// The real facade, built once from the carton workspace.
let built = null;
const real = async () => {
  built ??= require("../build.js").build(path.join(TMP, "bundle"), carton.assets).then(() => path.join(TMP, "bundle", "carton"));
  return { CARDBOARD_CARTON: "1", CARTON_DIR: await built, CARDBOARD_ACTOR: "codec-test" };
};
const runWorker = (worker, root, extra) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "codec-run.js"), worker, root], { env: env(extra), encoding: "utf8", timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop());
};

test.before(() => {
  if (skip) return;
  fs.mkdirSync(path.join(TMP, "home"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "fake"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "fake-carton-node.cjs"), path.join(TMP, "fake", "carton-node.cjs"));
  win = stage(PRISTINE, path.join(TMP, "win"));
  carton = stage(PRISTINE, path.join(TMP, "carton"), { carton: true });
  clip = path.join(TMP, "clip.mp4");
  if (!fs.existsSync(clip)) execFileSync(process.env.CARDBOARD_FFMPEG ?? "ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
});

// What the codec's print and parse must be, beside Cardboard's own print of the same project.
const checkCodec = (r, rev) => {
  assert.equal(r.codec ?? "object", "object");
  const mine = r.printed.split("\n"), own = r.own.split("\n");
  assert.equal(mine.length, own.length);
  assert.deepEqual(mine.map((l, i) => (l === own[i] ? null : i)).filter((i) => i !== null), [3], "only the rev line differs");
  assert.equal(mine[3], "// cardboard:rev " + rev, "the rev verbatim on Cardboard's rev line");
  assert.match(own[3], /^\/\/ cardboard:rev \d+$/);
  assert.ok(!r.roundTrip.error, r.roundTrip.error);
  assert.deepEqual(r.roundTrip.project, r.project, "parse(print(p), p) is p");
  assert.equal(r.half.name, "SyntaxError", "a half-written file is refused");
  assert.match(r.half.error, /^The timeline doesn't apply: /);
  assert.ok(r.untouched, "parse leaves the project it was given as it was");
};

test("the codec in cb's copy: Cardboard's print with the given rev, its parse back and what cb source apply writes", { skip }, () => {
  const root = path.join(TMP, "lib-cli-codec"), extra = withFake();
  const b = setup(carton.cli, root, extra);
  const rev = "Main cut@3~0badf00d b:12345678 p:deadbeef by codec-test";
  const probe = (...files) => json(ok(cb(carton.cli, root, ["codec-probe", "Demo", "--rev", rev, ...(files.length ? ["--parse", ...files] : [])], extra), "codec-probe"));
  const one = probe();
  const half = write("cli-half.tsx", one.printed.slice(0, Math.floor(one.printed.length / 2)));
  checkCodec({ ...one, half: probe(half).parsed[0] }, rev);
  assert.equal(one.again, one.printed, "deterministic");
  // The print is `cb source print`'s, but for the rev line.
  const printed = json(ok(cb(carton.cli, root, ["source", "print", "Demo"], extra), "source print")).source;
  assert.equal(printed, one.own);
  // An agent's edit of the file (sizes, times, the code graphic's source): the parse is exactly what cb source apply
  // writes into project.json, but for the save's times, which stay the project's.
  const edited = write("cli-edited.tsx", clipTo25(one.own).replace("fontSize={120}", "fontSize={140}").replace(">Hi</div>", ">Hey</div>"));
  const newPath = write("cli-new-path.tsx", one.own.replace('src="clip.mp4"', 'src="./other.mp4"'));
  const [parsed, refused] = probe(edited, newPath).parsed;
  assert.ok(!parsed.error, parsed.error);
  const copy = path.join(TMP, "lib-cli-codec-apply");
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(root, copy, { recursive: true });
  ok(cb(carton.cli, copy, ["source", "apply", "Demo", edited], { CARDBOARD_CARTON: "0" }), "apply of the edit");
  const { updatedAt: _a, stateUpdatedAt: _b, ...applied } = project(path.join(copy, "Demo.cardboard"));
  const { updatedAt, stateUpdatedAt, ...got } = parsed.project;
  assert.deepEqual(got, applied);
  assert.deepEqual([updatedAt, stateUpdatedAt], [one.project.updatedAt, one.project.stateUpdatedAt]);
  assert.equal(item(got, "text").fontSize, 140);
  assert.match(codeSource(got), />Hey<\/div>/, "the code source moved into the project's media");
  assert.equal(item(got, "code").codeComposition.source, undefined);
  // What the apply would import (a path to a file not in the project) needs cb source apply: the parse refuses it.
  assert.match(refused.error, /Unknown media `\.\/other\.mp4`/);
  assert.equal(project(b).timelineItems.find((i) => i.type === "text").fontSize, 120, "nothing written");
});

test("the codec in the worker's copy: Cardboard's print with the given rev and its parse back; none with Carton off", { skip }, () => {
  const seed = path.join(TMP, "lib-worker-seed");
  setup(win.cli, seed);
  const copy = (name) => {
    const root = path.join(TMP, "lib-worker-" + name);
    fs.rmSync(root, { recursive: true, force: true });
    fs.cpSync(seed, root, { recursive: true });
    return root;
  };
  const rev = "30s cut@12~0badf00d b:87654321 p:feedf00d by agent one";
  checkCodec(runWorker(carton.worker, copy("on"), { ...withFake(), CODEC_REV: rev }), rev);
  assert.equal(runWorker(carton.worker, copy("off"), { CARDBOARD_CARTON: "0" }).codec, "undefined");
});

test("cb source apply of a file under a Carton header merges against that exact version; an unknown one is the print-again error; a numeric header as before", { skip: noBuild }, async () => {
  const extra = await real(), root = path.join(TMP, "lib-real"), b = setup(carton.cli, root, extra);
  // Version A: EDIT1. Its print, and Carton's header for it.
  const old = timeline(b), A = cartonHeader(carton.cli, root, extra);
  // Since A, on the current timeline: the clip runs to 2.5 s (version B).
  ok(cb(carton.cli, root, ["source", "apply", "Demo", write("real-b.tsx", clipTo25(timeline(b)))], extra), "apply B");
  const revB = Number(/^\/\/ cardboard:rev (\d+)$/m.exec(timeline(b))[1]);
  const apply = (name, text) => cb(carton.cli, root, ["source", "apply", "Demo", write(name, text)], extra);
  // 1. A's print under A's Carton header (and a later numeric rev line, which doesn't count: only the first one does),
  //    with the title's size changed: merged against A, so B's clip stays.
  const r1 = json(ok(apply("real-1.tsx", withRev(old, A).replace(/^(\/\/ cardboard:rev .*\n)/m, `$1// cardboard:rev ${revB}\n`).replace("fontSize={120}", "fontSize={140}")), "apply 1"));
  assert.equal(r1.applied, true);
  assert.equal(r1.carton.status, "confirmed");
  let p = project(b);
  assert.deepEqual([item(p, "video").endTime, item(p, "text").fontSize], [2.5, 140]);
  // 2. 1.4.0's numeric header of A, as before Carton's form: through the rev map, against A.
  const r2 = json(ok(apply("real-2.tsx", old.replace(">Hi</div>", ">Hey</div>")), "apply 2"));
  assert.equal(r2.carton.status, "confirmed");
  p = project(b);
  assert.deepEqual([item(p, "video").endTime, item(p, "text").fontSize], [2.5, 140]);
  assert.match(codeSource(p), />Hey<\/div>/);
  // 3. The commit's base is A too: the size made on A clashes with 140 since, so head keeps 140 and the agent gets a
  //    card; the rest of its edit lands. (Against head, 130 would have landed and B's clip would be back at 2 s.)
  const r3 = json(apply("real-3.tsx", withRev(old, A).replace("fontSize={120}", "fontSize={130}").replace('textContent="Hello"', 'textContent="Hello there"')));
  assert.equal(r3.carton.status, "conflicts", JSON.stringify(r3.carton));
  p = project(b);
  assert.deepEqual([item(p, "video").endTime, item(p, "text").fontSize, item(p, "text").textContent], [2.5, 140, "Hello there"]);
  assert.match(codeSource(p), />Hey<\/div>/);
  // 4. A Carton ref nothing can rebuild (its state hash isn't A's): the error, and nothing is written.
  const before = fs.readFileSync(path.join(b, "project.json"), "utf8");
  const r4 = apply("real-4.tsx", withRev(old, A.replace(/~[0-9a-f]{8} /, "~deadbeef ")).replace("fontSize={120}", "fontSize={99}"));
  assert.notEqual(r4.code, 0, r4.out);
  assert.match(r4.out, PRINT_AGAIN);
  assert.equal(fs.readFileSync(path.join(b, "project.json"), "utf8"), before);
});

test("the worker's apply of a file under a Carton header merges against that exact version; an unknown one is the print-again error", { skip: noBuild }, async () => {
  const extra = await real(), seed = path.join(TMP, "lib-real-worker-seed"), b = setup(carton.cli, seed, extra);
  const old = timeline(b), A = cartonHeader(carton.cli, seed, extra);
  ok(cb(carton.cli, seed, ["source", "apply", "Demo", write("worker-b.tsx", clipTo25(timeline(b)))], extra), "apply B");
  const root = path.join(TMP, "lib-real-worker");
  fs.rmSync(root, { recursive: true, force: true });
  fs.cpSync(seed, root, { recursive: true });
  const files = [
    write("worker-1.tsx", withRev(old, A).replace("fontSize={120}", "fontSize={140}")),
    write("worker-2.tsx", withRev(old, A.replace(/~[0-9a-f]{8} /, "~deadbeef ")).replace("fontSize={120}", "fontSize={99}")),
  ];
  const rev = "Main cut@1~0badf00d b:12345678";
  const r = runWorker(carton.worker, root, { ...extra, CODEC_REV: rev, CODEC_APPLY: JSON.stringify(files) });
  const [one, two] = r.applied;
  assert.ok(!one.error, one.error);
  assert.equal(one.result.applied, true);
  assert.equal(one.result.carton.status, "confirmed");
  assert.deepEqual([item(one.after, "video").endTime, item(one.after, "text").fontSize], [2.5, 140]);
  assert.match(two.error ?? "(applied)", PRINT_AGAIN);
  assert.equal(item(two.after, "text").fontSize, 140);
  // (and the codec, with the real facade loaded)
  checkCodec(r, rev);
});

test("Carton off: a file under a Carton header applies as the Windows build applies it (1.4.0: onto the current timeline)", { skip }, () => {
  const run = (cli, name, extra) => {
    const root = path.join(TMP, "lib-hdr-" + name), b = setup(cli, root, extra);
    const old = timeline(b);
    ok(cb(cli, root, ["source", "apply", "Demo", write(name + "-b.tsx", clipTo25(timeline(b)))], extra), "apply B");
    const r = cb(cli, root, ["source", "apply", "Demo", write(name + "-hdr.tsx", withRev(old, "Main cut@2~0badf00d b:12345678 p:deadbeef by x").replace("fontSize={120}", "fontSize={140}"))], extra);
    return { code: r.code, out: norm(r.out), project: norm(fs.readFileSync(path.join(b, "project.json"), "utf8")), timeline: norm(timeline(b)), clipEnd: item(project(b), "video").endTime };
  };
  const a = run(win.cli, "win"), off = run(carton.cli, "off", { CARDBOARD_CARTON: "0" });
  assert.equal(a.code, 0, a.out);
  assert.deepEqual(off, a);
  // (1.4.0 reads no rev in it: the file's clip, still at 2 s, wins over B's.)
  assert.equal(a.clipEnd, 2);
});
