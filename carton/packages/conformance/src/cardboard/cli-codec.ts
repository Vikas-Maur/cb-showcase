// The real Cardboard 1.4.0 `cb` CLI as Carton's timeline.tsx printer and parser, for tests (Node only).
//
// In production the adapter gets Cardboard's printer and parser injected from the app's own bundle. Tests run the CLI
// that ships inside the app instead, one subprocess per call, against bundles in a scratch folder that each instance
// owns: `cardboardCli()` returns null when the CLI file is absent, so tests can skip. We run Cardboard's code, never
// copy it.
//
//   print(project)       writes the envelope into a scratch bundle and returns what `cb source print` prints for it
//   parse(tsx, context)  applies the text onto a scratch bundle with an empty timeline (and the context's media, so
//                        `src` names resolve) and reads back what Cardboard stored
//   apply(bundle, tsx)   `cb source apply <bundle> - --json`
//   run(args)            any `cb` command, always with `--root` (never the user's library) and a sandboxed home
//
// Facts the code below relies on, observed with 1.4.0 (see fixtures/README.md):
//   - `--root` must be the folder that holds the bundle: a bundle path outside it is "No project bundle at …".
//   - The CLI reads the whole library, and refuses a bundle when another bundle there has the same project or media id
//     ("another project in the library has the same project or media ID"). So each scratch bundle gets a library of
//     its own: copies of one project can't share one.
//   - `source print` reads only project.json and writes nothing; media files need not exist.
//   - With no `.revs` in the bundle, apply diffs the file against the current timeline whatever its header rev says,
//     so an apply onto an empty timeline turns every element of the file into an add: that is the parse.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Where the CLI is looked for: $CARTON_CARDBOARD_CLI, else the unpacked 1.4.0 app kept for inspection. */
export const DEFAULT_CLI =
  process.env.CARTON_CARDBOARD_CLI ??
  path.join(os.homedir(), ".t3", "projects", "cardboard-showcase", "_inspect", "cardboard-1.4.0", "cli", "cardboard.mjs");

const DEFAULT_TIMEOUT_MS = 60_000;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Written to the CLI's stdin (for a `-` file argument). */
  input?: string;
  /** Library root passed as `--root` (default: this instance's scratch library). Ignored when args has `--root`. */
  root?: string;
  timeoutMs?: number;
}

/** `cb source apply|check --json`. 1.4.0 also returns ingested, wouldIngest, matched, importedLuts, wouldImportLuts,
 *  rev (the project's rev after the call) and summary {errors, warnings, ops}. */
export interface ApplyResult {
  applied: boolean;
  ops: unknown[];
  conflicts: unknown[];
  diagnostics?: unknown[];
  rev?: number;
  [field: string]: unknown;
}

/** What Cardboard stores for a timeline.tsx (project.json's timeline slice, plus its media list). */
export interface ParsedTimeline {
  aspectRatio: string;
  tracks: unknown[];
  timelineItems: unknown[];
  /** project.media after the apply: the context's file media plus a synthesized media item per text and code item. */
  media: unknown[];
  /** The `.revs` snapshot the apply recorded, the form history and merge use: code source inlined in each item's
   *  codeComposition. Undefined if the apply changed nothing. */
  snapshot?: { tracks: unknown[]; timelineItems: unknown[]; aspectRatio: string };
  diagnostics: unknown[];
}

export interface CardboardCli {
  readonly cliPath: string;
  /** This instance's scratch folder; dispose() removes it. */
  readonly scratch: string;
  /** The library `run` passes as `--root` by default (for `project create`, `media add` …). */
  readonly library: string;
  run(args: string[], opts?: RunOptions): Promise<CliResult>;
  /** Prints a project envelope ({format, version, project, media}; a bare project is wrapped), or a bundle folder. */
  print(project: object | string): Promise<string>;
  /** Throws a CardboardCliError carrying the apply result when Cardboard refuses the file. */
  parse(tsx: string, context?: object): Promise<ParsedTimeline>;
  apply(bundleDir: string, tsx: string, opts?: { prefer?: "file" | "editor" }): Promise<ApplyResult>;
  check(bundleDir: string, tsx: string, opts?: { prefer?: "file" | "editor" }): Promise<ApplyResult>;
  /** Writes `<name>.cardboard/project.json` (default name "Project") from an envelope or bare project, alone in a new
   *  scratch library; returns the bundle folder. */
  makeBundle(project: object, name?: string): string;
  /** Copies a bundle folder into a new scratch library; returns the copy. */
  copyBundle(bundleDir: string): string;
  dispose(): void;
}

