import { test } from "node:test";
import assert from "node:assert/strict";
import * as mod from "../src/index.ts";

test("@carton/blob-memory loads", () => {
  assert.ok(Object.keys(mod).length > 0);
});
