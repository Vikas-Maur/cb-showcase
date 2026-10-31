// Bring an existing project under Carton as main@1 (PLAN §16 "Migration", R2-05): the cut starts from an empty
// document, and the project as it is today is one insert-all change, so the first version in History is attributed
// ("Import") and every later version diffs against it. Core does the import (`Carton.open` with `init.asChange`);
// this opens carton.db where §6.4 says it lives, converts the project only when it isn't in carton.db yet, and
// finishes an import that stopped between core's two steps (the empty cut, then main@1).
//
// Safe to call on every open and from several processes at once: main@1 has a fixed id per project, so it is
// recorded once (Carton.commit is idempotent by id).

import { Carton, STORE_TABLES, type Actor, type Doc } from "@carton/core";
import type { Hasher, HostAdapter } from "@carton/core/plugins";
import type { DbLocation } from "./location.ts";
import { openProjectStore, type ProjectStoreOptions } from "./project.ts";
import type { SqliteStore } from "./store.ts";

/** main@1's author and id, as core's `init.asChange` writes them. */
export const IMPORT_AUTHOR: Actor = { kind: "system", id: "import", name: "Import" };
export const importChangeId = (projectId: string) => `import.${projectId}`;

export interface ImportProjectOptions<HostDoc = unknown> extends ProjectStoreOptions {
  adapter: HostAdapter<HostDoc>;
  /** The project's current document in the host's form (Cardboard: the parsed project.json), or a function giving it
   *  (called only when the project still has to be imported). */
  host: HostDoc | (() => HostDoc);
  /** The returned handle's default actor. */
  actor?: Actor;
  hasher?: Hasher;
}

export interface ImportedProject {
  carton: Carton;
  store: SqliteStore;
  location: DbLocation;
  /**
   * The project was not in carton.db yet (or its import was unfinished) when this call looked, so it ran the import.
   * Processes racing on a new project can each see true; main@1 is recorded once either way. False: already there.
   */
  imported: boolean;
}

export async function importProject<HostDoc>(opts: ImportProjectOptions<HostDoc>): Promise<ImportedProject> {
  const { store, location } = await openProjectStore(opts);
  try {
    const doc = (): Doc => opts.adapter.fromHost(typeof opts.host === "function" ? (opts.host as () => HostDoc)() : opts.host, null);
    // Core writes its meta row together with the cut, so an empty meta table means there is no project yet.
    const fresh = (await store.range(STORE_TABLES.meta, { limit: 1 })).length === 0;
    const carton = await Carton.open({
      adapter: opts.adapter as HostAdapter,
      store,
      ...(opts.hasher ? { hasher: opts.hasher } : {}),
      ...(opts.actor ? { actor: opts.actor } : {}),
      ...(fresh ? { init: { doc: doc(), projectId: opts.projectId, asChange: true } } : {}),
    });
    // A cut still at seq 0 with an empty root is an import whose main@1 never landed (its process stopped between
    // the two steps), or one another process is finishing right now: commit it, with core's id, so it lands once.
    let resumed = false;
    const head = await carton.head();
    if (head.ref.seq === 0 && isEmpty(head.doc, Object.keys(opts.adapter.schema.collections))) {
      const r = await carton.commit({ doc: doc(), author: IMPORT_AUTHOR, id: importChangeId(opts.projectId) });
      if (r.status !== "confirmed") throw new Error(`importing ${opts.projectId}: ${r.status === "rejected" ? r.reason : r.status}`);
      resumed = true;
    }
    return { carton, store, location, imported: fresh || resumed };
  } catch (e) {
    await store.close();
    throw e;
  }
}

function isEmpty(doc: Doc, collections: string[]): boolean {
  for (const c of collections) if (Array.isArray(doc[c]) && (doc[c] as unknown[]).length) return false;
  for (const k of Object.keys(doc)) if (!collections.includes(k) && doc[k] !== undefined) return false;
  return true;
}
