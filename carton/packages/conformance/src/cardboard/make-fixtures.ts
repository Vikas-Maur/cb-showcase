#!/usr/bin/env node
// Builds ./fixtures with the real Cardboard 1.4.0 `cb` CLI: our own sample project, made in a scratch library from
// tiny generated media, and agent edits of its timeline.tsx applied by `cb source apply --json`. The fixtures hold only
// what the CLI wrote for our project, never Cardboard's code. fixtures/README.md (hand-written) lists the commands
// below; keep it in step when the steps change.
//
//   node make-fixtures.ts [--cli <cardboard.mjs>] [--out <fixtures dir>] [--scratch <dir>]
//
// --scratch defaults to ~/gfv-scratch/carton/cardboard-adapter/helper-fixtures; this run's library is left in its
// make-fixtures/ folder for inspection and replaced by the next run. Needs ffmpeg and ffprobe ($CARDBOARD_FFMPEG,
// $CARDBOARD_FFPROBE, or on PATH) with libx264, aac and libmp3lame.
//
// The library path is absolute in project.json (`media[].nativePath`); every fixture file has it replaced by
// /FIXTURE and is otherwise byte for byte what the CLI wrote or printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { cardboardCli, editElement, type ApplyResult, type CardboardCli } from "./cli-codec.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLACEHOLDER = "/FIXTURE";

// The sample timeline: every schema area Carton versions, on six tracks (caption, video, adjustment, video for the
// shader, video, audio). Our own content.
const SAMPLE_TSX = String.raw`export default (
  <timeline aspect="16:9">
    <track kind="caption" name="Captions">
      <caption
        name="Fixture captions"
        start={0}
        end={3}
        captionText="Carton fixture"
        captionPosition="bottom"
        captionWordTimings={[{ word: "Carton", start: 0, end: 0.6 }, { word: "fixture", start: 0.6, end: 1.4 }]}
        captionSegments={[
          { id: "seg-1", text: "Carton", startTime: 0, endTime: 0.6, wordTimings: [{ word: "Carton", start: 0, end: 0.6 }] },
          { id: "seg-2", text: "fixture", startTime: 0.6, endTime: 1.4, wordTimings: [{ word: "fixture", start: 0.6, end: 1.4 }] },
        ]}
      />
    </track>
    <track name="Titles">
      <text
        name="Title"
        start={0.5}
        end={2.5}
        textContent="Carton fixture"
        fontSize={96}
        color="#f3eee6"
        textAnimation={{ preset: "fade-up", duration: 0.4 }}
        transitionIn={{ type: "fade", duration: 0.25 }}
        keyframeTracks={[{ property: "opacity", keyframes: [{ time: 0, value: 0 }, { time: 0.3, value: 1 }], easing: "ease-in-out" }]}
      />
      <code
        name="Fixture badge"
        start={2.5}
        end={4}
        codeComposition={{
          width: 320,
          height: 180,
          source: "export default function Badge({ time }) {\n  return <div style={{ opacity: Math.min(1, time) }}>Carton</div>;\n}\n",
        }}
      />
    </track>
    <track kind="adjustment" name="Grade">
      <adjustment
        name="Warm grade"
        start={0}
        end={4}
        colorGrading={{ exposure: 0.2, temperature: 15 }}
        colorGrade={{ wheels: { lift: { r: 0.02, b: -0.02 }, gamma: { y: 0.05 } }, curves: { master: [[0, 0], [0.5, 0.55], [1, 1]] }, saturation: 1.1 }}
      />
    </track>
    <track name="FX">
      <shader
        name="Fixture wash"
        start={1}
        end={2}
        shaderComposition={{
          source: "void main() {\n  fragColor = mix(texture(u_input, v_uv), vec4(1.0), strength);\n}",
          params: { strength: 0.2 },
          controls: { strength: { label: "Strength", min: 0, max: 1, step: 0.01 } },
          fadeIn: 0.2,
        }}
      />
    </track>
    <track name="V1">
      <clip
        name="Clip A"
        src="clip.mp4"
        start={0}
        end={1.5}
        in={0.25}
        out={1.75}
        transform={{ x: 10, y: -5, scale: 1.2, rotation: 3 }}
        crop={{ top: 0, right: 5, bottom: 0, left: 5 }}
        opacity={0.9}
        volume={80}
        effects={[{ id: "fx-blur-1", type: "blur", radius: 4 }]}
        transitionOut={{ type: "crossfade", duration: 0.2 }}
      />
      <clip name="Clip A fast" src="clip.mp4" start={1.5} end={2.5} in={0} out={2} playbackSpeed={2} />
      <image name="Logo" src="logo.png" start={2.5} end={4} transform={{ x: 0, y: 0, scale: 0.5, rotation: 0, flipX: true }} zIndex={2} />
    </track>
    <track kind="audio" name="Music">
      <audio name="Tone" src="tone.mp3" start={0} end={3} volume={60} audioFadeIn={{ duration: 0.5, easing: "ease-in" }} audioFadeOut={{ duration: 1 }} />
    </track>
  </timeline>
);
`;

