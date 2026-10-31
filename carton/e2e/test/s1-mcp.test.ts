// Scenario 1, the MCP side (§0.1, C7): an agent's MCP client talks to `carton mcp` over stdio (newline-delimited
// JSON-RPC 2.0) on the real project while the app holds the lease: the kept tools (timeline_history, undo_timeline)
// and the new ones (timeline_cuts, timeline_fold, timeline_credits, timeline_publish), each answering as `cb` does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMachine, itemNamed, SAMPLE } from "../support/project.ts";
import { Procs } from "../support/procs.ts";
import { dataDirFor, support, until } from "../support/env.ts";
import { CB_BIN, cbOk } from "../support/cb.ts";
import { named, untilShown } from "../support/head.ts";

test("S1 MCP over stdio: tools listed; cuts, fold --check, credits, history, publish and undo through the tools", { timeout: 180_000 }, async (t) => {
  const procs = new Procs();
  t.after(() => procs.close());
  const m = makeMachine("s1-mcp");
  procs.watchHelpers(m.dbDir);
  const app = procs.start("app", [support("app.ts"), m.bundle, m.projectId, "{}"]);
  await app.next((x) => x.ready);
  await app.ask({ cmd: "serve", req: { e2e: "gui", set: [{ name: SAMPLE.title, field: "fontSize", value: 140 }] } });
  await until(() => itemNamed(m, SAMPLE.title)?.fontSize === 140, 20_000, "the GUI save");

  const mcp = procs.start("mcp", [CB_BIN, "--project", m.bundle, "--data-dir", dataDirFor(m.bundle), "mcp"], { env: { CARDBOARD_ACTOR: "director/chatM/turn1" } });
  let n = 0;
  const call = async (method: string, params: unknown = {}) => {
    const id = ++n;
    const reply = mcp.next((x) => x.id === id, 60_000);
    mcp.p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const r = await reply;
    if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
    return r.result;
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call("tools/call", { name, arguments: args });
    assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
    return r.structuredContent;
  };
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  const names = (await call("tools/list")).tools.map((x: any) => x.name).sort();
  for (const want of ["timeline_history", "check_timeline", "undo_timeline", "timeline_cuts", "timeline_fold", "timeline_credits", "timeline_publish"]) assert.ok(names.includes(want), `${want} listed: ${names.join(", ")}`);

  assert.equal((await tool("timeline_credits", { clip: SAMPLE.title })).by.id, "human:me", "credits through MCP");
  const made = await tool("timeline_cuts", { action: "new", name: "Teaser" });
  assert.equal(made.status, "confirmed", JSON.stringify(made));
  assert.deepEqual((await tool("timeline_cuts")).cuts.map((c: any) => c.name).sort(), ["Main cut", "Teaser"]);
  assert.equal((await tool("timeline_fold", { cut: "Teaser", check: true })).status, "up-to-date");
  const hist = await tool("timeline_history");
  t.diagnostic(JSON.stringify(hist).slice(0, 300));
  const pub = await tool("timeline_publish", { name: "Sent to client" });
  assert.equal(pub.status, "confirmed", JSON.stringify(pub));
  assert.ok((await cbOk(m, ["cut", "list"])).cuts.some((c: any) => c.kind === "published" && c.name === "Sent to client"), "the published cut, as cb sees it");
  // undo_timeline as the person's group: the GUI edit goes (an agent and the person share the machine's undo group, §8)
  const undoAt = Date.now();
  const u = await tool("undo_timeline");
  assert.equal(u.status, "confirmed", JSON.stringify(u));
  await untilShown(t, m, undoAt, (l) => named(l, SAMPLE.title)?.fontSize === 96, "the undo");
  mcp.p.stdin!.end();
});
