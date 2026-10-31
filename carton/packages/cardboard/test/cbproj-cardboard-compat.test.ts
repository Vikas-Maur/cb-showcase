// `.cbproj` compatibility with the pristine Cardboard 1.4.0 CLI, run headless as a subprocess (skipped when it isn't
// there; set CARTON_CARDBOARD_CLI to point at it):
//   (a) a `.cbproj` from Cardboard's own `project save-as` reads back through ZipReader, and its members are exactly
//       the manifest plus what walkBundle finds in the bundle;
//   (b) a `.cbproj` from our ZipWriter (Cardboard's manifest, the walked files, a `.carton-export/shallow.json`) is
//       imported by Cardboard and opens with the same timeline, with and without zip64 records;
//   (c) Cardboard refuses an archive whose manifest is marked compressed, which is why the writer only stores.
//
// Importing: `cb project open <file.cbproj>` is the CLI's import command, but it refuses `--root` and otherwise needs
// a signed-in account and a running app. So the import runs the same library call that command makes for a
// `.cbproj`, `projects.openArchive`, on a library opened with `--root`'s own opener (exported from the CLI's main
// chunk as `Za` in 1.4.0), in a child process. Nothing of Cardboard's is copied here.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZipReader, ZipWriter } from "../src/node/cbproj/zip.ts";
import { MANIFEST, MANIFEST_MAX_BYTES, SHALLOW_ENTRY, walkBundle } from "../src/node/cbproj/walk.ts";

const CLI =
  process.env.CARTON_CARDBOARD_CLI ?? "/home/ubuntu/.t3/projects/cardboard-showcase/_inspect/cardboard-1.4.0/cli/cardboard.mjs";
const CHUNK = path.join(path.dirname(CLI), "chunks", "chunk-LL26E55H.mjs");

function findOnPath(name: string): string | undefined {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return undefined;
}
const FFMPEG = process.env.CARDBOARD_FFMPEG ?? findOnPath("ffmpeg");
const FFPROBE = process.env.CARDBOARD_FFPROBE ?? findOnPath("ffprobe");
const skip = !fs.existsSync(CLI)
  ? `no Cardboard CLI at ${CLI} (set CARTON_CARDBOARD_CLI)`
  : !FFMPEG || !FFPROBE
    ? "ffmpeg and ffprobe are needed (set CARDBOARD_FFMPEG and CARDBOARD_FFPROBE)"
    : false;

const SCRATCH =
  process.env.CARTON_TEST_SCRATCH ??
  (fs.existsSync(path.join(os.homedir(), "gfv-scratch"))
    ? path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "helper-zip")
    : os.tmpdir());

// A child imports the archive into the library at `root` and prints the project.
const IMPORT = `
import { pathToFileURL } from "node:url";
const [chunk, root, file] = process.argv.slice(1);
try {
  const cli = await import(pathToFileURL(chunk).href);
  if (typeof cli.Za !== "function") throw new Error("this Cardboard CLI has no library opener 'Za' (not 1.4.0?)");
  const library = await cli.Za({ root });
  const doc = await library.projects.openArchive(file);
  console.log(JSON.stringify({ id: doc.id, name: doc.name, bundlePath: library.projects.bundlePathFor(doc.id) }));
  process.exit(0);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
`;

