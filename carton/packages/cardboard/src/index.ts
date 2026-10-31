// HostAdapter for Cardboard 1.4.0 (PLAN §4.2, §4.3, §10): its versioned schema (the time group with its algebra,
// tracks as a sequence, items with parent trackId, keyed arrays, blobRef atomics, the versioned media subset), the
// fm∘sv GUI projection, host <-> engine conversion with LCS move recovery, the hard and soft validators, and the
// Claude Code / CARDBOARD_ACTOR identity source. Port of core-v5 `cardboard-schema.mjs`. Owner: cardboard-adapter.
import type { Schema, Doc, Actor } from "@carton/core";
import type { HostAdapter, IdentitySource, OwnFn } from "@carton/core/plugins";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

/** Bumped when the versioned slice changes; sent in hello. */
export const CARDBOARD_SCHEMA_VERSION = 1;

/** The slice of a Cardboard `project.json` Carton versions (other fields pass through the projection untouched). */
export interface CardboardProject {
  name?: string;
  description?: string;
  aspectRatio?: string;
  tracks?: Record<string, unknown>[];
  timelineItems?: Record<string, unknown>[];
  media?: Record<string, unknown>[];
  [other: string]: unknown;
}

export const cardboardSchema: Schema = undefined as unknown as Schema; // set by the port

export function fromHost(host: CardboardProject, base?: Doc | null, own?: OwnFn): Doc {
  return todo("fromHost");
}
export function toHost(doc: Doc): CardboardProject {
  return todo("toHost");
}
/** P = fm∘sv: what the GUI can represent of an item (§4.3). */
export function project(doc: Doc): Doc {
  return todo("project");
}
/** A GUI save as an engine doc: diff(P(base), save) restricted to P's fields, applied to base. */
export function projectGuiSave(base: Doc, save: CardboardProject): Doc {
  return todo("projectGuiSave");
}

export const cardboardAdapter: HostAdapter<CardboardProject> = {
  name: "cardboard",
  get schema() {
    return cardboardSchema;
  },
  schemaVersion: CARDBOARD_SCHEMA_VERSION,
  fromHost: (h, b, own) => fromHost(h, b, own),
  toHost: (d) => toHost(d),
  project: (d) => project(d),
  projectGuiSave: (b, s) => projectGuiSave(b, s),
};

/** `CARDBOARD_ACTOR=director/<chat>/<turn>[/sub-<type>-<id>]`, Claude Code hook input, or self-declared (L1). */
export function parseActor(value: string, defaults?: Partial<Actor>): Actor | null {
  return todo("parseActor");
}
export const cardboardIdentity: IdentitySource = {
  kind: "cardboard-env",
  current: (env) => todo("cardboardIdentity.current"),
};
