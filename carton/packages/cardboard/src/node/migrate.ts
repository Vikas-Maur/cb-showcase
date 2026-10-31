// Migration (PLAN §16): an existing Cardboard project is imported as `main@1`, one insert-all change, and history
// starts there. The files on disk are that state, so the materializer adopts them instead of importing them as foreign
// saves; and a `timeline.tsx` that 1.4.0 printed before Carton was installed carries a bare timestamp rev, which is
// mapped to `main@1` so an agent saving from it still has an exact base.
import fs from "node:fs";
import path from "node:path";
import type { Doc } from "@carton/core";
import { fromHost } from "../host.ts";
import { findRev } from "../header.ts";
import { PROJECT_FILE, TIMELINE_FILE, type MaterializerEngine } from "./materializer.ts";

export interface ProjectImport {
  /** The engine doc for `main@1`: the project's versioned slice. */
  doc: Doc;
  /** The project's own id (`project.id`), kept as Carton's project id. */
  projectId: string | null;
  name: string | null;
  /** The 1.4.0 rev printed in the bundle's timeline.tsx, if it matches the project's `stateUpdatedAt`. */
  legacyRev: number | null;
}

/** Reads a bundle's project.json (and its timeline.tsx header) as the document to import as `main@1`. */
export function readProjectForImport(bundle: string): ProjectImport {
  const env = JSON.parse(fs.readFileSync(path.join(bundle, PROJECT_FILE), "utf8")) as { format?: string; project?: Record<string, unknown> };
  if (env.format !== "cardboard-project" || !env.project || typeof env.project !== "object") throw new Error(`${PROJECT_FILE} is not a Cardboard project`);
  const project = env.project;
  let legacyRev: number | null = null;
  try {
    const rev = findRev(fs.readFileSync(path.join(bundle, TIMELINE_FILE), "utf8"))?.rev;
    // Only a print of exactly this state maps to main@1: an older print's base is gone (B2), and stays an error.
    if (rev?.kind === "legacy" && rev.rev === project.stateUpdatedAt) legacyRev = rev.rev;
  } catch {
    // no timeline.tsx yet
  }
  return { doc: fromHost(project, null), projectId: typeof project.id === "string" ? project.id : null, name: typeof project.name === "string" ? project.name : null, legacyRev };
}

/** Records the legacy rev -> `main@1` mapping the engine's `resolve` reads (`["legacy", rev]` in the local views table). */
export async function recordLegacyRev(engine: Pick<MaterializerEngine, "putMeta">, legacyRev: number | null, ref: string): Promise<void> {
  if (legacyRev !== null) await engine.putMeta(["legacy", String(legacyRev)], ref);
}
