// The `timeline.tsx` printer and parser are Cardboard's own code (1.4.0: the printer `Ia` over `Cr = un(Ke(p), p)`,
// and the literal-only Babel parse `rt` plus `Ta`), so the adapter takes them injected (PLAN §16 H3). The Windows patch
// passes 1.4.0's functions. `jsonTimelineCodec` is ours: the same header contract over a JSON body, for tests and for
// hosts without a printer of their own.
import { findRev, REV_TAG } from "./header.ts";

/** The `project` object of a Cardboard `project.json` envelope. */
export type Project = Record<string, unknown>;

export interface TimelineCodec {
  /**
   * Prints the timeline file for `project`, with `rev` written verbatim after `// cardboard:rev ` (1.4.0 prints
   * `// ${"cardboard:rev"} ${rev}`). Must be deterministic for the same input.
   */
  print(project: Project, rev: string): string | Promise<string>;
  /**
   * Parses a saved timeline file into `project` with the file's timeline applied: tracks, timelineItems, aspectRatio,
   * and anything the file carries for media (1.4.0 moves code sources from `codeComposition.source` into
   * `media[].data.code.source`). Throws when the text doesn't parse; a half-written file must throw, never yield a
   * partial timeline. Must not mutate `project` (the materializer caches it).
   */
  parse(text: string, project: Project): Project | Promise<Project>;
}

const TIMELINE_KEYS = ["name", "description", "aspectRatio", "tracks", "timelineItems", "media"] as const;

/** Carton's JSON timeline: a comment header (with the rev line) and the timeline slice as JSON. */
export const jsonTimelineCodec: TimelineCodec = {
  print(project, rev) {
    const slice: Record<string, unknown> = {};
    for (const k of TIMELINE_KEYS) if (project[k] !== undefined) slice[k] = project[k];
    return `// Carton timeline (JSON). A saved edit applies to the project.\n// ${REV_TAG} ${rev}\n${JSON.stringify(slice, null, 1)}\n`;
  },
  parse(text, project) {
    const f = findRev(text);
    const body = f ? text.slice(f.end) : text;
    const start = body.indexOf("{");
    if (start < 0) throw new SyntaxError("no timeline in the file");
    const slice = JSON.parse(body.slice(start)) as Record<string, unknown>;
    if (!slice || typeof slice !== "object" || Array.isArray(slice)) throw new SyntaxError("the timeline is not an object");
    return { ...project, ...slice };
  },
};