describe("Cardboard 1.4.0 reads our .cbproj and we read its own", { skip }, () => {
  let dir = "";
  let env: NodeJS.ProcessEnv = {};
  let bundle = "";
  let theirs = "";
  let timeline = "";
  let libraries = 0;

  const run = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, args, { encoding: "utf8", env, cwd: dir, timeout: 120_000 });
    if (r.error) throw r.error;
    return r;
  };
  const cb = (root: string, ...args: string[]): any => {
    const r = run([CLI, "--root", root, "--json", ...args]);
    assert.equal(r.status, 0, `cb ${args.join(" ")}: ${r.stderr || r.stdout}`);
    return JSON.parse(r.stdout);
  };
  const importArchive = (file: string): { status: number | null; stdout: string; stderr: string; root: string } => {
    const root = path.join(dir, `lib-${++libraries}`);
    fs.mkdirSync(root);
    return { ...run(["--input-type=module", "-e", IMPORT, CHUNK, root, file]), root };
  };

  before(async () => {
    await fsp.mkdir(SCRATCH, { recursive: true });
    dir = await fsp.mkdtemp(path.join(SCRATCH, "compat-"));
    const home = path.join(dir, "home");
    await fsp.mkdir(home);
    // Keep the CLI away from the real user's settings, whatever it might look for there.
    env = { ...process.env, CARDBOARD_FFMPEG: FFMPEG, CARDBOARD_FFPROBE: FFPROBE, HOME: home, USERPROFILE: home };
    const lib = path.join(dir, "lib");
    await fsp.mkdir(lib);

    const media = path.join(dir, "red.mp4");
    const ff = spawnSync(FFMPEG!, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1:r=10", "-pix_fmt", "yuv420p", media]);
    assert.equal(ff.status, 0, String(ff.stderr));

    bundle = cb(lib, "project", "create", "Compat").bundlePath;
    cb(lib, "media", "add", "Compat", media);
    const tsx = path.join(dir, "edit.tsx");
    await fsp.writeFile(
      tsx,
      `export default (
  <timeline aspect="16:9">
    <track>
      <text textContent="Hello" start={0} end={1} />
    </track>
    <track>
      <clip src="red.mp4" start={0} end={1} />
    </track>
  </timeline>
);
`,
    );
    assert.equal(cb(lib, "source", "apply", "Compat", tsx).applied, true);
    timeline = cb(lib, "source", "print", "Compat").source;
    assert.match(timeline, /2 items/);

    theirs = path.join(dir, "theirs.cbproj");
    assert.deepEqual(cb(lib, "project", "save-as", "Compat", theirs).missing, []);
  });

  after(async () => {
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  });

  it("(a) reads Cardboard's own save-as: the manifest plus exactly the walked files, CRCs checked", async () => {
    const reader = await ZipReader.open(theirs);
    try {
      const walked = await walkBundle(bundle);
      assert.deepEqual(
        reader.entries.map((e) => e.name).sort(),
        [MANIFEST, ...walked.map((f) => f.archivePath)].sort(),
      );
      assert.ok(walked.some((f) => f.archivePath.startsWith("media/")), "the footage is in the bundle");
      for (const e of reader.entries) {
        assert.equal(e.method, 0, e.name);
        assert.ok(e.flags & 0x0800, `${e.name} has a UTF-8 name`);
      }
      // yazl streams files with a data descriptor and zeros in the local header: the reader must not need them.
      assert.ok(reader.entries.some((e) => e.flags & 0x0008));
      for (const f of walked) {
        assert.ok((await reader.readEntry(f.archivePath)).equals(await fsp.readFile(f.sourcePath)), f.archivePath);
      }
      const out = path.join(dir, "extracted", "media.bin");
      const media = walked.find((f) => f.archivePath.startsWith("media/"))!;
      await reader.extractEntry(media.archivePath, out);
      assert.ok((await fsp.readFile(out)).equals(await fsp.readFile(media.sourcePath)));
      const manifest = JSON.parse((await reader.readEntry(MANIFEST, MANIFEST_MAX_BYTES)).toString("utf8"));
      assert.equal(manifest.format, "cardboard-project");
      assert.equal(manifest.project.name, "Compat");
    } finally {
      await reader.close();
    }
  });

  it("(b) Cardboard imports our .cbproj, zip64 or not, and the project opens with the same timeline", async () => {
    // Carton's files in the bundle: none of them may travel, except what the export writes as its own entry.
    const add = async (rel: string, data: string): Promise<void> => {
      const abs = path.join(bundle, ...rel.split("/"));
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, data);
    };
    await add(".carton/carton.db", "not really sqlite");
    await add(".carton/displaced/1", "{}");
    await add(".carton-export/shallow.json", '{"stale":true}'); // as a received copy's import leaves it
    await add(".scratch/views/director.tsx", "export default null;");
    await add(".scratch/notes – ü.md", "keep me");

    const walked = await walkBundle(bundle);
    const names = walked.map((f) => f.archivePath);
    assert.ok(names.includes(".scratch/notes – ü.md"));
    assert.ok(!names.some((n) => n.startsWith(".carton") || n.startsWith(".scratch/views")));

    const reader = await ZipReader.open(theirs);
    const manifest = await reader.readEntry(MANIFEST, MANIFEST_MAX_BYTES);
    await reader.close();
    const shallow = JSON.stringify({ carton: "shallow export", test: true });

    for (const zip64Threshold of [undefined, 0]) {
      const ours = path.join(dir, `ours-${zip64Threshold ?? "plain"}.cbproj`);
      const zip = await ZipWriter.create(ours, { zip64Threshold });
      await zip.addBuffer(MANIFEST, manifest);
      for (const f of walked) await zip.addFile(f.archivePath, f.sourcePath);
      await zip.addBuffer(SHALLOW_ENTRY, Buffer.from(shallow));
      await zip.close();

      const imported = importArchive(ours);
      assert.equal(imported.status, 0, `import of ${path.basename(ours)}: ${imported.stderr}`);
      const project = JSON.parse(imported.stdout);
      assert.equal(project.name, "Compat");
      assert.equal(cb(imported.root, "source", "print", "Compat").source, timeline);
      const media = cb(imported.root, "media", "ls", "Compat");
      assert.equal(media.length, 1);
      assert.equal(media[0].present, true);
      assert.ok(media[0].path.startsWith(project.bundlePath), "the footage was copied into the new bundle");

      const at = (rel: string): string => path.join(project.bundlePath, ...rel.split("/"));
      assert.equal(await fsp.readFile(at(".scratch/notes – ü.md"), "utf8"), "keep me");
      assert.equal(await fsp.readFile(at(SHALLOW_ENTRY), "utf8"), shallow); // Cardboard extracts every member
      assert.equal(fs.existsSync(at(".carton")), false);
      assert.equal(fs.existsSync(at(".scratch/views")), false);
    }
  });

  it("(c) Cardboard refuses an archive whose manifest is marked compressed", async () => {
    const file = path.join(dir, "compressed.cbproj");
    const reader = await ZipReader.open(theirs);
    const manifest = await reader.readEntry(MANIFEST, MANIFEST_MAX_BYTES);
    await reader.close();
    const zip = await ZipWriter.create(file);
    await zip.addBuffer(MANIFEST, manifest);
    await zip.close();
    // Mark the one member deflated (method 8) in its local and central headers.
    const raw = await fsp.readFile(file);
    const cdOffset = raw.readUInt32LE(raw.length - 22 + 16);
    raw.writeUInt16LE(8, 8);
    raw.writeUInt16LE(8, cdOffset + 10);
    await fsp.writeFile(file, raw);

    const imported = importArchive(file);
    assert.notEqual(imported.status, 0);
    assert.match(imported.stderr, /compressed member: project\.json/);
    const ours = await ZipReader.open(file);
    await assert.rejects(ours.readEntry(MANIFEST), /compressed member: project\.json/);
    await ours.close();
  });
});
