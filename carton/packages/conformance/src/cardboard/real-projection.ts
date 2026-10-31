// Cardboard 1.4.0's real GUI save projection P = fm∘sv, sliced out of the renderer bundle at run time, for the B10
// conformance test (§4.3: "real fm/sv code"). Port of the verified core-v5 `fmsv.mjs`. Nothing of Cardboard's is
// stored here: only the anchor strings that find the functions in a local copy of the (prettified) renderer:
// `ho`/`nx`/`sv` and the item whitelist inside `fm`, plus `x2`/`Vb`. One stub: `Cy.safeParse` (a zod fade schema;
// passthrough). Returns null when the bundle isn't on this machine, so tests can skip.
import { readFileSync, existsSync } from "node:fs";
import type { Rec } from "@carton/core";

const DEFAULT = "/home/ubuntu/.t3/projects/cardboard-showcase/_inspect/pretty/renderer/installErrorTelemetry-DxKId8tA.js";

function block(src: string, start: string, open = "{", close = "}"): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`fm∘sv: '${start}' not found`);
  let j = src.indexOf(open, i + start.length - 1);
  let depth = 0;
  for (; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) break;
  }
  return src.slice(i, j + 1);
}

export interface RealProjection {
  (item: Rec): Rec;
  source: { file: string; bytes: number };
}

export function realProjection(file = process.env.CARTON_CARDBOARD_RENDERER ?? DEFAULT): RealProjection | null {
  if (!existsSync(file)) return null;
  const src = readFileSync(file, "utf8");
  const ho = /\bho = \(t\) => Math\.round\(t \* 10\) \/ 10/.exec(src)?.[0];
  if (!ho) return null;
  const nx = block(src, "  nx = (t) => {");
  const sv = block(src, "  sv = (t) => {");
  const x2 = block(src, "  x2 = [", "[", "]");
  const vb = block(src, "  Vb = (t) => {");
  const fm = block(src, "function fm(t) {");
  const items = block(fm, "timelineItems: t.timelineItems?.map((e) => (", "(", ")");
  const body = items.slice(items.indexOf("((e) => (") + "((e) => ".length);
  const code = `const Cy = { safeParse: (d) => ({ success: true, data: d }) };
const ${x2.trim()};
const ${vb.trim()};
const ${ho};
const ${nx.trim()};
const ${sv.trim()};
return (e) => JSON.parse(JSON.stringify(${body}));`;
  const P = new Function(code)() as RealProjection;
  P.source = { file, bytes: code.length };
  return P;
}
