// Scenario 3's app: the same engine as app-factory.ts (Carton on carton.db with the Cardboard adapter, the materializer
// watching the bundle), plus what Cardboard's library worker does with a `.cbproj` (§13, §16 H11), as `e2e` requests:
//   {e2e: "saveAs", out, to, history?}        Save As: Cardboard's zip with Carton's shallow export (and, with
//                                             `history`, "Include history": carton.db copied without local tables)
//   {e2e: "bringIn", file, check?, choices?, who?}
//                                             Open Project of a project this library has: "Bring in their changes",
//                                             folded by the person who clicked it; `check` is the dry run
//   {e2e: "head"}                             head's ref, hash and items (the engine's view, not project.json's)
// Everything else goes to app-factory's engine unchanged.
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { LOCAL_TABLES, hashDoc, type Carton, type Choices } from "@carton/core";
import { cardboardFilesHost, cardboardSchema, toHost } from "@carton/cardboard";
import { exportCbproj, readCbproj, bringInTheirChanges, type CbprojTarget, type Materializer } from "@carton/cardboard/node";
import type { HelperFactoryOptions, HolderEngine } from "@carton/local";
import type { SqliteStore } from "@carton/store-sqlite";
import { createHolderEngine as appEngine, person } from "./app-factory.ts";

/**
 * The manifest Cardboard 1.4.0's Save As writes: the bundle's envelope with every media path made relative to the
 * bundle (`media/<file>`), so no absolute path of the sender's machine travels in the file.
 */
function cardboardManifest(bundle: string): Record<string, unknown> {
  const env = JSON.parse(readFileSync(join(bundle, "project.json"), "utf8"));
  const media = (env.media as { mediaId: string; nativePath: string }[]).map((m) => ({ ...m, nativePath: `media/${m.mediaId}${extname(m.nativePath)}`, ownedByBundle: true }));
  return { ...env, media };
}

export async function createHolderEngine(o: HelperFactoryOptions) {
  const base = await appEngine(o);
  const bundle = String(o.config.projectDir);
  const carton = (base.engine as unknown as { carton: Carton }).carton;
  const mz = (base.engine as unknown as { materializer: Materializer }).materializer;
  const store = base.store as SqliteStore;
  const json = (x: unknown) => JSON.parse(JSON.stringify(x ?? null));

  async function s3(req: any, ctx: Parameters<HolderEngine["serve"]>[1]): Promise<unknown> {
    switch (req.e2e) {
      case "saveAs": {
        const shallow = await carton.exportShallow({ to: String(req.to ?? "someone") });
        const head = await carton.head();
        const r = await exportCbproj({
          bundle,
          out: String(req.out),
          manifest: cardboardManifest(bundle),
          shallow,
          head: { doc: head.doc, toProject: cardboardFilesHost.toProject },
          ...(req.history ? { fullHistory: (to: string) => store.exportCopy(to, [...LOCAL_TABLES]) } : {}),
        });
        return json({ names: r.names, shallowHead: shallow.head, headRef: head.ref, headHash: hashDoc(head.doc, cardboardSchema) });
      }
      case "bringIn": {
        const contents = await readCbproj(String(req.file));
        // the person who clicked "Bring in their changes" does the fold, so History and undo name them
        const who = person(req.who);
        const target: CbprojTarget = { importShallow: (p) => carton.importShallow(p), fold: (from, opts) => carton.fold(from, { ...opts, author: who }) };
        const r = await bringInTheirChanges(target, contents, { ...(req.check ? { check: true } : {}), ...(req.choices ? { choices: req.choices as Choices } : {}) });
        if (r.status === "folded" && r.fold.status === "confirmed" && !req.check) mz.onHeadChange("local");
        return json({ ...r, ignored: contents.ignored, files: contents.files });
      }
      case "head": {
        const h = await carton.head();
        return json({ ref: h.ref, hash: hashDoc(h.doc, cardboardSchema), items: toHost(h.doc).timelineItems, cut: carton.cut, cuts: await carton.cuts() });
      }
      default:
        return base.engine.serve(req, ctx);
    }
  }

  const engine: HolderEngine = Object.assign(Object.create(base.engine), { serve: (req: any, ctx: Parameters<HolderEngine["serve"]>[1]) => (req?.e2e ? s3(req, ctx) : base.engine.serve(req, ctx)) });
  return { ...base, engine };
}
