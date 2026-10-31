// The engine Cardboard's library worker runs (§3, §6.2, §6.4), as a factory for `@carton/local`'s engine thread and
// headless helper: carton.db through store-sqlite, Carton with the real Cardboard adapter, the cardboard materializer
// watching the bundle (project.json, the shared timeline.tsx, per-agent views and their `.status` sidecars), and, when
// `sync` is configured, the sync client to a real sequencer host (server-node or the Worker under wrangler dev).
//   config: { projectDir, projectId, codec?: "json" | "cli", sync?: { url, tokenFile }, remoteRewriteMs?, freezeIdleMs?,
//             wireSidecars?: false, join?: JoinInit (an invite: open the shared cut from nothing, support/invite.ts) }
// On a first open the project is imported as `main@1` (§16 migration) and the files on disk are adopted as that state.
// Requests with an `e2e` field are the test's hands on the app (a GUI save, a status read); everything else is a `cb`
// write, served exactly as the app serves one.
import { readFileSync, writeFileSync } from "node:fs";
import { renameRetry } from "./env.ts";
import { join } from "node:path";
import { Carton, hashDoc } from "@carton/core";
import type { Actor, HostAdapter } from "@carton/core";
import { openSqliteStore } from "@carton/store-sqlite";
import { cardboardAdapter, cardboardFilesHost, jsonTimelineCodec, type TimelineCodec } from "@carton/cardboard";
import { Materializer, readProjectForImport } from "@carton/cardboard/node";
import { CartonHolderEngine, CartonMaterializerEngine, nodeHasher, localGroup } from "@carton/local";
import type { HelperFactoryOptions, HolderEngine } from "@carton/local";
import { webSocketTransport } from "@carton/server-node";

/** The person at this machine's window (GUI saves are theirs). */
export const person = (name = "me"): Actor => ({ kind: "human", id: `human:${name}`, name, group: localGroup() });

async function codecFor(kind: unknown): Promise<TimelineCodec> {
  if (kind !== "cli") return jsonTimelineCodec;
  // Cardboard 1.4.0's own printer and parser, run as its CLI (conformance's test codec): only where the CLI is present
  const { cardboardCli } = await import("../../packages/conformance/src/cardboard/cli-codec.ts");
  const { cliTimelineCodec } = await import("../../packages/conformance/src/cardboard/cli-timeline-codec.ts");
  const cli = cardboardCli();
  if (!cli) throw new Error("codec cli: Cardboard 1.4.0's CLI isn't on this machine");
  return cliTimelineCodec(cli);
}

