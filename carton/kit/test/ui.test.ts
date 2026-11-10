// INTEGRATION.md's UI sample, run for real: the History panel's view model served from the worker side over messages
// (`serveUi`) and used in the page (`remoteUi`), with structured clones delivered later, as IPC does.
//   cd carton && node --test kit/test/ui.test.ts        (type-checked with `pnpm exec tsc -p kit/tsconfig.ui.json`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Carton } from "@carton/core";
import { cardboardAdapter, fromHost } from "@carton/cardboard";
import { fromCarton, serveUi, remoteUi } from "@carton/react";
import { createMemoryStore } from "@carton/store-memory";

const kit = join(dirname(fileURLToPath(import.meta.url)), "..");
const readProjectJson = (dir: string) => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));

test("UI: the History panel's view model across a process boundary (serveUi in the worker, remoteUi in the page)", async () => {
  const carton = await Carton.open({ adapter: cardboardAdapter, store: createMemoryStore(), init: { doc: fromHost(readProjectJson(join(kit, "quickstart", "Demo.cardboard")).project, null), asChange: true }, actor: { kind: "human", id: "person", group: "g" } });
  // worker side: the view model over the real handle, served as messages
  const ui = fromCarton(carton, { me: { kind: "human", id: "person", group: "g" } });
  let page!: ReturnType<typeof remoteUi>;
  // stand-in for the IPC: structured clones, delivered later (as postMessage and Electron's IPC do)
  const server = serveUi(ui, (m) => setTimeout(() => page.receive(structuredClone(m)), 0));
  page = remoteUi((m) => setTimeout(() => server.receive(structuredClone(m)), 0));
  await page.ready;
  assert.deepEqual((page.ui.cuts() as readonly { name: string }[]).map((c) => c.name), ["Main cut"]);
  // the panel goes away: close the bridge, and dispose of the view model (it listens to Carton and runs a timer)
  server.close();
  ui.dispose();
  await carton.close();
});
