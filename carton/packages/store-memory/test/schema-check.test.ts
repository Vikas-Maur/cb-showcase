// R2-03 (local-cli's intermittent StateUnknown, "rebuilt state does not match the full stateHash"): two processes on
// one carton.db with different document schemas. local-cli's test opened the project with a test adapter, while the
// helper @carton/local spawns when the holder looks stale opened it with the Cardboard adapter (which adds a `media`
// collection). Each hashed the same rows to a different state hash, so a pin one made, the other couldn't check. Every
// process now checks the project's schema fingerprint at open: a different schema at the same version is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Carton, defineSchema, schemaFingerprint, type Doc } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { createMemoryStore } from "../src/index.ts";
import { adapter, doc0, schema, set } from "./fixture.ts";

// the same collections plus one more, at the same schema version (as the Cardboard adapter is to local-cli's test one)
const wider = defineSchema({ collections: { ...Object.fromEntries(Object.entries(schema.collections).map(([n, c]) => [n, { ...c, groups: [...c.groups] }])), media: {} }, timeline: schema.timeline, hard: schema.hard, soft: schema.soft });
const other: HostAdapter<Doc> = { ...adapter, name: "other", schema: wider };

test("R2-03: a process with another document schema is refused at open, before it can make refs the others can't check", async () => {
  assert.notEqual(schemaFingerprint(wider), schemaFingerprint(schema));
  const store = createMemoryStore();
  const a = await Carton.open({ adapter, store, init: { doc: doc0() } });
  await a.commit({ ops: [set("a", "name", "edited")] });
  await assert.rejects(Carton.open({ adapter: other, store }), /another document schema/);
  // the same schema opens, and checks out the pins the first process made
  const b = await Carton.open({ adapter, store });
  const pin = await a.pin({ owner: "turn-1" });
  assert.equal((await b.checkout(pin.header)).name, "Film");
  for (const c of [a, b]) await c.close();
});

test("R2-03: the fingerprint ignores the host's callbacks; a project made before fingerprints gets one on open", async () => {
  // validators and labels don't change how states hash
  const relabelled: HostAdapter<Doc> = { ...adapter, schema: defineSchema({ collections: schema.collections as never, timeline: schema.timeline, hard: null, soft: null, labels: { name: "title" } }) };
  assert.equal(schemaFingerprint(relabelled.schema), schemaFingerprint(schema));
  const store = createMemoryStore();
  const a = await Carton.open({ adapter, store, init: { doc: doc0() } });
  await a.close();
  const meta = (await store.get<Record<string, unknown>>("meta", ["project"]))!;
  assert.equal(meta.schema, schemaFingerprint(schema));
  await store.write([{ table: "meta", key: ["project"], value: { projectId: meta.projectId, schemaVersion: meta.schemaVersion } }]);
  const b = await Carton.open({ adapter: relabelled, store });
  assert.equal((await store.get<Record<string, unknown>>("meta", ["project"]))!.schema, schemaFingerprint(schema));
  await b.close();
  await assert.rejects(Carton.open({ adapter: other, store }), /another document schema/);
  // another schema version is a migration's business, not this check's
  const next = await Carton.open({ adapter: { ...other, schemaVersion: 2 }, store });
  await next.close();
});
