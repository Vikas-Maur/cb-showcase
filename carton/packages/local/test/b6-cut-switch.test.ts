// e2e-qa's B6 (s2-cuts "S2 cut switch") at the package level, on the app as Carton runs it: the engine thread holds the
// lease and runs cardboard's materializer on the bundle, whose `onCutSwitch` (cardboard-adapter `fd9541a`) the holder
// calls after the switch.
//   - B6a: after `cb cut switch`, served by the app while a `cb` call has frozen the shared timeline.tsx, timeline.tsx
//     and project.json show the new cut at once. Before, the switch only said "head moved", and a frozen shared file
//     stays as it is.
//   - B6b: an agent's view save on the cut it switched to gets its status sidecar and lands on that cut.
//   - A switch another process makes (B11's follower adopts it) moves a frozen timeline.tsx too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Rec } from "@carton/core";
import { openLocal } from "../src/open.ts";
import { EngineThread } from "../src/engine-thread.ts";
import { adapter, bundle, doc0 } from "./support/real.ts";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const set = (id: string, f: string, v: unknown) => ({ op: "set" as const, path: ["timelineItems", id, f], value: v });
const me = { kind: "human" as const, id: "human:me" };
const agent = { kind: "agent" as const, id: "director/b6/turn1", name: "Director" };

async function until(f: () => boolean, ms: number, what: string, now: () => unknown) {
  for (const end = Date.now() + ms; !f(); await sleep(25)) if (Date.now() > end) throw new Error(`timed out waiting for ${what}; now: ${JSON.stringify(now())}`);
}
/** The shared timeline.tsx as it is now: its rev line (from the cut's name on) and its items (null mid-rename). */
function shared(dir: string): { rev: string; items: Rec[] } | null {
  try {
    const text = readFileSync(join(dir, "timeline.tsx"), "utf8");
    const rev = /cardboard:rev (.*)$/m.exec(text)?.[1] ?? "";
    return { rev, items: JSON.parse(text.slice(text.indexOf("\n{") + 1)).timelineItems as Rec[] };
  } catch { return null; }
}
function project(dir: string): Rec[] | null {
  try { return JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).project?.timelineItems ?? null; } catch { return null; }
}
const named = (items: Rec[] | null | undefined, id: string) => items?.find((i) => i.id === id)?.name;

const live = new Set<ReturnType<typeof spawn>>();
process.on("exit", () => { for (const p of live) if (p.exitCode === null) p.kill("SIGKILL"); });
/** A process speaking JSON lines (view-agent.ts). */
function proc(script: string, args: string[], env: Record<string, string> = {}) {
  const p = spawn(process.execPath, [here(script), ...args], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, CARDBOARD_ACTOR: "", CLAUDECODE: "", ...env } });
  live.add(p);
  p.on("exit", () => live.delete(p));
  const lines: any[] = [];
  const waiting: ((x: any) => void)[] = [];
  createInterface({ input: p.stdout! }).on("line", (l) => { const x = JSON.parse(l); const w = waiting.shift(); if (w) w(x); else lines.push(x); });
  const next = () => new Promise<any>((r) => (lines.length ? r(lines.shift()) : waiting.push(r)));
  return { p, next, send: (x: object) => p.stdin!.write(JSON.stringify(x) + "\n"), kill: () => { if (p.exitCode === null) p.kill("SIGKILL"); } };
}

/**
 * The app on a fresh bundle, another process's handle, and a cut "Alt" (made by that process) whose c2 differs from
 * main's. A `cb` call through the app has frozen the shared timeline.tsx (windowless agents are active for a minute).
 */
