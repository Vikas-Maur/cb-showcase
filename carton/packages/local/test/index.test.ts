import { test } from "node:test";
import assert from "node:assert/strict";
import * as mod from "../src/index.ts";

test("@carton/local loads", () => {
  assert.ok(Object.keys(mod).length > 0);
});

test("readProjectId finds the id in Cardboard's project.json envelope and in a plain one", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const root = join(process.env.CARTON_SCRATCH ?? join(homedir(), "gfv-scratch", "carton", "local-cli", "test"));
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "project-id-"));
  writeFileSync(join(dir, "project.json"), JSON.stringify({ format: "cardboard-project", version: 1, project: { id: "p-envelope" }, media: [] }));
  assert.equal(mod.readProjectId(dir), "p-envelope");
  writeFileSync(join(dir, "project.json"), JSON.stringify({ id: "p-plain" }));
  assert.equal(mod.readProjectId(dir), "p-plain");
  writeFileSync(join(dir, "project.json"), JSON.stringify({ project: {} }));
  assert.throws(() => mod.readProjectId(dir), /no project id/);
});
