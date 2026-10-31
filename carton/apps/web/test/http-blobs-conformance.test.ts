// Runs the BlobStore conformance suite against httpBlobStore (fixtures/http-blob-suite.ts), skipping only what the
// host's HTTP API can't do or what isn't HTTP's to pass:
//   - list and delete have no route: their own tests would only exercise the host's store, not HTTP;
//   - `sha256` can't travel with a signed PUT (the host reads the body and its content type only), so the first test's
//     head has no sha256. Its other checks (bytes, size, content type) are in http-blobs.test.ts;
//   - "keys are opaque" ends with a 1024-byte key, which the host's per-project scope prefix pushes past the store's
//     1024-byte limit (a scoped-store bug, not HTTP's: see the todo test in http-blobs.test.ts). Its other keys are
//     checked over HTTP in http-blobs.test.ts.
// node:test won't start a test run from inside a test file, so the suite runs in its own `node --test` process.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SKIP = [
  "^put then get and head return the bytes and their size$",
  "^list: prefix, order, and paging",
  "^delete removes the key and nothing else$",
  "^keys are opaque",
];

test("httpBlobStore passes the BlobStore conformance suite (except list, delete, sha256 and the longest key)", { timeout: 180_000 }, async () => {
  const fixture = fileURLToPath(new URL("./fixtures/http-blob-suite.ts", import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // set by the outer runner; the child would think it is one of its files
  const args = ["--test", "--test-reporter=tap", "--test-concurrency=1", ...SKIP.map((p) => `--test-skip-pattern=${p}`), fixture];
  const out = await new Promise<string>((resolve) => {
    execFile(process.execPath, args, { env, timeout: 170_000, maxBuffer: 16 << 20, windowsHide: true }, (_err, stdout, stderr) => resolve(`${stdout}\n${stderr}`));
  });
  const count = (what: string) => Number(new RegExp(`^# ${what} (\\d+)$`, "m").exec(out)?.[1] ?? NaN);
  const notOk = out.split("\n").filter((l) => /^\s*not ok /.test(l));
  assert.equal(count("fail"), 0, `failures:\n${notOk.join("\n")}\n\n${out.slice(-4000)}`);
  // 22 tests in the suite today and 4 skipped: the other 18 must have run and passed
  assert.ok(count("pass") >= 18, `only ${count("pass")} passed:\n${out.slice(-4000)}`);
});