async function world(t: { after(f: () => Promise<void>): void }, name: string) {
  const { dir, projectId } = bundle(name);
  const init = await openLocal({ projectDir: dir, projectId, adapter, init: { doc: doc0() }, actor: me });
  const dbPath = init.dbPath;
  await init.close();
  const th = await EngineThread.start({ dbPath, factory: here("./support/real-mz-factory.ts"), config: { projectDir: dir } });
  const other = await openLocal({ projectDir: dir, projectId, adapter, actor: agent });
  t.after(async () => { await other.close(); await th.stop(); });
  await until(() => named(shared(dir)?.items, "c1") === "c1" && named(project(dir), "c1") === "c1", 10_000, "the app's first print", () => shared(dir));
  const main = shared(dir)!.rev;
  // a cb call: the app freezes the shared file
  const r = await th.call("serve", { id: `${name}.cb`, actor: agent, op: { kind: "commit", ops: [set("c1", "name", "by a cb call on main")] } });
  assert.equal(r.status, "confirmed", JSON.stringify(r));
  // a cut id as Carton makes them (a `cb cut new` id is a hex request id): the rev line keeps 8 of its characters
  const alt = await other.carton.fork("Alt");
  await other.carton.commit({ author: agent, cut: alt.id, ops: [set("c2", "name", "on the Alt cut")] });
  // the app has looked at that write (a cut it isn't on: nothing to show) before the test switches: what moves the
  // files afterwards is the switch alone
  await th.call("nudge", {});
  return { dir, projectId, th, other, alt, main };
}

test("B6a: after `cb cut switch` (the shared file frozen by a cb call), timeline.tsx and project.json show the new cut", { timeout: 60_000 }, async (t) => {
  const { dir, th, alt, main } = await world(t, "b6a");
  assert.match(main, /^Main/, "the shared file showed main");
  const sw = await th.call("serve", { id: "b6a.switch", actor: agent, op: { kind: "switch", cut: alt.id } });
  assert.equal(sw.status, "confirmed", JSON.stringify(sw));
  await until(() => shared(dir)?.rev.startsWith("Alt@") === true && named(shared(dir)?.items, "c2") === "on the Alt cut", 5_000, "timeline.tsx to show the Alt cut", () => shared(dir));
  await until(() => named(project(dir), "c2") === "on the Alt cut", 5_000, "project.json to show the Alt cut", () => project(dir)?.slice(0, 3));
  // the file is Alt's head, not the frozen view of main: Alt was forked after the cb edit, so it has that too
  assert.equal(named(shared(dir)!.items, "c1"), "by a cb call on main");
});

test("B6b: an agent's view save on the cut it switched to gets its status sidecar and lands on that cut", { timeout: 90_000 }, async (t) => {
  const { dir, projectId, th, other, alt } = await world(t, "b6b");
  const sw = await th.call("serve", { id: "b6b.switch", actor: agent, op: { kind: "switch", cut: alt.id } });
  assert.equal(sw.status, "confirmed", JSON.stringify(sw));
  const view = proc("./support/view-agent.ts", [dir, projectId], { CARDBOARD_ACTOR: "director/b6/turn2" });
  t.after(async () => view.kill());
  const { printed } = await view.next();
  assert.ok(printed, "the view was printed");
  view.send({ set: [["c3", "name", "saved in the view on Alt"]] });
  const { status } = await view.next();
  assert.equal(status?.status, "confirmed", JSON.stringify(status));
  assert.match(status.ref, /^Alt@/, "the sidecar names the Alt cut");
  view.send({ exit: true });
  const onAlt = (await other.carton.head(alt.id)).doc.timelineItems as Rec[];
  assert.equal(named(onAlt, "c3"), "saved in the view on Alt", "the save landed on the cut switched to");
  const main = (await other.carton.cuts()).find((c) => c.kind === "main")!.id;
  assert.equal(named((await other.carton.head(main)).doc.timelineItems as Rec[], "c3"), "c3", "and not on main");
});

test("B6/B11: a cut switch another process makes moves a frozen timeline.tsx to the new cut", { timeout: 60_000 }, async (t) => {
  const { dir, other, alt } = await world(t, "b6-other");
  await other.carton.switchTo(alt.id);
  await until(() => shared(dir)?.rev.startsWith("Alt@") === true && named(shared(dir)?.items, "c2") === "on the Alt cut", 5_000, "timeline.tsx to show the Alt cut", () => shared(dir));
  await until(() => named(project(dir), "c2") === "on the Alt cut", 5_000, "project.json to show the Alt cut", () => project(dir)?.slice(0, 3));
});
