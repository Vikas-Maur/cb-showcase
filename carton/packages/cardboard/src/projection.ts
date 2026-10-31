// Host projections (PLAN §4.3, B10). Cardboard's GUI saves through a lossy serializer: the item whitelist inside `fm`
// and `sv`'s rounding of times to 0.1 s (1.4.0 renderer, `installErrorTelemetry`: `ho`/`nx`/`sv` and `fm`). A GUI save
// is therefore diffed through P = fm∘sv: a value equal to P(base value) is not a change, so an agent's frame-accurate
// times and the fields the GUI can't represent survive a human's unrelated edit.
//
// P is Cardboard's code, so it is injected: the Windows patch passes 1.4.0's own `fm∘sv` item function. Hosts without
// a lossy GUI (our web client, the CLI) use `identityProjection`. `standInProjection` imitates the lossy GUI for
// simulations when the real one isn't available, as the prototype did.
import type { Rec } from "@carton/core";
import type { ItemProjection } from "./host.ts";

export const identityProjection: ItemProjection = (item) => item;

const GUI_FIELDS = new Set(["id", "trackId", "type", "name", "startTime", "endTime", "trimStart", "trimEnd", "opacity", "textContent", "volume"]);
const ROUNDED = new Set(["startTime", "endTime", "trimStart", "trimEnd"]);
const ho = (t: number): number => Math.round(t * 10) / 10;

/** The prototype's stand-in for fm∘sv: a field whitelist plus 0.1 s rounding of times. For tests and simulations only. */
export const standInProjection: ItemProjection = (it: Rec) => {
  const p: Rec = {};
  for (const k of Object.keys(it)) if (GUI_FIELDS.has(k)) p[k] = ROUNDED.has(k) && typeof it[k] === "number" ? ho(it[k] as number) : it[k];
  return p;
};
