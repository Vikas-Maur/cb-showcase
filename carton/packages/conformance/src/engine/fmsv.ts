// Cardboard 1.4.0's real GUI save projection P = fm∘sv (B10), sliced out of the app's own renderer bundle at run time
// and never copied into this repo (port of core-v5 `fmsv.mjs`, which sliced the pretty-printed copy; this slices the
// pristine minified bundle). The pieces: `ho`/`nx`/`sv` (time rounding and fades), `x2`/`Vb` (caption fields) and the
// item whitelist inside `fm`. One stub: `Cy.safeParse` (a zod fade schema; passthrough). Returns null when the bundle
// isn't there, so B10 skips.
//
// CARTON_CARDBOARD_DIR: an unpacked Cardboard 1.4.0 (the folder holding `app-asar/`, or the app.asar contents itself).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BUNDLE = "dist/renderer/assets/installErrorTelemetry-DxKId8tA.js";
const DEFAULT_DIR = "/home/ubuntu/.t3/projects/cardboard-showcase/_inspect/cardboard-1.4.0";

type Item = Record<string, any>;
export type Projection = ((item: Item) => Item) & { source?: { file: string; bytes: number } };

export function bundlePath(dir = process.env.CARTON_CARDBOARD_DIR || DEFAULT_DIR): string | null {
  for (const f of [join(dir, "app-asar", BUNDLE), join(dir, BUNDLE)]) if (existsSync(f)) return f;
  return null;
}

/** The balanced `open`…`close` block starting at the last character of `start` (the first `start` in `src`). */
function block(src: string, start: string, open = "{", close = "}"): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`fmsv: '${start}' not found`);
  let j = src.indexOf(open, i + start.length - 1),
    depth = 0;
  for (; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) break;
  }
  return src.slice(i, j + 1);
}

export function realProjection(dir?: string): Projection | null {
  const file = bundlePath(dir);
  if (!file) return null;
  const src = readFileSync(file, "utf8");
  const ho = /\bho=t=>Math\.round\(t\*10\)\/10/.exec(src)?.[0];
  if (!ho) throw new Error("fmsv: 'ho' not found");
  const nx = block(src, "nx=t=>{");
  const sv = block(src, "sv=t=>{");
  const x2 = block(src, "x2=[", "[", "]");
  const vb = block(src, "Vb=t=>{");
  const fm = block(src, "function fm(t){");
  const items = block(fm, "timelineItems:t.timelineItems?.map(e=>(", "(", ")");
  const body = items.slice(items.indexOf("e=>(") + "e=>".length);
  const code = `const Cy = { safeParse: (d) => ({ success: true, data: d }) };
const ${x2};
const ${vb};
const ${ho};
const ${nx};
const ${sv};
return (e) => JSON.parse(JSON.stringify(${body}));`;
  const P = new Function(code)() as Projection;
  P.source = { file, bytes: code.length };
  return P;
}