export async function createHolderEngine({ dbPath, config }: HelperFactoryOptions) {
  const projectDir = String(config.projectDir);
  const store = await openSqliteStore(dbPath);
  // a first open is one that creates the project (§16 migration): only then are the files on disk that import's state
  const fresh = (await store.get("meta", ["project"])) === undefined;
  const imp = readProjectForImport(projectDir);
  const syncCfg = config.sync as { url: string; tokenFile: string } | undefined;
  const carton = await Carton.open({
    adapter: cardboardAdapter as HostAdapter,
    store,
    hasher: nodeHasher,
    actor: { kind: "system", id: "engine", name: "Engine" },
    // a machine that accepted an invite joins the shared cut from nothing; otherwise the project on disk is main@1
    init: config.join ? { join: config.join as never } : { doc: imp.doc, projectId: String(config.projectId ?? imp.projectId), asChange: true },
    ...(syncCfg ? { sync: { transport: webSocketTransport({ keepaliveMs: 0 }), url: syncCfg.url, token: async () => readFileSync(syncCfg.tokenFile, "utf8").trim(), autoConnect: false } } : {}),
  });
  const mz = new Materializer({
    bundle: projectDir,
    engine: new CartonMaterializerEngine(carton),
    host: cardboardFilesHost,
    codec: await codecFor(config.codec),
    ...(config.remoteRewriteMs !== undefined ? { remoteRewriteMs: Number(config.remoteRewriteMs) } : {}),
    ...(config.freezeIdleMs !== undefined ? { freezeIdleMs: Number(config.freezeIdleMs) } : {}),
  });
  if (fresh) await mz.adoptCurrentFiles();
  await mz.start();
  mz.watch();
  // remote rows move head: the shared file and project.json follow (the app wires the same event)
  carton.on((e) => { if (e.type === "change" && !e.local) mz.onHeadChange("remote"); });
  // A view save on a shared cut is `pending` in its sidecar until the server answers; the app forwards that answer
  // (confirmed, late conflicts, refused) to the view's sidecar (R5-04). `@carton/local`'s CartonHolderEngine doesn't
  // (B10): `wireSidecars: false` runs without it, to pin that.
  if (config.wireSidecars !== false) {
    // The server's answer can arrive before the materializer has recorded the save's change id on its view (the ack
    // races the save's own bookkeeping). A file save writes its change id into its attempt slot (`["attempt", rel]`)
    // before committing, so: after the materializer's current work, an id that a view claims is settled now; one still
    // in an attempt slot is looked up again until its view claims it; any other (a cb commit, a GUI save) is no view's.
    const settleView = async (id: string, s: Parameters<Materializer["onChangeUpdate"]>[2]) => {
      for (const end = Date.now() + 30_000; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
        await mz.idle();
        const rows = (await store.range<{ lastChange?: string | null }>("views", { prefix: ["view"] })).filter((r) => r.value?.lastChange === id);
        for (const r of rows) await mz.onChangeUpdate(String(r.key[1]), id, s);
        if (rows.length) return;
        const attempts = await store.range<{ id?: string }>("views", { prefix: ["attempt"] });
        if (!attempts.some((r) => r.value?.id === id)) return;
      }
    };
    carton.on((e) => {
      if (e.type === "change" && e.local && e.change.id) void settleView(e.change.id, { status: "confirmed", seq: e.seq });
      else if (e.type === "absorbed") void settleView(e.id, e.cards.length ? { status: "conflicts", conflicts: e.cards } : { status: "confirmed" });
      else if (e.type === "notice" && e.notice.change && e.notice.kind === "late-conflict") void settleView(e.notice.change, { status: "conflicts", conflicts: e.notice.cards ?? [] });
      else if (e.type === "notice" && e.notice.change && e.notice.kind === "rejected") void settleView(e.notice.change, { status: "rejected", reason: e.notice.text });
    });
  }
  const inner = new CartonHolderEngine(carton, { materializer: mz });
  const engine: HolderEngine = Object.assign(Object.create(inner), {
    serve: async (req: any) => (req?.e2e ? e2e(req) : inner.serve(req)),
  });

  async function e2e(req: any): Promise<unknown> {
    switch (req.e2e) {
      case "gui": {
        // The person edits in the editor; Cardboard saves project.json (temp file, then rename) and Carton's
        // materializer applies the save, credited to the person (the app announces its own GUI saves).
        const file = join(projectDir, "project.json");
        const env = JSON.parse(readFileSync(file, "utf8"));
        for (const s of (req.set ?? []) as { name: string; field: string; value: unknown }[]) {
          const it = env.project.timelineItems.find((i: any) => i.name === s.name);
          if (!it) throw new Error(`no item ${s.name}`);
          it[s.field] = s.value;
        }
        // a new item, made like an existing one (the editor's duplicate / add)
        for (const n of (req.insert ?? []) as { like: string; id: string; name: string; set: Record<string, unknown> }[]) {
          const like = env.project.timelineItems.find((i: any) => i.name === n.like);
          if (!like) throw new Error(`no item ${n.like}`);
          env.project.timelineItems.push({ ...structuredClone(like), id: n.id, name: n.name, ...n.set });
        }
        env.project.stateUpdatedAt = Date.now();
        await mz.hookWrite(person(req.who), "project.json");
        const tmp = join(projectDir, `.project.json.${Date.now()}.tmp`);
        writeFileSync(tmp, JSON.stringify(env, null, 2));
        renameRetry(tmp, file);
        return { ok: true };
      }
      case "idle":
        await mz.idle();
        return { ok: true, log: { applied: mz.log.applied.length, errors: mz.log.errors, kept: mz.log.kept.length } };
      case "stall": {
        // the engine thread stops answering anything, pings included, for `ms` (a busy or preempted thread); `marker`
        // is written once it is stalled, so a test injects its fault while the stall is certain to be on
        if (req.marker) writeFileSync(String(req.marker), String(Date.now()));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(req.ms));
        return { ok: true };
      }
      case "state": {
        // docHash: the head document's own hash (a shared cut's head ref carries none), for convergence checks
        const h = await carton.head();
        return { sync: carton.sync ? carton.sync.state() : null, cuts: await carton.cuts(), head: h.ref, docHash: hashDoc(h.doc, carton.schema) };
      }
      default:
        throw new Error(`unknown e2e request ${req.e2e}`);
    }
  }

  return {
    store,
    engine,
    close: async () => {
      await mz.close();
      await carton.close();
    },
  };
}
