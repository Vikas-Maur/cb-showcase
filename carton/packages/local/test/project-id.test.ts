// The project id `openLocal({ projectDir })` keys carton.db with (L15): Cardboard 1.4.0's project.json is an envelope,
// `{format, version, project: {id, …}, media}`; a bare project (other hosts, these tests' bundles) keeps `id` at the top.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProjectId } from "../src/open.ts";
import { scratch } from "./support/scratch.ts";

const dirWith = (body: unknown) => {
  const dir = mkdtempSync(join(scratch(), "project-id-"));
  writeFileSync(join(dir, "project.json"), JSON.stringify(body));
  return dir;
};

test("readProjectId reads Cardboard's envelope (project.id), and a bare project's top-level id", () => {
  assert.equal(readProjectId(dirWith({ format: "cardboard-project", version: 1, project: { id: "cb-1", name: "Demo" }, media: [] })), "cb-1");
  assert.equal(readProjectId(dirWith({ id: "bare-1", name: "Demo" })), "bare-1");
  assert.throws(() => readProjectId(dirWith({ format: "cardboard-project", version: 1, project: { name: "no id" } })), /no project id/);
});
