// The Worker's proxy-stream batch limits (cf-proxy-path): PREVIEW_BATCH_PARTS, PREVIEW_BATCH_BYTES and
// PREVIEW_READ_BYTES, with defaults chosen for the Free plan's 10 ms of CPU a request (worker.ts PREVIEW_DEFAULTS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { depsFor, PREVIEW_DEFAULTS } from "../src/worker.ts";
import type { Env } from "../src/env.ts";

const env = (more: Record<string, string> = {}) => ({ AUTH_SECRET: "a-test-secret-of-enough-length-0123456789", ...more }) as unknown as Env;

test("defaults for the Free plan, unless the deployment sets its own", () => {
  assert.deepEqual(depsFor(env()).streamLimits, { ...PREVIEW_DEFAULTS });
  assert.deepEqual(depsFor(env({ PREVIEW_BATCH_PARTS: "8", PREVIEW_BATCH_BYTES: "4194304", PREVIEW_READ_BYTES: "4194304" })).streamLimits, { appendParts: 8, appendBytes: 4194304, readBytes: 4194304 });
  // nonsense falls back to the default, never to 0 or a fraction
  assert.deepEqual(depsFor(env({ PREVIEW_BATCH_PARTS: "0", PREVIEW_BATCH_BYTES: "x", PREVIEW_READ_BYTES: "1.5" })).streamLimits, { ...PREVIEW_DEFAULTS });
});
