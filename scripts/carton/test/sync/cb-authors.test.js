// ui-words #4: a `cb` that nothing names (no CARDBOARD_ACTOR) is recorded through @carton/local's identity chain, never
// as an agent called "cli" (History showed "cli" as the author of the person's own `cb media add`). A person at a
// terminal is the terminal user (History tells it as "You"); Claude Code, Codex or Gemini are recognised from their
// environment and named by their product.
//   CARDBOARD_PRISTINE=<Cardboard 1.4.0 unpacked> node --test --test-concurrency=1 scripts/carton/test/sync/cb-authors.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./support.js");

const t = { skip: S.skip || S.noBuild, timeout: S.TEST_MS };
let b, pc;

test.before(async () => {
  if (t.skip) return;
  b = await S.build();
  pc = await S.computer("cb-authors", b);
}, { timeout: S.SETUP_MS });
test.after(() => S.killHelpers(), { timeout: S.STOP_MS });

const authors = () => {
  const r = pc.cb(["history", "Demo"]);
  assert.equal(r.code, 0, r.out + r.err);
  return r.json().versions.map((v) => v.by).filter(Boolean);
};

test("a cb with no actor is the person at the terminal, or the agent CLI its environment says; never 'cli'", t, () => {
  const must = (r, what) => assert.equal(r.code, 0, `${what}: ${r.out}${r.err}`);
  must(pc.cb(["project", "create", "Demo"]), "create");
  must(pc.cb(["media", "add", "Demo", b.clip]), "media add by the person");
  const person = authors().find((a) => a.id !== "import");
  assert.ok(person, "the media add has an author");
  assert.equal(person.kind, "external");
  assert.match(person.id, /^terminal:/);
  for (const a of authors()) assert.notEqual(a.id, "cli");
  // the same command from Claude Code's terminal
  must(pc.cb(["media", "add", "Demo", b.clip2], { CLAUDECODE: "1" }), "media add by Claude Code");
  const claude = authors().find((a) => a.provider === "claude-code");
  assert.ok(claude, JSON.stringify(authors()));
  assert.deepEqual([claude.kind, claude.name], ["agent", "Claude Code"]);
});
