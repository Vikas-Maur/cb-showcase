// The `.cbproj` container: the stored-zip writer and reader, and the bundle walk with Carton's exclusions (H11).
// Archives are checked by our reader and, where they are installed, by Python's zipfile and Info-ZIP's unzip.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { ZipReader, ZipWriter, safeEntryPath, sanitizeEntryName } from "../src/node/cbproj/zip.ts";
import {
  CARTON_DIR,
  EXPORT_DIR,
  FULL_ENTRY,
  MANIFEST,
  SHALLOW_ENTRY,
  VIEWS_DIR,
  excludedFromExport,
  walkBundle,
} from "../src/node/cbproj/walk.ts";

// Scratch goes under ~/gfv-scratch on the shared dev box (its /tmp is a small tmpfs), else the OS temp folder.
const SCRATCH =
  process.env.CARTON_TEST_SCRATCH ??
  (fs.existsSync(path.join(os.homedir(), "gfv-scratch"))
    ? path.join(os.homedir(), "gfv-scratch", "carton", "cardboard-adapter", "helper-zip")
    : os.tmpdir());
let root = "";
let n = 0;
const scratch = (name: string): string => path.join(root, `${n++}-${name}`);

before(async () => {
  await fsp.mkdir(SCRATCH, { recursive: true });
  root = await fsp.mkdtemp(path.join(SCRATCH, "zip-"));
});
after(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------ outside checks

interface PythonView {
  bad: string | null;
  entries: Array<[name: string, size: number, crc: number, method: number, version: number]>;
}

const PY = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    print(json.dumps({"bad": bad, "entries": [[i.filename, i.file_size, i.CRC, i.compress_type, i.extract_version] for i in z.infolist()]}))
`;

/** Python's view of the archive (every member CRC-checked), or null when python3 isn't installed. */
function python(file: string): PythonView | null {
  const r = spawnSync("python3", ["-I", "-c", PY, file], { encoding: "utf8" });
  if (r.error) return null;
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as PythonView;
}

/** Info-ZIP's `unzip -t` and 7-Zip's `7z t`, each when installed. */
function unzipTest(file: string): void {
  const unzip = spawnSync("unzip", ["-tq", file], { encoding: "utf8" });
  if (!unzip.error) assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
  const sevenZip = spawnSync("7z", ["t", file], { encoding: "utf8" });
  if (!sevenZip.error) {
    assert.equal(sevenZip.status, 0, sevenZip.stdout + sevenZip.stderr);
    assert.match(sevenZip.stdout, /Everything is Ok/);
  }
}

// ------------------------------------------------------------------------------------------- hand-made archives

interface Crafted {
  name: string | Buffer; // a Buffer is written without the UTF-8 flag
  data: Buffer;
  method?: number;
  localExtra?: Buffer;
  centralExtra?: Buffer;
  /** yazl's layout for a streamed file: zeros in the local header, a data descriptor after the data. */
  descriptor?: boolean;
}

function craftZip(members: Crafted[], comment: Buffer = Buffer.alloc(0)): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let pos = 0;
  for (const m of members) {
    const name = typeof m.name === "string" ? Buffer.from(m.name, "utf8") : m.name;
    const flags = (typeof m.name === "string" ? 0x0800 : 0) | (m.descriptor ? 0x0008 : 0);
    const method = m.method ?? 0;
    const stored = method === 8 ? zlib.deflateRawSync(m.data) : m.data;
    const crc = zlib.crc32(m.data);
    const localExtra = m.localExtra ?? Buffer.alloc(0);
    const centralExtra = m.centralExtra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    if (!m.descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(stored.length, 18);
      local.writeUInt32LE(m.data.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const descriptor = Buffer.alloc(m.descriptor ? 16 : 0);
    if (m.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(stored.length, 8);
      descriptor.writeUInt32LE(m.data.length, 12);
    }
    const offset = pos;
    for (const b of [local, name, localExtra, stored, descriptor]) {
      parts.push(b);
      pos += b.length;
    }
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(stored.length, 20);
    header.writeUInt32LE(m.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(centralExtra.length, 30);
    header.writeUInt32LE(offset, 42);
    central.push(header, name, centralExtra);
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(pos, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, cd, eocd, comment]);
}

async function writeCrafted(name: string, members: Crafted[], comment?: Buffer): Promise<string> {
  const file = scratch(name);
  await fsp.writeFile(file, craftZip(members, comment));
  return file;
}

// ------------------------------------------------------------------------------------------------------- writer

test("round trip: buffers and streamed files, empty ones, UTF-8 names, nested folders, several chunks", async () => {
  const src = scratch("src");
  await fsp.mkdir(path.join(src, "a", "b", "c"), { recursive: true });
  const big = randomBytes(2.5 * 1024 * 1024); // three chunks, the last one short
  const small = Buffer.from("deep inside\n");
  await fsp.writeFile(path.join(src, "big.bin"), big);
  await fsp.writeFile(path.join(src, "empty.bin"), "");
  await fsp.writeFile(path.join(src, "a", "b", "c", "d.txt"), small);
  const manifest = Buffer.from(JSON.stringify({ format: "cardboard-project", version: 1 }));
  const utf8 = Buffer.from("été – 日本語 🎬\n");

  const file = scratch("round.cbproj");
  const zip = await ZipWriter.create(file);
  const progress: number[] = [];
  zip.onProgress = (written) => progress.push(written);
  await zip.addBuffer("project.json", manifest);
  await zip.addBuffer("empty-buffer", new Uint8Array(0));
  await zip.addFile("media/empty.bin", path.join(src, "empty.bin"));
  await zip.addFile("media/big.bin", path.join(src, "big.bin"));
  await zip.addFile("a/b/c/d.txt", path.join(src, "a", "b", "c", "d.txt"));
  await zip.addBuffer("clips/été – 日本語 🎬.txt", utf8);
  const result = await zip.close();

  assert.equal(result.path, file);
  assert.equal(result.entries, 6);
  assert.equal(result.size, (await fsp.stat(file)).size);
  assert.equal(fs.existsSync(`${file}.part`), false);
  assert.ok(progress.length >= 8, "a progress call per chunk");
  assert.ok(progress.every((v, i) => i === 0 || v >= progress[i - 1]), "progress never goes back");
  assert.equal(progress.at(-1), result.size);

  const expected: Array<[string, Buffer]> = [
    ["project.json", manifest],
    ["empty-buffer", Buffer.alloc(0)],
    ["media/empty.bin", Buffer.alloc(0)],
    ["media/big.bin", big],
    ["a/b/c/d.txt", small],
    ["clips/été – 日本語 🎬.txt", utf8],
  ];
  const reader = await ZipReader.open(file);
  try {
    assert.deepEqual(
      reader.entries.map((e) => [e.name, e.size, e.method, e.flags]),
      expected.map(([name, data]) => [name, data.length, 0, 0x0800]),
    );
    for (const [name, data] of expected) {
      assert.ok(reader.has(name));
      assert.ok((await reader.readEntry(name)).equals(data), name);
      assert.equal(reader.entries.find((e) => e.name === name)?.crc32, zlib.crc32(data));
    }
    const out = path.join(scratch("out"), "nested", "big.bin");
    await reader.extractEntry("media/big.bin", out);
    assert.ok((await fsp.readFile(out)).equals(big));
    assert.equal(fs.existsSync(`${out}.part`), false);
    await reader.extractEntry("media/empty.bin", `${out}.empty`);
    assert.equal((await fsp.stat(`${out}.empty`)).size, 0);
  } finally {
    await reader.close();
  }

  const py = python(file);
  if (py) {
    assert.equal(py.bad, null);
    assert.deepEqual(
      py.entries.map(([name, size, crc, method]) => [name, size, crc, method]),
      expected.map(([name, data]) => [name, data.length, zlib.crc32(data), 0]),
    );
  }
  unzipTest(file);
});

test("zip64 records, forced by a low threshold, are written as yazl writes them and read back", async () => {
  for (const threshold of [0, 40]) {
    const file = scratch(`zip64-${threshold}.cbproj`);
    const zip = await ZipWriter.create(file, { zip64Threshold: threshold });
    const members: Array<[string, Buffer]> = [
      ["a.txt", Buffer.from("0123456789")], // with 40: offset 0 and 10 bytes, so not zip64
      ["b.txt", Buffer.from("second")], // with 40: offset 45, so zip64
      ["media/c.bin", randomBytes(100)], // with 40: size 100, so zip64
    ];
    for (const [name, data] of members) await zip.addBuffer(name, data);
    const srcFile = scratch("zip64-src");
    await fsp.writeFile(srcFile, randomBytes(70));
    await zip.addFile("media/d.bin", srcFile); // the streamed path: zip64 local header patched in place
    members.push(["media/d.bin", await fsp.readFile(srcFile)]);
    await zip.close();

    const raw = await fsp.readFile(file);
    const tail = raw.subarray(raw.length - 22 - 20 - 56);
    assert.equal(tail.readUInt32LE(0), 0x06064b50, "zip64 end record");
    assert.equal(tail.readUInt32LE(56), 0x07064b50, "zip64 locator");
    assert.equal(raw.readUInt16LE(raw.length - 22 + 10), 0xffff, "the EOCD points at the zip64 record");

    const reader = await ZipReader.open(file);
    try {
      assert.deepEqual(
        reader.entries.map((e) => [e.name, e.size]),
        members.map(([name, data]) => [name, data.length]),
      );
      for (const [name, data] of members) assert.ok((await reader.readEntry(name)).equals(data), name);
    } finally {
      await reader.close();
    }
    const py = python(file);
    if (py) {
      assert.equal(py.bad, null);
      const versions = py.entries.map((e) => e[4]);
      assert.deepEqual(versions, threshold === 0 ? [45, 45, 45, 45] : [20, 45, 45, 45]);
    }
    unzipTest(file);
  }
});

test("the writer refuses unsafe, non-canonical and duplicate names, and stays usable", async () => {
  const file = scratch("names.cbproj");
  const zip = await ZipWriter.create(file);
  for (const bad of ["../x", "a/../../x", "/abs", "a\\b", "C:x", "a//b", "./a", "a/", "", ".", "nul\0x"]) {
    await assert.rejects(zip.addBuffer(bad, Buffer.from("x")), /Unsafe or non-canonical/, JSON.stringify(bad));
  }
  await zip.addBuffer("ok.txt", Buffer.from("1"));
  await assert.rejects(zip.addBuffer("ok.txt", Buffer.from("2")), /Duplicate/);
  await zip.close();
  const reader = await ZipReader.open(file);
  assert.deepEqual(
    reader.entries.map((e) => e.name),
    ["ok.txt"],
  );
  await reader.close();
});

test("addFile throws when the file changes during the copy; the archive keeps nothing of it", async () => {
  const src = scratch("changing.bin");
  const file = scratch("changing.cbproj");
  const zip = await ZipWriter.create(file);
  await zip.addBuffer("first.txt", Buffer.from("first"));

  // Grows after the first chunk.
  await fsp.writeFile(src, randomBytes(3 * 1024 * 1024));
  let once = false;
  zip.onProgress = () => {
    if (!once) fs.appendFileSync(src, "more");
    once = true;
  };
  await assert.rejects(zip.addFile("grew.bin", src), /changed while it was being saved/);

  // Truncated after the first chunk.
  await fsp.writeFile(src, randomBytes(3 * 1024 * 1024));
  once = false;
  zip.onProgress = () => {
    if (!once) fs.truncateSync(src, 10);
    once = true;
  };
  await assert.rejects(zip.addFile("shrank.bin", src), /changed while it was being saved/);

  zip.onProgress = undefined;
  await zip.addBuffer("last.txt", Buffer.from("last"));
  const { size } = await zip.close();
  assert.ok(size < 1024, "the half-copied members' bytes were dropped");

  const reader = await ZipReader.open(file);
  assert.deepEqual(
    reader.entries.map((e) => e.name),
    ["first.txt", "last.txt"],
  );
  assert.equal((await reader.readEntry("last.txt")).toString(), "last");
  await reader.close();
  const py = python(file);
  if (py) assert.equal(py.bad, null);
});

test("abort deletes the partial archive, and later calls fail", async () => {
  const file = scratch("aborted.cbproj");
  const zip = await ZipWriter.create(file);
  await zip.addBuffer("a.txt", Buffer.from("a"));
  assert.ok(fs.existsSync(`${file}.part`));
  await zip.abort();
  await zip.abort();
  assert.equal(fs.existsSync(`${file}.part`), false);
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(zip.addBuffer("b.txt", Buffer.from("b")), /aborted/);
  await assert.rejects(zip.close(), /aborted/);
});

test("calls made without awaiting queue up in order", async () => {
  const file = scratch("queued.cbproj");
  const zip = await ZipWriter.create(file);
  const src = scratch("queued.bin");
  await fsp.writeFile(src, randomBytes(1.5 * 1024 * 1024));
  const pending = [zip.addFile("one.bin", src), zip.addBuffer("two.txt", Buffer.from("2")), zip.addFile("three.bin", src)];
  const closing = zip.close();
  await Promise.all(pending);
  await closing;
  const reader = await ZipReader.open(file);
  assert.deepEqual(
    reader.entries.map((e) => e.name),
    ["one.bin", "two.txt", "three.bin"],
  );
  assert.ok((await reader.readEntry("three.bin")).equals(await fsp.readFile(src)));
  await reader.close();
});

// ------------------------------------------------------------------------------------------------------- reader

test("a CRC mismatch is detected by readEntry and extractEntry, and nothing is left behind", async () => {
  const file = scratch("crc.cbproj");
  const zip = await ZipWriter.create(file);
  await zip.addBuffer("a.txt", Buffer.from("hello world"));
  await zip.close();
  const raw = await fsp.readFile(file);
  const dataAt = 30 + raw.readUInt16LE(26) + raw.readUInt16LE(28);
  raw[dataAt] ^= 0xff;
  await fsp.writeFile(file, raw);

  const reader = await ZipReader.open(file);
  await assert.rejects(reader.readEntry("a.txt"), /CRC-32 mismatch/);
  const out = scratch("crc-out.txt");
  await assert.rejects(reader.extractEntry("a.txt", out), /CRC-32 mismatch/);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.existsSync(`${out}.part`), false);
  await reader.close();
});

test("the end record is found behind a trailing comment, even one holding its signature", async () => {
  const members: Crafted[] = [{ name: "a.txt", data: Buffer.from("A") }];
  const fake = Buffer.alloc(22);
  fake.writeUInt32LE(0x06054b50, 0); // a decoy end record inside the comment, its length field wrong
  fake.writeUInt16LE(7, 20);
  const comment = Buffer.concat([Buffer.from("note "), fake, Buffer.from(" end")]);
  const file = await writeCrafted("comment.zip", members, comment);
  const reader = await ZipReader.open(file);
  assert.deepEqual(
    reader.entries.map((e) => e.name),
    ["a.txt"],
  );
  assert.equal((await reader.readEntry("a.txt")).toString(), "A");
  await reader.close();

  // The longest comment there can be: the record is exactly 65,557 bytes from the end.
  const longest = await writeCrafted("comment-max.zip", members, Buffer.alloc(0xffff, 0x61));
  const reader2 = await ZipReader.open(longest);
  assert.equal(reader2.entries.length, 1);
  await reader2.close();
});

test("a compressed member is refused, as Cardboard refuses it", async () => {
  const data = Buffer.from("squeeze me ".repeat(100));
  const file = await writeCrafted("deflated.zip", [
    { name: "project.json", data, method: 8 },
    { name: "ok.txt", data: Buffer.from("ok") },
  ]);
  const py = python(file);
  if (py) assert.equal(py.bad, null, "the hand-made deflate member is valid");
  const reader = await ZipReader.open(file);
  assert.equal(reader.entries[0].method, 8);
  await assert.rejects(reader.readEntry("project.json"), /compressed member: project\.json/);
  await assert.rejects(reader.extractEntry("project.json", scratch("deflated-out")), /compressed member/);
  assert.equal((await reader.readEntry("ok.txt")).toString(), "ok");
  await reader.close();
});

test("unsafe member names are listed but never read", async () => {
  const unsafe = ["../evil.txt", "a/../../evil.txt", "/etc/evil", "a\\..\\evil", "C:evil", "./C:evil", "nul\0x"];
  const file = await writeCrafted("unsafe.zip", [
    ...unsafe.map((name) => ({ name, data: Buffer.from("x") })),
    { name: "fine/./ok.txt", data: Buffer.from("ok") },
  ]);
  const reader = await ZipReader.open(file);
  assert.equal(reader.entries.length, unsafe.length + 1);
  for (const name of unsafe) {
    await assert.rejects(reader.readEntry(name), /unsafe member/, JSON.stringify(name));
    await assert.rejects(reader.extractEntry(name, scratch("unsafe-out")), /unsafe member/);
  }
  assert.equal((await reader.readEntry("fine/./ok.txt")).toString(), "ok");
  await reader.close();
});

test("sanitizeEntryName and safeEntryPath follow Cardboard's rule", () => {
  const cases: Array<[string, string | null]> = [
    ["a/b/c.txt", "a/b/c.txt"],
    ["a//b/./c.txt", "a/b/c.txt"],
    ["dir/", "dir"],
    ["./a", "a"],
    ["..a/b..", "..a/b.."],
    ["", null],
    [".", null],
    ["./", null],
    ["a/..", null],
    ["../a", null],
    ["/a", null],
    ["a\\b", null],
    ["a\0b", null],
    ["C:/a", null],
    ["./c:a", null],
    ["a/C:b", "a/C:b"],
  ];
  for (const [name, canonical] of cases) {
    assert.equal(sanitizeEntryName(name), canonical, JSON.stringify(name));
    assert.equal(safeEntryPath(name), canonical === null ? null : path.join(...canonical.split("/")), JSON.stringify(name));
  }
});

test("yazl's layout: data descriptors, and local extra fields of another length than the central ones", async () => {
  const timestamp = Buffer.alloc(9); // yazl puts a 0x5455 timestamp in the central header only; here the reverse too
  timestamp.writeUInt16LE(0x5455, 0);
  timestamp.writeUInt16LE(5, 2);
  const file = await writeCrafted("yazl.zip", [
    { name: "a.txt", data: Buffer.from("streamed"), descriptor: true, centralExtra: timestamp },
    { name: "b.txt", data: Buffer.from("local extra"), localExtra: Buffer.alloc(40, 0), centralExtra: Buffer.alloc(0) },
  ]);
  const py = python(file);
  if (py) assert.equal(py.bad, null);
  const reader = await ZipReader.open(file);
  assert.equal((await reader.readEntry("a.txt")).toString(), "streamed");
  assert.equal((await reader.readEntry("b.txt")).toString(), "local extra");
  await reader.extractEntry("b.txt", scratch("b.txt"));
  await reader.close();
});

test("names without the UTF-8 flag decode as CP437 unless an Info-ZIP Unicode Path field matches", async () => {
  const raw = Buffer.from([0x82, 0x41, 0x2e, 0x74, 0x78, 0x74]); // "éA.txt" in CP437
  const unicode = Buffer.from("ünïcode.txt");
  // The field holds the CRC-32 of the name bytes it was made for; a tool that renames the member leaves it stale.
  const field = (madeFor: Buffer): Buffer => {
    const b = Buffer.alloc(4 + 5 + unicode.length);
    b.writeUInt16LE(0x7075, 0);
    b.writeUInt16LE(5 + unicode.length, 2);
    b[4] = 1;
    b.writeUInt32LE(zlib.crc32(madeFor), 5);
    unicode.copy(b, 9);
    return b;
  };
  const other = Buffer.from("other.txt");
  const stale = Buffer.from("stale.txt");
  const file = await writeCrafted("cp437.zip", [
    { name: raw, data: Buffer.from("1") },
    { name: other, data: Buffer.from("2"), centralExtra: field(other) },
    { name: stale, data: Buffer.from("3"), centralExtra: field(Buffer.from("renamed since")) },
  ]);
  const reader = await ZipReader.open(file);
  assert.deepEqual(
    reader.entries.map((e) => e.name),
    ["éA.txt", "ünïcode.txt", "stale.txt"],
  );
  assert.equal((await reader.readEntry("ünïcode.txt")).toString(), "2");
  await reader.close();
});

test("archives that two readers could read differently, or not at all, are refused", async () => {
  const dup = await writeCrafted("dup.zip", [
    { name: "project.json", data: Buffer.from("{}") },
    { name: "project.json", data: Buffer.from('{"evil":1}') },
  ]);
  await assert.rejects(ZipReader.open(dup), /duplicate member: project\.json/);

  const notZip = scratch("not.zip");
  await fsp.writeFile(notZip, "just some text that is long enough to scan");
  await assert.rejects(ZipReader.open(notZip), /no end of central directory/);

  const empty = scratch("empty.zip");
  await fsp.writeFile(empty, "");
  await assert.rejects(ZipReader.open(empty), /no end of central directory/);

  const truncated = scratch("truncated.zip");
  const whole = craftZip([{ name: "a.txt", data: randomBytes(1000) }]);
  await fsp.writeFile(truncated, Buffer.concat([whole.subarray(0, 500), whole.subarray(whole.length - 22 - 46 - 5)]));
  await assert.rejects(ZipReader.open(truncated), /damaged/);
});

test("readEntry enforces maxBytes, as Cardboard caps project.json", async () => {
  const file = await writeCrafted("big-manifest.zip", [{ name: MANIFEST, data: Buffer.alloc(1000, 0x20) }]);
  const reader = await ZipReader.open(file);
  await assert.rejects(reader.readEntry(MANIFEST, 999), /oversized project\.json/);
  assert.equal((await reader.readEntry(MANIFEST, 1000)).length, 1000);
  await assert.rejects(reader.readEntry("missing.json"), /no member/);
  await reader.close();
});

// --------------------------------------------------------------------------------------------------------- walk

const EXCLUDED = [
  "cache/x.bin",
  "cache/sub/y.jpg",
  "converted/c.mp4",
  "proxies/p.mp4",
  ".revs/1793424606419.json",
  `${CARTON_DIR}/carton.db`,
  `${CARTON_DIR}/displaced/x`,
  SHALLOW_ENTRY,
  FULL_ENTRY,
  `${VIEWS_DIR}/a.tsx`,
  `${VIEWS_DIR}/a.status`,
  `${VIEWS_DIR}/deep/b.tsx`,
  ".x.tmp",
  ".project.json.3f2a.tmp",
  ".tmpdir.tmp/inside.txt",
  MANIFEST,
];
const INCLUDED = [
  ".scratch/notes.md",
  ".scratch/views-old/a.tsx", // a sibling whose name starts like the excluded folder's
  ".scratch/viewsa",
  "media/a.mp4",
  "media/été 日本.mov",
  "nested/cache/x",
  "nested/.carton/x", // only the top-level .carton is Carton's
  "nested/project.json",
  "nested/.y.tmp",
  "timeline.tsx",
  "timeline.d.ts",
  "AGENTS.md",
  "agent/chats.json",
  "agent/chats/1.jsonl",
];

async function makeBundle(files: string[]): Promise<string> {
  const dir = scratch("Walk.cardboard");
  for (const [i, rel] of files.entries()) {
    const abs = path.join(dir, ...rel.split("/"));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, "x".repeat(i + 1));
  }
  await fsp.mkdir(path.join(dir, "empty-folder"), { recursive: true });
  return dir;
}

test("walkBundle keeps what Cardboard's walk keeps, less Carton's folders", async () => {
  const all = [...EXCLUDED, ...INCLUDED];
  const dir = await makeBundle(all);
  // Symlinks are skipped as Cardboard's walk skips them (Windows may not allow creating them: then untested here).
  let symlinks = false;
  try {
    await fsp.symlink(path.join(dir, "media", "a.mp4"), path.join(dir, "link.mp4"));
    await fsp.symlink(path.join(dir, "media"), path.join(dir, "linked-media"), "dir");
    symlinks = true;
  } catch (e) {
    if (process.platform !== "win32") throw e;
  }

  const walked = await walkBundle(dir);
  const sorted = [...INCLUDED].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(
    walked.map((f) => f.archivePath),
    sorted,
  );
  for (const f of walked) {
    const i = all.indexOf(f.archivePath);
    assert.equal(f.size, i + 1, f.archivePath);
    assert.equal(f.sourcePath, path.join(dir, ...f.archivePath.split("/")));
  }
  if (symlinks) assert.ok(!walked.some((f) => f.archivePath.startsWith("link")));

  // The predicate alone agrees with the walk on every file.
  const kept = new Set(walked.map((f) => f.archivePath));
  for (const rel of all) assert.equal(excludedFromExport(rel), !kept.has(rel), rel);
  // An export's own entries are never carried over from a received copy.
  assert.ok(excludedFromExport(SHALLOW_ENTRY) && excludedFromExport(FULL_ENTRY) && excludedFromExport(EXPORT_DIR));
});

test("Carton's names fold case where the file system does; Cardboard's never do", async () => {
  const folded: Array<[string, boolean]> = [
    [".Carton/carton.db", true],
    [".CARTON-EXPORT/shallow.json", true],
    [".Scratch/VIEWS/a.tsx", true],
    [".scratch/Views", true],
    [".scratch/viewsX/a", false],
    ["Cache/x", false],
    ["PROJECT.JSON", false],
    ["Proxies/p.mp4", false],
    [".REVS/1.json", false],
  ];
  for (const [p, excluded] of folded) {
    assert.equal(excludedFromExport(p, true), excluded, `${p} folded`);
    assert.equal(excludedFromExport(p, false), false, `${p} exact`);
  }

  // On a case-sensitive file system the folded walk can be tried on names that differ only in case.
  const probe = scratch("case-probe");
  await fsp.writeFile(probe, "");
  if (fs.existsSync(path.join(path.dirname(probe), path.basename(probe).toUpperCase()))) return;
  const dir = await makeBundle([".Carton/x", ".SCRATCH/Views/v.tsx", ".scratch/notes.md", "Cache/x", "cache/y"]);
  assert.deepEqual(
    (await walkBundle(dir, true)).map((f) => f.archivePath),
    [".scratch/notes.md", "Cache/x"],
  );
  assert.deepEqual(
    (await walkBundle(dir, false)).map((f) => f.archivePath),
    [".Carton/x", ".SCRATCH/Views/v.tsx", ".scratch/notes.md", "Cache/x"],
  );
});
