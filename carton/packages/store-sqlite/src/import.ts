// Bring an existing project under Carton as main@1 (PLAN §16 "Migration", R2-05): the cut starts from an empty
// document, and the project as it is today is one insert-all change, so the first version in History is attributed
// ("Imported project") and every later version diffs against it.
//
// Safe to call on every open and from several processes at once: a project that is already in carton.db is just
// opened, and the import change has a fixed id per project, so two processes importing together record it once
// (Carton.commit is idempotent by id). An import that stopped between creating the cut and committing main@1 is
// finished by the next call.

import { Carton, type Actor, type Doc } from "@carton/core";
import type { Hasher, HostAdapter } from "@carton/core/plugins";
import type { DbLocation } from "./location.ts";
import { openProjectStore, type ProjectStoreOptions } from "./project.ts";
import type { SqliteStore } from "./store.ts";

export const IMPORT_AUTHOR: Actor = { kind: "system", id: "import", name: "Imported project" };

export interface ImportProjectOptions<HostDoc = unknown> extends ProjectStoreOptions {
  adapter: HostAdapter<HostDoc>;
  /** The project's current document in the host's form (Cardboard: the parsed project.json). */
  host: HostDoc;
  /** Who main@1 is credited to. Default IMPORT_AUTHOR. */
  author?: Actor;
  /** The returned handle's default actor. */
  actor?: Actor;
  hasher?: Hasher;
}

export interface ImportedProject {
  carton: Carton;
  store: SqliteStore;
  location: DbLocation;
  /**
   * The project was not in carton.db yet when this call looked, so it ran the import. Processes racing on a new
   * project can each see true; main@1 is recorded once either way (a duplicate id returns the first confirmation,
   * which can't be told apart from one's own). False: the project was already there.
   */
  imported: boolean;
}

/** The import change's id: one per project, so a second import of the same project is the same change. */
export const importChangeId = (projectId: string) => `import-${projectId}.1`;

export async function importProject<HostDoc>(opts: ImportProjectOptions<HostDoc>): Promise<ImportedProject> {
  const { store, location } = await openProjectStore(opts);
  try {
    const author = opts.author ?? IMPORT_AUTHOR;
    const empty: Doc = {};
    for (const c of Object.keys(opts.adapter.schema.collections)) empty[c] = [];
    const carton = await Carton.open({ adapter: opts.adapter as HostAdapter, store, ...(opts.hasher ? { hasher: opts.hasher } : {}), actor: opts.actor ?? author, init: { doc: empty, projectId: opts.projectId } });
    let imported = false;
    if ((await carton.head()).ref.seq === 0) {
      const doc = opts.adapter.fromHost(opts.host, null);
      const r = await carton.commit({ doc, author, id: importChangeId(opts.projectId), name: "Imported" });
      if (r.status !== "confirmed") throw new Error(`importing ${opts.projectId}: ${r.status === "rejected" ? r.reason : r.status}`);
      imported = true;
    }
    return { carton, store, location, imported };
  } catch (e) {
    await store.close();
    throw e;
  }
}
