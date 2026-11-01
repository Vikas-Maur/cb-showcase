// Template: copy it into your repo and swap the lines marked "← your …" for your own.
// Run the HostAdapter and IdentitySource suites against your adapter, on project.json files from your own
// projects, and the full Cardboard suite (CLI-made fixtures, the round trip, B10 with the real fm∘sv when the
// renderer bundle is present).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostAdapterSuite, identitySourceSuite, cardboardSuite } from "@carton/conformance";
import { cardboardAdapter, cardboardIdentity, type CardboardProject } from "@carton/cardboard"; // ← your adapter

// Your own sample projects: a folder of `<name>/project.json` files written by Cardboard. Here: the CLI-made fixtures
// that ship inside @carton/conformance.
const SAMPLES = process.env.SAMPLES ?? fileURLToPath(new URL("./cardboard/fixtures/", import.meta.resolve("@carton/conformance")));
const hosts: CardboardProject[] = [];
for (const d of readdirSync(SAMPLES, { withFileTypes: true }))
  for (const f of ["project.json", "project.before.json", "project.after.json"])
    try {
      hosts.push((JSON.parse(readFileSync(join(SAMPLES, d.name, f), "utf8")) as { project: CardboardProject }).project);
    } catch {}

hostAdapterSuite("my-adapter", cardboardAdapter, { hosts });

identitySourceSuite("my-identity", cardboardIdentity, [
  { env: {}, expect: null },
  { env: { CARDBOARD_ACTOR: "director/chat-9/turn-3" }, expect: { kind: "agent", id: "director/chat-9/turn-3", name: "Director", provider: "claude-code", chat: "chat-9", turn: "turn-3" } },
]);

await cardboardSuite();
