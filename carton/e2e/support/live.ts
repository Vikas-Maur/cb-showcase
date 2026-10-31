// Two machines sharing a cut through a real host (scenarios 4 and 6): each machine's app (engine thread, lease, Carton,
// materializer, sync client) reaches the host through its own TCP link (support/link.ts), so "offline" is a dropped
// connection. Machine A shares its local cut with the app open (R3-03, checked against the server's rows on
// server-node); machine B gets a copy of A's carton.db without local tables (support/clone.ts) and its own lease.
import assert from "node:assert/strict";
import type { test } from "node:test";
import { join } from "node:path";
import { makeMachine, itemNamed, SAMPLE, type Machine } from "./project.ts";
import { Procs, runOnce, type Proc } from "./procs.ts";
import { pkg, scratch, support, until } from "./env.ts";
import { cbOk, cbWrite, setOp } from "./cb.ts";
import { Link } from "./link.ts";
import { startHost, type Host, type HostKind } from "./hosts.ts";

export const gui = (app: Proc, name: string, field: string, value: unknown) => app.ask({ cmd: "serve", req: { e2e: "gui", set: [{ name, field, value }] } });
export const state = async (app: Proc) => (await app.ask({ cmd: "serve", req: { e2e: "state" } })).result;

export interface Side { m: Machine; app: Proc; link: Link }

/** `@carton/local`'s default helper engine factory (what a plain `cb` starts). */
export const LOCAL_FACTORY = pkg("local", "src", "factory.ts");

export async function startApp(procs: Procs, m: Machine, host: Host, account: string, link: Link, extra: Record<string, unknown> = {}): Promise<Proc> {
  const tokenFile = await host.tokenFile(m.home, account, m.projectId);
  procs.watchHelpers(m.dbDir);
  const app = procs.start(`app-${account}`, [support("app.ts"), m.bundle, m.projectId, JSON.stringify({ sync: { url: link.url(m.projectId), tokenFile }, remoteRewriteMs: 200, ...extra })]);
  await app.next((x) => x.ready, 60_000);
  return app;
}

export async function twoMachines(t: test.TestContext, kind: HostKind, appConfig: Record<string, unknown> = {}): Promise<{ host: Host; a: Side; b: Side; procs: Procs; shareRows: unknown }> {
  const procs = new Procs();
  const links: Link[] = [];
  let host: Host | null = null;
  t.after(async () => { await procs.close(); for (const l of links) await l.close(); await host?.stop(); });
  const dir = scratch(`s4-${kind}`);
  host = await startHost(kind, dir, procs);
  const linkA = await Link.open(host.port), linkB = await Link.open(host.port);
  links.push(linkA, linkB);

  // machine A: a local project with history, then shared (R3-03) with the app open
  const ma = makeMachine(`s4-${kind}-a`);
  const appA = await startApp(procs, ma, host, "alice", linkA, appConfig);
  await gui(appA, SAMPLE.title, "fontSize", 110);
  await until(() => itemNamed(ma, SAMPLE.title)?.fontSize === 110, 20_000, "A's first local edit");
  const localIds = (await cbOk(ma, ["history"])).versions.map((v: any) => v.change).filter(Boolean).reverse();
  // the link is down while the hand-off starts, so the upload can't finish before the next commit: the cut stays
  // `handingOff` (§5.3 step 1) and a commit made then is pending, never confirmed locally
  linkA.down();
  const shared = await cbWrite(ma, { kind: "share" });
  assert.equal(shared.status, "confirmed", JSON.stringify(shared));
  assert.equal((await cbOk(ma, ["cut", "list"])).cuts[0].sequencer.kind, "handingOff", "the cut is handing off");
  const during = await cbWrite(ma, { kind: "commit", ops: [setOp("timelineItems", itemNamed(ma, SAMPLE.logo)!.id, "zIndex", 3)] }, { actor: "codex/handoff", waitMs: 1000 });
  assert.equal(during.status, "pending", `a commit during the hand-off is never confirmed locally: ${JSON.stringify(during)}`);
  assert.equal((await cbOk(ma, ["history"])).versions[0].change, localIds.at(-1), "nothing was sequenced locally after n");
  linkA.up();
  await until(async () => (await cbOk(ma, ["cut", "list"])).cuts[0].sequencer.kind === "server", 60_000, "A's cut to become server-sequenced");
  let shareRows: unknown = null;
  const rows = await host.rows(ma.projectId);
  if (rows) {
    let seen: unknown = null;
    const mine = await until(async () => { const r = (await host!.rows(ma.projectId))!; seen = r.map((x) => x.id); return r.length >= localIds.length + 1 && r; }, 30_000, "the server to hold the adopted log and the commit made during it")
      .catch((e) => { throw new Error(`${(e as Error).message}: server rows ${JSON.stringify(seen)}, local ${JSON.stringify(localIds)}, during ${during.id}`); });
    assert.deepEqual(mine.slice(0, localIds.length).map((r) => r.id), localIds, "seqs 1..n adopted verbatim (R3-03)");
    assert.equal(mine[localIds.length]!.id, during.id, "the commit made during the hand-off is the next seq");
    assert.equal(new Set(mine.map((r) => r.id)).size, mine.length, "no change id twice on the server");
    shareRows = mine.length;
  }

  // machine B: the project's files and a copy of A's carton.db without local tables, its own app and lease
  const mb = makeMachine(`s4-${kind}-b`, ma);
  const cl = await runOnce("clone", [support("clone.ts"), join(ma.dbDir, "carton.db"), join(mb.dbDir, "carton.db")]);
  assert.equal(cl.code, 0, cl.stderr);
  const appB = await startApp(procs, mb, host, "bob", linkB, appConfig);
  await until(async () => (await state(appB)).sync?.status === "up-to-date", 60_000, "B connected and caught up");
  await until(() => itemNamed(mb, SAMPLE.logo)?.zIndex === 3, 30_000, "B's files to show A's last edit");
  return { host, a: { m: ma, app: appA, link: linkA }, b: { m: mb, app: appB, link: linkB }, procs, shareRows };
}