export class CardboardCliError extends Error {
  result: CliResult | ApplyResult;
  constructor(message: string, result: CliResult | ApplyResult) {
    super(message);
    this.name = "CardboardCliError";
    this.result = result;
  }
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The project.json envelope for an envelope or a bare project. */
export function envelopeOf(project: object): Obj {
  const p = project as Obj;
  if (p.format === "cardboard-project") return p;
  return { format: "cardboard-project", version: 1, project: p, media: [] };
}

function findOnPath(name: string): string | undefined {
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const file = path.join(dir, n);
      if (fs.existsSync(file)) return file;
    }
  }
  return undefined;
}

/** The CLI's environment: no CARDBOARD_* settings from ours (library, cloud mode, app socket), a home folder inside
 *  the scratch (so nothing reads or writes the user's Cardboard profile), and ffmpeg/ffprobe for media commands. */
function cliEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("CARDBOARD_")) env[k] = v;
  for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) {
    env[k] = home;
  }
  const ffmpeg = process.env.CARDBOARD_FFMPEG ?? findOnPath("ffmpeg");
  const ffprobe = process.env.CARDBOARD_FFPROBE ?? findOnPath("ffprobe");
  if (ffmpeg) env.CARDBOARD_FFMPEG = ffmpeg;
  if (ffprobe) env.CARDBOARD_FFPROBE = ffprobe;
  return env;
}

class CliCodec implements CardboardCli {
  readonly cliPath: string;
  readonly scratch: string;
  readonly library: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly children = new Set<ChildProcess>();
  private libraries = 0;
  private disposed = false;

  constructor(cliPath: string, root: string) {
    this.cliPath = cliPath;
    fs.mkdirSync(root, { recursive: true });
    this.scratch = fs.mkdtempSync(path.join(root, "carton-cb-"));
    this.library = path.join(this.scratch, "lib");
    const home = path.join(this.scratch, "home");
    fs.mkdirSync(this.library);
    fs.mkdirSync(home);
    this.env = cliEnv(home);
  }

