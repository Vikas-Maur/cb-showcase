// Tests for patch-main.js 15 (asar-assets.js): app:// serves the app's files from app.asar without a copy in %TEMP%,
// and the one-time sweep of the copies earlier builds left. Run under Node against Cardboard 1.4.0's own main.js
// (CARDBOARD_PRISTINE, as for patches.test.js; without it the tests skip):
//   CARDBOARD_PRISTINE=… node --test scripts/carton/test/asar-assets.test.js
// No Electron here: the app:// module is cut out of the bundle and run with a stand-in for electron's protocol, on a
// real folder named app.asar (to plain Node a folder; to __cbInAsar, an archive). Electron's own copy-out, and that
// the patched handler doesn't trigger it, is shown on the real Electron 43.7.0 (the README's patch 15).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const { stage } = require("./stage.js");

const PRISTINE = process.env.CARDBOARD_PRISTINE;
const skip = !PRISTINE || !fs.existsSync(path.join(PRISTINE ?? "", "app-asar")) ? "set CARDBOARD_PRISTINE to Cardboard 1.4.0's unpacked app and cli" : false;
const TMP = path.join(process.env.CARTON_TEST_DIR ?? path.join(os.tmpdir(), "carton-patch-tests"), "asar-assets");
const HELPERS = require("../../asar-assets.js");
const STOCK = "let s=Hke.Readable.toWeb((0,Bke.createReadStream)(e));return new Response(s,{status:200,headers:i})";

let pristine, patched;
test.before(() => {
  if (skip) return;
  fs.rmSync(TMP, { recursive: true, force: true });
  pristine = fs.readFileSync(path.join(PRISTINE, "app-asar", "dist", "main.js"), "utf8");
  patched = fs.readFileSync(stage(PRISTINE, path.join(TMP, "stage")).main, "utf8");
});

// The app:// module (Pq) of a main.js, run with a stand-in electron; returns the request handler Gke registers.
const appHandler = (bundle, win) => {
  const a = bundle.indexOf('hw=require("electron"),Bke='), end = "for(let s of t)s.handle(Iq,i)}", b = bundle.indexOf(end, a);
  assert.ok(a > 0 && b > a, "the app:// module");
  const electron = { net: { fetch: () => new Response("passed on") }, protocol: { registerSchemesAsPrivileged() {} } };
  const fn = new Function("require", "__cbWin", HELPERS + "\nvar hw,Bke,Aq,_a,Hke,Iq,qke,Vke,uGt,fGt,Wke,pGt,mGt,hGt,zke,nI,Gke;var Df=()=>{},Vs=\"cardboard-media\";\n" +
    bundle.slice(a, b + end.length) + ";\nreturn Gke;");
  const Gke = fn((m) => (m === "electron" ? electron : require(m)), win);
  let handler;
  return (root) => (Gke(root, [{ handle: (scheme, h) => { assert.equal(scheme, "app"); handler = h; } }]), handler);
};

test("patch 15: on Windows a file in app.asar is read, not streamed; elsewhere, and outside an archive, as before", { skip }, () => {
  const count = (s, t) => s.split(t).length - 1;
  assert.equal(count(pristine, STOCK), 1);
  assert.equal(count(patched, STOCK), 0);
  assert.equal(count(patched, "let s=__cbWin&&__cbInAsar(e)?await __cbAsarBody(e):Hke.Readable.toWeb((0,Bke.createReadStream)(e));return new Response(s,{status:200,headers:i})"), 1);
  assert.equal(count(patched, "he.createWindow({quiet:r});__cbWin&&__cbAsarSweepSoon(he.window);let a="), 1);
  assert.ok(patched.includes(HELPERS), "the helpers are in the preamble");
  // The media handler (cardboard-media, ranges) serves the library, never app.asar: untouched.
  assert.equal(count(patched, "let f=kke.Readable.toWeb((0,wke.createReadStream)(n.path,{start:c,end:d}));"), 1);
  const H = new Function(HELPERS + "\nreturn { __cbInAsar };")();
  for (const p of ["C:\\Program Files\\Cardboard\\resources\\app.asar\\dist\\renderer\\index.html", "/x/app.asar/a.js", "C:\\x\\App.ASAR"]) assert.ok(H.__cbInAsar(p), p);
  for (const p of ["C:\\x\\app.asar.unpacked\\a.node", "C:\\Users\\me\\Videos\\clip.mp4", "/x/notasar/a.js", "C:\\x\\my.asarfile\\a"]) assert.ok(!H.__cbInAsar(p), p);
});