interface EditCase {
  name: string;
  what: string;
  /** A change made in the app after the agent read timeline.tsx, applied first (stands in for a GUI save). */
  editor?: (tsx: string) => string;
  agent: (tsx: string) => string;
}

// Two cases, not three: every case repeats the sample's text and project.json, and two keep the fixtures well under
// 100 KB. The first touches disjoint items, so each of its four edits reads on its own in apply.json.
const CASES: EditCase[] = [
  {
    name: "trim-move-add-remove",
    what: "trim the Logo's start by 0.25 s, move Tone 0.5 s later, add a text item (no id) after the badge, remove Clip A fast (which touches Clip A, and Clip A has a transitionOut)",
    agent: (t) => {
      t = editElement(t, "Logo", "start={2.5}", "start={2.75}");
      t = editElement(t, "Logo", "in={0}", "in={0.25}");
      t = editElement(t, "Tone", "start={0}", "start={0.5}");
      t = editElement(t, "Tone", "end={3}", "end={3.5}");
      t = editElement(t, "Clip A fast", null, "");
      return editElement(t, "Fixture badge", null, (element) =>
        `${element}\n      <text name="End card" start={4} end={5} textContent="Carton end card" fontSize={64} color="#ffffff" />`,
      );
    },
  },
  {
    name: "nested-concurrent",
    what: "nested fields (a colorGrade wheel, an effect option) and the Title's color, while the app changed the Title's fontSize since the print",
    editor: (t) => editElement(t, "Title", "fontSize={96}", "fontSize={120}"),
    agent: (t) => {
      t = editElement(t, "Warm grade", "gamma: { y: 0.05 }", "gamma: { y: 0.08 }");
      t = editElement(t, "Clip A", "radius: 4", "radius: 6");
      return editElement(t, "Title", 'color="#f3eee6"', 'color="#ffd166"');
    },
  },
];

