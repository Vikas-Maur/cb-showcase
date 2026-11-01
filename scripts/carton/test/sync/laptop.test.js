// Bugs from the laptop test of the Windows build at 90c4127 (_inspect/carton-build/LAPTOP-REPORT-90c4127.md), with
// Cardboard 1.4.0's real cb and library worker (support.js):
//   #2 agents' cb edits overwrote each other: a print carries Carton's exact header, a numeric header's base is the
//      exact version it names, and `cb source check` of an unchanged print finds nothing, with the revs of several
//      writers out of save order (the facade's half, a writer's document past others, is facade.test.js's);
//   #5 a .cbproj exported with Carton opens in another Carton-on library that hasn't the project;
//   #9 cb's first call after `project create` says nothing about history being off.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/laptop.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const S = require("./support.js");

const t = { skip: S.skip, timeout: 300_000 };
const TITLES = 'export default (\n  <timeline aspect="16:9">\n    <track name="Agents">\n      <text name="W1" start={0} end={1} fontSize={100} textContent="W1" />\n      <text name="W2" start={1} end={2} fontSize={100} textContent="W2" />\n    </track>\n  </timeline>\n);\n';
const CARTON_HEADER = /^\/\/ cardboard:rev (.+@\d+~[0-9a-f]{8} b:[0-9a-f]{8})\s*$/m;
const sizeOf = (text, name) => Number(new RegExp(`<text[^>]*name="${name}"[^>]*fontSize=\\{(\\d+)\\}`).exec(text)?.[1]);
const setSize = (text, name, n) => text.replace(new RegExp(`(<text[^>]*name="${name}"[^>]*fontSize=\\{)\\d+(\\})`), `$1${n}$2`);

/** cb's own output, as an agent reads it (no --json). */
const raw = (pc, b, args) => {
  const r = spawnSync(process.execPath, [path.join(b.cli, "cardboard.mjs"), "--root", pc.root, ...args], { env: pc.env, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

// In a child, as another writer whose rev was taken before the print's (each cb process's own clock; commits land in
// another order): a version of W1's title committed through the built facade with an older stateUpdatedAt, and
// installed into project.json as the store does.
const OTHER = String.raw`
const fs = require("fs"), path = require("path");
const [carton, bundle, size] = process.argv.slice(1);
const api = require(path.join(carton, "carton-node.cjs")).cardboard14;
const file = path.join(bundle, "project.json");
(async () => {
  const env = JSON.parse(fs.readFileSync(file, "utf8")), p = env.project;
  const doc = { ...p, timelineItems: p.timelineItems.map((i) => (i.name === "W1" ? { ...i, fontSize: Number(size) } : i)), stateUpdatedAt: p.stateUpdatedAt - 60_000 };
  const r = await api.commit({ bundlePath: bundle, base: p, doc, actor: "codex/other" });
  const tmp = path.join(bundle, ".project.json.other.tmp");
  fs.writeFileSync(tmp, JSON.stringify({ ...env, project: r.doc }));
  const ok = await api.install(tmp, file, undefined, r.doc.stateUpdatedAt);
  process.stdout.write(JSON.stringify({ status: r.status, ok, rev: r.doc.stateUpdatedAt, was: p.stateUpdatedAt }) + "\n");
  process.exit(0);
})().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e?.stack ?? e) }) + "\n"); process.exit(1); });
`;

test("#2 a print carries Carton's exact header; its base, and an old numeric print's, is exactly the version printed, with writers' revs out of save order", t, async () => {
  const b = await S.build();
  const pc = await S.computer("laptop-2", b);
  const must = (x, what) => assert.equal(x.code, 0, what + ": " + x.out + x.err);
  must(pc.cb(["project", "create", "Demo"]), "create");
  const tsx = (name, text) => (fs.writeFileSync(path.join(pc.home, name), text), path.join(pc.home, name));
  must(pc.cb(["source", "apply", "Demo", tsx("titles.tsx", TITLES)]), "apply");
  const bundle = pc.cb(["project", "list"]).json().find((p) => p.name === "Demo").bundlePath;
  const printed = raw(pc, b, ["source", "print", "Demo"]);
  must(printed, "print");
  assert.match(printed.out, CARTON_HEADER, "the print names its version as Carton does");
  // the same print as 1.4.0 wrote it: its header the project's rev
  const rev = JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")).project.stateUpdatedAt;
  const old = printed.out.replace(CARTON_HEADER, `// cardboard:rev ${rev}`);
  assert.notEqual(old, printed.out);
  // another writer's version lands after the print, under an older rev
  const o = spawnSync(process.execPath, ["-e", OTHER, b.carton, bundle, "150"], { env: pc.env, encoding: "utf8", timeout: 120_000 });
  const other = JSON.parse(o.stdout.trim().split("\n").pop() || "{}");
  assert.ok(!other.error && other.status === "confirmed" && other.ok === true && other.rev < other.was, "the other writer: " + o.stdout + o.stderr);
  // a check of either print, unchanged, finds nothing: its base is the version it shows, not the other writer's
  for (const [name, text] of [["carton", printed.out], ["numeric", old]]) {
    const c = pc.cb(["source", "check", "Demo", tsx(`check-${name}.tsx`, text)]);
    must(c, "check " + name);
    assert.deepEqual(c.json().ops, [], `cb source check of the unchanged ${name} print: ` + JSON.stringify(c.json().ops));
  }
  // an edit of W2 from the old numeric print keeps the other writer's W1
  must(pc.cb(["source", "apply", "Demo", tsx("w2.tsx", setSize(old, "W2", 170))]), "apply W2");
  const now = raw(pc, b, ["source", "print", "Demo"]).out;
  assert.deepEqual([sizeOf(now, "W1"), sizeOf(now, "W2")], [150, 170], "W1 stays the other writer's, W2 is the edit");
  assert.match(now, CARTON_HEADER);
});