  run(args: string[], opts: RunOptions = {}): Promise<CliResult> {
    if (this.disposed) return Promise.reject(new Error("cardboardCli: used after dispose()"));
    const argv = args.includes("--root") ? args : ["--root", opts.root ?? this.library, ...args];
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.cliPath, ...argv], {
        cwd: this.scratch,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.children.add(child);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.on("error", (e) => {
        clearTimeout(timer);
        this.children.delete(child);
        reject(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        this.children.delete(child);
        const result = {
          code: code ?? -1,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        };
        if (timedOut) reject(new CardboardCliError(`cb ${args.join(" ")}: timed out after ${timeoutMs} ms`, result));
        else if (signal) reject(new CardboardCliError(`cb ${args.join(" ")}: killed by ${signal}`, result));
        else resolve(result);
      });
      // EPIPE when the CLI exits before reading all of stdin surfaces through 'close'; don't let it throw here.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input ?? "");
    });
  }

  private newLibrary(): string {
    const dir = path.join(this.scratch, "libs", String(++this.libraries));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  makeBundle(project: object, name = "Project"): string {
    const dir = path.join(this.newLibrary(), `${name}.cardboard`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(envelopeOf(project)));
    return dir;
  }

  copyBundle(bundleDir: string): string {
    const dir = path.join(this.newLibrary(), path.basename(bundleDir));
    fs.cpSync(bundleDir, dir, { recursive: true });
    return dir;
  }

  async print(project: object | string): Promise<string> {
    const own = typeof project !== "string";
    const dir = own ? this.makeBundle(project) : project;
    try {
      const r = await this.run(["source", "print", dir], { root: path.dirname(dir) });
      if (r.code !== 0) throw new CardboardCliError(`cb source print: exit ${r.code}: ${r.stderr.trim()}`, r);
      return r.stdout;
    } finally {
      if (own) fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  private async sourceJson(command: "apply" | "check", bundleDir: string, tsx: string, prefer?: string): Promise<ApplyResult> {
    const args = ["source", command, bundleDir, "-", "--json"];
    if (prefer) args.push("--prefer", prefer);
    const r = await this.run(args, { root: path.dirname(bundleDir), input: tsx });
    let json: unknown;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      throw new CardboardCliError(`cb source ${command}: exit ${r.code}, no JSON on stdout: ${r.stderr.trim()}`, r);
    }
    if (!isObj(json) || typeof json.applied !== "boolean") {
      const error = isObj(json) && typeof json.error === "string" ? json.error : r.stdout.trim();
      throw new CardboardCliError(`cb source ${command}: ${error}`, r);
    }
    return json as ApplyResult;
  }

  apply(bundleDir: string, tsx: string, opts: { prefer?: "file" | "editor" } = {}): Promise<ApplyResult> {
    return this.sourceJson("apply", bundleDir, tsx, opts.prefer);
  }

  check(bundleDir: string, tsx: string, opts: { prefer?: "file" | "editor" } = {}): Promise<ApplyResult> {
    return this.sourceJson("check", bundleDir, tsx, opts.prefer);
  }

  async parse(tsx: string, context?: object): Promise<ParsedTimeline> {
    const now = new Date().toISOString();
    const seed = context
      ? (structuredClone(envelopeOf(context)) as Obj)
      : envelopeOf({ id: randomUUID(), name: "Parse", createdAt: now, updatedAt: now, stateUpdatedAt: 1, aspectRatio: "16:9", media: [] });
    const project = seed.project as Obj;
    project.tracks = [];
    project.timelineItems = [];
    // Text and code media are synthesized per item on apply; with the items gone they would only be orphans.
    project.media = ((project.media ?? []) as Obj[]).filter((m) => {
      const type = isObj(m.data) ? m.data.type : undefined;
      return type !== "text" && type !== "code";
    });
    const dir = this.makeBundle(seed);
    try {
      const result = await this.apply(dir, tsx);
      if (!result.applied) throw new CardboardCliError("cb source apply refused the file", result);
      const stored = (JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")) as Obj).project as Obj;
      const revsDir = path.join(dir, ".revs");
      const revs = fs.existsSync(revsDir) ? fs.readdirSync(revsDir).filter((f) => /^\d+\.json$/.test(f)) : [];
      revs.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
      const newest = revs.at(-1);
      const snapshot = newest
        ? ((JSON.parse(fs.readFileSync(path.join(revsDir, newest), "utf8")) as Obj).doc as ParsedTimeline["snapshot"])
        : undefined;
      return {
        aspectRatio: stored.aspectRatio as string,
        tracks: stored.tracks as unknown[],
        timelineItems: stored.timelineItems as unknown[],
        media: stored.media as unknown[],
        snapshot,
        diagnostics: result.diagnostics ?? [],
      };
    } finally {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.children) child.kill("SIGKILL");
    this.children.clear();
    fs.rmSync(this.scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const ELEMENT = /^([ \t]*)<(?:clip|image|audio|text|caption|code|adjustment|shader)\b/gm;

/**
 * Edits the one element printed with `name="<name>"` in a timeline.tsx, the way an agent would. With `from`, replaces
 * that text, which must occur exactly once in the element; with `from` null, replaces the whole element (`to` may be a
 * function of it), and an empty `to` removes it with its line. Throws when the element or the text isn't unique.
 */
export function editElement(tsx: string, name: string, from: string | null, to: string | ((element: string) => string)): string {
  const attr = `name=${JSON.stringify(name)}`;
  const at = tsx.indexOf(attr);
  if (at < 0 || tsx.indexOf(attr, at + 1) >= 0) throw new Error(`editElement: ${attr} is not in the file exactly once`);
  let start = -1;
  let indent = "";
  for (const m of tsx.matchAll(ELEMENT)) {
    if (m.index > at) break;
    start = m.index;
    indent = m[1] ?? "";
  }
  if (start < 0) throw new Error(`editElement: no element holds ${attr}`);
  const lineEnd = tsx.indexOf("\n", start);
  const firstLine = tsx.slice(start, lineEnd < 0 ? undefined : lineEnd);
  const close = `\n${indent}/>`;
  const end = firstLine.trimEnd().endsWith("/>") ? start + firstLine.trimEnd().length : tsx.indexOf(close, start) + close.length;
  if (end < at) throw new Error(`editElement: can't find the end of the element holding ${attr}`);
  const element = tsx.slice(start, end);
  let next: string;
  if (from === null) {
    next = typeof to === "function" ? to(element) : to;
  } else {
    const i = element.indexOf(from);
    if (i < 0 || element.indexOf(from, i + 1) >= 0) throw new Error(`editElement: ${JSON.stringify(from)} is not in ${attr} exactly once`);
    next = element.slice(0, i) + (typeof to === "function" ? to(from) : to) + element.slice(i + from.length);
  }
  if (next === "") return tsx.slice(0, Math.max(0, start - 1)) + tsx.slice(end);
  return tsx.slice(0, start) + next + tsx.slice(end);
}

/**
 * The real CLI, or null when its file is absent (tests skip then). `cli` is the path to cardboard.mjs (default
 * DEFAULT_CLI); `root` is where this instance makes its scratch folder (default: the OS temp folder).
 */
export function cardboardCli(opts: { cli?: string; root?: string } = {}): CardboardCli | null {
  const cli = path.resolve(opts.cli ?? DEFAULT_CLI);
  if (!fs.existsSync(cli)) return null;
  return new CliCodec(cli, path.resolve(opts.root ?? os.tmpdir()));
}