function ffmpeg(bin: string, args: string[]): void {
  const r = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 60_000, windowsHide: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${r.error?.message ?? r.stderr}`);
}

/** Tiny media, bit-exact so their sizes in project.json repeat on the same ffmpeg version. */
function makeMedia(dir: string): string[] {
  const bin = process.env.CARDBOARD_FFMPEG ?? "ffmpeg";
  fs.mkdirSync(dir, { recursive: true });
  const exact = ["-fflags", "+bitexact", "-map_metadata", "-1"];
  const clip = path.join(dir, "clip.mp4");
  const tone = path.join(dir, "tone.mp3");
  const logo = path.join(dir, "logo.png");
  ffmpeg(bin, ["-f", "lavfi", "-i", "testsrc=size=64x64:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-flags:v", "+bitexact", "-flags:a", "+bitexact", ...exact, clip]);
  ffmpeg(bin, ["-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-c:a", "libmp3lame", "-b:a", "32k", "-flags:a", "+bitexact", ...exact, tone]);
  ffmpeg(bin, ["-f", "lavfi", "-i", "color=c=0x3366cc:size=64x64", "-frames:v", "1", "-flags:v", "+bitexact", ...exact, logo]);
  return [clip, tone, logo];
}

/** Library roots as they appear in a file (raw, and JSON-escaped for Windows paths) → /FIXTURE. */
function scrub(text: string, ...roots: string[]): string {
  for (const root of roots) text = text.split(JSON.stringify(root).slice(1, -1)).join(PLACEHOLDER).split(root).join(PLACEHOLDER);
  return text;
}

async function cb(cli: CardboardCli, args: string[], opts: { root?: string; input?: string; timeoutMs?: number } = {}): Promise<string> {
  const r = await cli.run(args, opts);
  if (r.code !== 0) throw new Error(`cb ${args.join(" ")}: exit ${r.code}\n${r.stderr}${r.stdout}`);
  return r.stdout;
}

function mustApply(what: string, r: ApplyResult): void {
  const summary = r.summary as { errors?: number } | undefined;
  if (!r.applied || (summary?.errors ?? 0) > 0) throw new Error(`${what}: not applied: ${JSON.stringify(r.diagnostics)}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cli: { type: "string" },
      out: { type: "string", default: path.join(HERE, "fixtures") },
      scratch: { type: "string", default: path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "helper-fixtures") },
    },
  });
  const out = path.resolve(values.out);
  const work = path.join(path.resolve(values.scratch), "make-fixtures");
  fs.rmSync(work, { recursive: true, force: true });
  const cli = cardboardCli({ cli: values.cli, root: work });
  if (!cli) throw new Error(`no Cardboard CLI at ${values.cli ?? "the default path"} (set --cli or $CARTON_CARDBOARD_CLI)`);
  const version = (await cb(cli, ["--version"])).trim();
  if (version !== "1.4.0") throw new Error(`these fixtures pin Cardboard 1.4.0; the CLI is ${version}`);

  const media = makeMedia(path.join(work, "src"));
  const lib = cli.library;
  await cb(cli, ["project", "create", "Sample"]);
  await cb(cli, ["media", "add", "Sample", ...media, "--json"], { timeoutMs: 180_000 });
  const sampleBundle = path.join(lib, "Sample.cardboard");
  mustApply("sample", await cli.apply(sampleBundle, SAMPLE_TSX));

  const files = new Map<string, string>();
  const sampleProject = scrub(fs.readFileSync(path.join(sampleBundle, "project.json"), "utf8"), lib);
  const sampleTsx = fs.readFileSync(path.join(sampleBundle, "timeline.tsx"), "utf8");
  if (sampleTsx !== (await cli.print(sampleBundle))) throw new Error("timeline.tsx differs from a fresh `cb source print`");
  files.set("sample/project.json", sampleProject);
  files.set("sample/timeline.tsx", scrub(sampleTsx, lib));

  for (const c of CASES) {
    const root = path.join(work, "cases", c.name);
    const bundle = path.join(root, "Sample.cardboard");
    fs.cpSync(sampleBundle, bundle, { recursive: true });
    if (c.editor) {
      mustApply(`${c.name} (editor)`, await cli.apply(bundle, c.editor(sampleTsx)));
      // The agent's merge base: the snapshot of the rev its file was printed at.
      const rev = /^\/\/ cardboard:rev (\d+)$/m.exec(sampleTsx)?.[1];
      files.set(`edit-${c.name}/base.rev.json`, fs.readFileSync(path.join(bundle, ".revs", `${rev}.json`), "utf8"));
    }
    // A copied project.json still names the sample library until the CLI rewrites it.
    const before = scrub(fs.readFileSync(path.join(bundle, "project.json"), "utf8"), root, lib);
    const after = c.agent(sampleTsx);
    const r = await cli.run(["source", "apply", bundle, "-", "--json"], { root, input: after });
    mustApply(c.name, JSON.parse(r.stdout) as ApplyResult);
    console.log(`edit-${c.name}: ${c.what}`);
    files.set(`edit-${c.name}/before.tsx`, scrub(sampleTsx, lib));
    files.set(`edit-${c.name}/after.tsx`, scrub(after, lib));
    files.set(`edit-${c.name}/project.before.json`, before);
    files.set(`edit-${c.name}/project.after.json`, scrub(fs.readFileSync(path.join(bundle, "project.json"), "utf8"), root));
    files.set(`edit-${c.name}/apply.json`, scrub(r.stdout, root));
  }

  for (const entry of fs.existsSync(out) ? fs.readdirSync(out) : []) {
    if (entry === "sample" || entry.startsWith("edit-")) fs.rmSync(path.join(out, entry), { recursive: true });
  }
  let total = 0;
  for (const [name, text] of files) {
    const file = path.join(out, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    total += Buffer.byteLength(text);
    console.log(`${String(Buffer.byteLength(text)).padStart(7)}  ${name}`);
  }
  console.log(`${String(total).padStart(7)}  total in ${out}\nlibrary kept in ${lib}`);
}

await main();