test("patch 15: app:// answers the same, byte for byte and header for header: pristine, patched on Windows, patched on macOS", { skip }, async () => {
  const root = path.join(TMP, "res", "app.asar", "dist", "renderer");
  const files = { "index.html": "<!doctype html><p>home</p>", "assets/a-1.js": "export const a = 1;\n".repeat(5000), "vendor/x.js": "x", "emoji/e.svg": "<svg/>", "assets/big.woff2": crypto.randomBytes(3 << 20), "assets/empty.css": "" };
  for (const [f, d] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.writeFileSync(path.join(root, f), d);
  const urls = ["index.html", "assets/a-1.js", "vendor/x.js", "emoji/e.svg", "assets/big.woff2", "assets/empty.css", "assets/missing.js", "some/route", "../../../etc/passwd", "assets"].map((u) => "app://cardboard/" + u);
  const run = async (bundle, win) => {
    const h = appHandler(bundle, win)(root), out = [];
    for (const url of [...urls, "app://elsewhere/x"])
      for (const init of [{}, { headers: { Range: "bytes=0-9" } }, { method: "HEAD" }]) {
        const r = await h(new Request(url, init));
        out.push({ url, init, status: r.status, headers: [...r.headers], body: crypto.createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest("hex") });
      }
    return out;
  };
  const before = await run(pristine, false);
  assert.deepEqual(await run(patched, true), before);
  assert.deepEqual(await run(patched, false), before);
  assert.equal(before.find((r) => r.url.endsWith("big.woff2")).headers.find(([k]) => k === "content-length")[1], String(3 << 20));
  // A file that stats but can't be read: the stock stream answers 200 and its body fails; so does the Windows read,
  // for an asset and for the index.html fallback.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const fail = async (bundle, win, url) => {
      const r = await appHandler(bundle, win)(root)(new Request(url));
      return [r.status, await r.arrayBuffer().then(() => "read", () => "body failed")];
    };
    for (const [file, url] of [["vendor/x.js", "app://cardboard/vendor/x.js"], ["index.html", "app://cardboard/some/route"]]) {
      fs.chmodSync(path.join(root, file), 0);
      try {
        const stock = await fail(pristine, false, url);
        assert.deepEqual(stock, [200, "body failed"]);
        assert.deepEqual(await fail(patched, true, url), stock);
      } finally { fs.chmodSync(path.join(root, file), 0o644); }
    }
  }
});

