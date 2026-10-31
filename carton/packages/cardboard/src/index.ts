// HostAdapter for Cardboard 1.4.0 (PLAN §4.2, §4.3, §10): its versioned schema (the time group with its algebra,
// tracks as a sequence, items with parent trackId, keyed arrays, blobRef atomics, the versioned media subset), the
// fm∘sv GUI projection (injected), host <-> engine conversion with LCS move recovery, the hard and soft validators, the
// timeline.tsx header contract, and the CARDBOARD_ACTOR identity source. Port of core-v5 `cardboard-schema.mjs`.
// The file-system side (materializer, .cbproj) is `@carton/cardboard/node`. Owner: cardboard-adapter.
import { merge3 } from "@carton/core";
import type { Doc } from "@carton/core";
import type { HostAdapter } from "@carton/core/plugins";
import { cardboardSchema, diagnose } from "./schema.ts";
import { fromHost, toHost, projectGuiSave, projectDoc, materializeProject, type CardboardProject, type ItemProjection } from "./host.ts";
import { identityProjection } from "./projection.ts";

/** Bumped when the versioned slice changes; sent in hello. */
export const CARDBOARD_SCHEMA_VERSION = 1;

export interface CardboardAdapterOptions {
  /** The GUI's lossy projection P (1.4.0's `fm∘sv` item function, from its renderer). Default: none (identity). */
  projection?: ItemProjection;
}

/** The Cardboard HostAdapter, with Cardboard's GUI projection injected when the host has one. */
export function createCardboardAdapter(opts: CardboardAdapterOptions = {}): HostAdapter<CardboardProject> {
  const P = opts.projection ?? identityProjection;
  return {
    name: "cardboard",
    schema: cardboardSchema,
    schemaVersion: CARDBOARD_SCHEMA_VERSION,
    fromHost: (h, b, own) => fromHost(h, b, own),
    toHost: (d) => toHost(d),
    project: (d) => projectDoc(d, P),
    projectGuiSave: (b, s) => projectGuiSave(b, s, P),
  };
}

/** The adapter for hosts without a lossy GUI (CLI, web client, tests). The app passes 1.4.0's fm∘sv instead. */
export const cardboardAdapter: HostAdapter<CardboardProject> = createCardboardAdapter();

/** The document conversions the materializer (`@carton/cardboard/node`) needs, for Cardboard. */
export const cardboardFilesHost = {
  fromProject: (project: Record<string, unknown>, base: Doc | null): Doc => fromHost(project, base),
  toProject: (doc: Doc, current: Record<string, unknown> | null): Record<string, unknown> => materializeProject(doc, current),
  merge3: (base: Doc, ours: Doc, theirs: Doc): Doc => merge3(base, ours, theirs, cardboardSchema).doc,
  diagnose,
};

export { cardboardSchema, hard, soft, diagnose, itemOf, ITEMS, TRACKS, MEDIA, TIME_FIELDS, ITEM_TYPES, TRACK_TYPES, ASPECT_RATIOS, LOCAL_ONLY } from "./schema.ts";
export { fromHost, toHost, projectGuiSave, projectDoc, sliceOf, materializeProject, SEQ_FIELDS, ROOT_FIELDS } from "./host.ts";
export type { CardboardProject, ItemProjection } from "./host.ts";
export { identityProjection, standInProjection } from "./projection.ts";
export { inferRipple } from "./ripple.ts";
export { parseActor, subagentActorId, cardboardIdentity } from "./identity.ts";
export * from "./header.ts";
export * from "./codec.ts";
