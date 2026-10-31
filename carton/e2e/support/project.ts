// A real Cardboard project on disk: the sample bundle Cardboard 1.4.0's own CLI wrote (cardboard-adapter's fixtures:
// project.json with the `{format, version, project, media}` envelope, its timeline.tsx), in a scratch library of its
// own. Never the user's library or profile.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, cpSync } from "node:fs";
import { join } from "node:path";
import { pkg, scratch } from "./env.ts";

const FIXTURES = pkg("conformance", "src", "cardboard", "fixtures", "sample");

export interface Machine {
  /** The machine's scratch folder (its "home"). */
  home: string;
  /** The library root (`--root` for Cardboard). */
  lib: string;
  /** The project bundle, `<lib>/Sample.cardboard`. */
  bundle: string;
  projectId: string;
  /** carton.db's folder (`<bundle>/.carton`). */
  dbDir: string;
}

export type Item = Record<string, any> & { id: string; name?: string; trackId: string; startTime: number; endTime: number };
export type Envelope = { format: string; version: number; project: Record<string, any> & { id: string; timelineItems: Item[]; tracks: any[] }; media: unknown[] };

export function makeMachine(name: string, from?: Machine): Machine {
  const home = scratch(name);
  const lib = join(home, "lib");
  const bundle = join(lib, "Sample.cardboard");
  mkdirSync(bundle, { recursive: true });
  if (from) {
    // the same project on a second machine: its files, never its .carton (a replica gets carton.db another way)
    cpSync(from.bundle, bundle, { recursive: true, filter: (src) => !/[\\/]\.carton([\\/]|$)/.test(src) && !/[\\/]\.scratch([\\/]|$)/.test(src) });
  } else {
    const env = readFileSync(join(FIXTURES, "project.json"), "utf8").replaceAll("/FIXTURE", lib.replace(/\\/g, "/"));
    writeFileSync(join(bundle, "project.json"), env);
    copyFileSync(join(FIXTURES, "timeline.tsx"), join(bundle, "timeline.tsx"));
  }
  const projectId = (JSON.parse(readFileSync(join(bundle, "project.json"), "utf8")) as Envelope).project.id;
  return { home, lib, bundle, projectId, dbDir: join(bundle, ".carton") };
}

export const readEnvelope = (m: Machine): Envelope => JSON.parse(readFileSync(join(m.bundle, "project.json"), "utf8"));
export const items = (m: Machine): Item[] => readEnvelope(m).project.timelineItems;
export const itemNamed = (m: Machine, name: string): Item | undefined => items(m).find((i) => i.name === name);

/** Writes project.json as Cardboard's library worker does: a temp file in the bundle, then a rename over the old one. */
export function writeEnvelopeAtomic(m: Machine, env: Envelope): void {
  const tmp = join(m.bundle, `.project.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(env, null, 2));
  renameSync(tmp, join(m.bundle, "project.json"));
}

/** The sample's clip names (CLI-made fixture): what the scenarios edit. */
export const SAMPLE = { title: "Title", clipA: "Clip A", clipFast: "Clip A fast", logo: "Logo", tone: "Tone", grade: "Warm grade", badge: "Fixture badge" } as const;