test("patch 15: the sweep deletes only old <uuid>.tmp[.ext] files that are byte copies of a file in app.asar, until none are left", { skip }, async () => {
  const H = new Function("require", HELPERS + "\nreturn { __cbAsarSweepRun };")(require);
  const app = path.join(TMP, "sweep", "resources", "app.asar"), tmp = path.join(TMP, "sweep", "temp"), ud = path.join(TMP, "sweep", "ud");
  for (const d of [path.join(app, "dist", "renderer", "assets"), tmp, ud]) fs.mkdirSync(d, { recursive: true });
  const a = crypto.randomBytes(5000), b = Buffer.from("console.log(1)\n"), u = () => crypto.randomUUID();
  fs.writeFileSync(path.join(app, "dist", "renderer", "assets", "a.js"), a);
  fs.writeFileSync(path.join(app, "dist", "main.js"), b);
  fs.writeFileSync(path.join(app, "package.json"), "{}");
  const gone = [], kept = [];
  const put = (name, data, del) => { fs.writeFileSync(path.join(tmp, name), data); (del ? gone : kept).push(name); };
  put(u() + ".tmp.js", a, true);
  put(u() + ".tmp.js", b, true);
  put(u().toUpperCase() + ".tmp.JS", a, true);
  put(u() + ".tmp.json", "{}", true);
  const flipped = Buffer.from(a); flipped[2500] ^= 1;
  put(u() + ".tmp.js", flipped, false);                       // one byte differs
  put(u() + ".tmp.css", a, false);                            // same bytes, another extension
  put(u() + ".tmp", a, false);                                // same bytes, no extension
  put("report.tmp.js", a, false);                             // same bytes, not a Chromium temp name
  put(u() + ".js", a, false);                                 // same bytes, no .tmp
  put("x" + u() + ".tmp.js", a, false);                       // same bytes, a longer name
  put(u() + ".tmp.js", crypto.randomBytes(a.length), false);  // same size, other bytes
  put(u() + ".tmp.js", Buffer.concat([a, b]), false);         // a copy with more after it
  put(u() + ".tmp.js", a.subarray(0, 4000), false);           // the start of a copy
  put(u() + ".tmp.js", "", false);                            // empty
  const dirName = u() + ".tmp.js"; fs.mkdirSync(path.join(tmp, dirName)); kept.push(dirName);
  if (process.platform !== "win32") {
    const link = u() + ".tmp.js"; fs.symlinkSync(path.join(app, "dist", "renderer", "assets", "a.js"), path.join(tmp, link)); kept.push(link);
  }
  const later = Date.now() + 60_000, mark = () => JSON.parse(fs.readFileSync(path.join(ud, "temp-sweep.json"), "utf8"));
  // bootMs: when Windows started. These files were all made "before" it, except where a test says otherwise.
  const opts = { appPath: app, userData: ud, tempDirs: [tmp, path.join(TMP, "sweep", "no-such-dir")], bootMs: later };
  // Out of time: nothing deleted, not done, so the next start carries on.
  assert.deepEqual({ ...(await H.__cbAsarSweepRun({ ...opts, budgetMs: -1 })), ms: 0 }, { deleted: 0, bytes: 0, recent: 0, failed: 0, ms: 0, done: false });
  assert.deepEqual([mark().done, mark().tries], [false, 1]);
  // Copies made since Windows started may belong to an older build that's still running: kept, and not done.
  const recent = await H.__cbAsarSweepRun({ ...opts, bootMs: Date.now() - 60_000 });
  assert.deepEqual([recent.deleted, recent.recent, recent.done], [0, 4, false]);
  assert.equal(fs.readdirSync(tmp).length, gone.length + kept.length);
  // A copy it can't delete (in use, antivirus): not done either. Here its folder refuses deletes.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    fs.chmodSync(tmp, 0o555);
    try {
      const busy = await H.__cbAsarSweepRun(opts);
      assert.deepEqual([busy.deleted, busy.failed, busy.done], [0, 4, false]);
    } finally { fs.chmodSync(tmp, 0o755); }
  }
  const r = await H.__cbAsarSweepRun(opts);
  assert.deepEqual([r.deleted, r.bytes, r.recent, r.failed, r.done], [4, 2 * a.length + b.length + 2, 0, 0, true]);
  const left = fs.readdirSync(tmp).sort();
  assert.deepEqual(left, [...kept].sort());
  assert.deepEqual([mark().done, mark().deleted], [true, 4]);
  assert.ok(fs.readFileSync(path.join(app, "dist", "renderer", "assets", "a.js")).equals(a), "the app's own file is untouched");
  // Done: it doesn't run again, even with a new copy there.
  put(u() + ".tmp.js", a, false);
  assert.equal(await H.__cbAsarSweepRun(opts), null);
  assert.equal(fs.readdirSync(tmp).length, kept.length);
  // Not done after 20 starts: it gives up.
  fs.writeFileSync(path.join(ud, "temp-sweep.json"), JSON.stringify({ version: 1, done: false, tries: 20 }));
  assert.equal(await H.__cbAsarSweepRun(opts), null);
  fs.writeFileSync(path.join(ud, "temp-sweep.json"), JSON.stringify({ version: 1, done: false, tries: 19 }));
  assert.equal((await H.__cbAsarSweepRun(opts)).deleted, 1);
  assert.deepEqual([mark().done, mark().tries], [true, 20]);
  kept.pop();
  // Not from an archive (a dev run from a folder): nothing to sweep.
  fs.rmSync(path.join(ud, "temp-sweep.json"));
  assert.equal(await H.__cbAsarSweepRun({ ...opts, appPath: path.join(TMP, "sweep", "resources") }), null);
  assert.equal(fs.readdirSync(tmp).length, kept.length);
});
