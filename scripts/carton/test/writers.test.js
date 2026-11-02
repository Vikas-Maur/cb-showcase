// writers.js records why an apply failed (laptop timing run: 1 apply in 155 failed, and the log said nothing about
// it): each failure's writer, step, exit code and message in brief, in --out's `failures` and one line each after the
// table, which is otherwise as it was; and every timed edit raw (`samples`: start, duration, outcome), so its timing
// can be recomputed later. Driven against a stand-in `cb` (a .mjs runs with this Node, as writers.js runs Cardboard's
// own) whose third apply fails and fourth clashes. 3 s of edits, so the fourth comes on a loaded box too.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { spawnSync } = require("child_process");

const FAKE_CB = `
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2), root = args[args.indexOf("--root") + 1], rest = args.slice(args.indexOf("--root") + 2);
const bundle = path.join(root, "Carton gates.cardboard"), tsx = path.join(bundle, "timeline.tsx"), n = path.join(root, "applies");
if (rest[0] === "project" && rest[1] === "list") { console.log(JSON.stringify([{ name: "Carton gates", bundlePath: bundle }])); process.exit(0); }
if (rest[0] === "source" && rest[1] === "print") { process.stdout.write(fs.readFileSync(tsx, "utf8")); process.exit(0); }
if (rest[0] === "source" && rest[1] === "apply") {
  const k = Number(fs.existsSync(n) ? fs.readFileSync(n, "utf8") : 0) + 1;
  fs.writeFileSync(n, String(k));
  if (k === 3) { process.stderr.write("Carton: the project's lease is held by another process\\n  (try again)\\n"); process.exit(3); }
  if (k === 4) { console.log(JSON.stringify({ applied: false, status: "conflicts", conflicts: [{ path: "items/w1/fontSize" }] })); process.exit(0); }
  fs.writeFileSync(tsx, fs.readFileSync(rest[3], "utf8"));
  console.log(JSON.stringify({ applied: true }));
  process.exit(0);
}
process.exit(9);
`;

test("writers.js records each failed apply's exit code and reason; the timing table is unchanged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carton-writers-"));
  try {
    const cb = path.join(dir, "cb.mjs"), root = path.join(dir, "lib"), out = path.join(dir, "w.json");
    fs.writeFileSync(cb, FAKE_CB);
    fs.mkdirSync(path.join(root, "Carton gates.cardboard"), { recursive: true });
    fs.writeFileSync(path.join(root, "Carton gates.cardboard", "timeline.tsx"), '<timeline>\n  <text name="W1" start={0} end={1} fontSize={100} textContent="W1" />\n</timeline>\n');
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "writers.js"), "run", cb, root, "--writers", "1", "--rate", "20", "--seconds", "3", "--out", out], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const res = JSON.parse(fs.readFileSync(out, "utf8"));
    const row = res.rows[0];
    // the table's columns are the ones it always had
    assert.deepEqual(Object.keys(row), ["writer", "applied", "failed", "last", "onDisk", "kept", "p50", "p90", "p99"]);
    assert.ok(row.applied >= 2, JSON.stringify(row));
    assert.equal(row.failed, 2);
    assert.equal(res.lost, 0);
    assert.deepEqual(res.failures.map((f) => [f.writer, f.edit, f.step, f.code]), [["W1", 3, "apply", 3], ["W1", 4, "apply", 0]]);
    assert.equal(res.failures[0].reason, "Carton: the project's lease is held by another process (try again)", "stderr, on one line");
    assert.match(res.failures[1].reason, /items\/w1\/fontSize/, "what the JSON said");
    assert.ok(res.failures.every((f) => f.reason.length <= 300));
    assert.match(r.stdout, /no lost updates\nfailed: W1 edit 3 apply, exit 3: Carton: the project's lease/);
    // every timed edit raw, per writer: the table's percentiles recompute from them exactly
    const raw = res.samples.W1;
    assert.deepEqual(Object.keys(res.samples), ["W1"]);
    assert.equal(raw.length, row.applied + row.failed);
    assert.deepEqual(raw.map((x) => Object.keys(x)), raw.map(() => ["edit", "start", "ms", "outcome"]));
    assert.deepEqual(raw.map((x) => x.edit), raw.map((_, i) => i + 1));
    assert.deepEqual(raw.filter((x) => x.outcome === "failed").map((x) => x.edit), [3, 4]);
    assert.equal(raw.filter((x) => x.outcome === "applied").length, row.applied);
    assert.ok(raw.every((x, i) => Number.isFinite(x.start) && x.ms >= 0 && (i === 0 || x.start >= raw[i - 1].start)));
    const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
    assert.deepEqual([pct(raw.map((x) => x.ms), 50), pct(raw.map((x) => x.ms), 90), pct(raw.map((x) => x.ms), 99)], [row.p50, row.p90, row.p99]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
