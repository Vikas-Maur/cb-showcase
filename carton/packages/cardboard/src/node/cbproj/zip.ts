// The `.cbproj` container (PLAN §13, §16 H11): a zero-dependency streaming ZIP writer and reader that interoperate with
// Cardboard 1.4.0, which writes `.cbproj` with yazl and reads it with yauzl.
//
// What Cardboard's reader requires, and so what the writer produces:
//   - every member STORED (method 0): it refuses any other method ("Project file has a compressed member");
//   - names it accepts (`sanitizeEntryName`), in UTF-8 (flag 0x0800);
//   - zip64 records once a size or an offset reaches 4 GiB, as yazl writes them.
//
// The writer never holds a whole member in memory: a media file is streamed in 1 MiB chunks through zlib.crc32. It
// writes no data descriptors either: each local header is written with the size from the file's stat, and its CRC is
// patched in place once the data is copied. So every header is complete, and any unzip can read the result.
//
// The reader takes sizes and CRCs from the central directory, as yauzl does: yazl leaves zeros in the local header of
// every file it streams and puts the real values in a data descriptor. It finds a member's data from that member's own
// local header, whose extra field may differ in length from the central one (yazl writes a timestamp in one only).
import fsp from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { retryBusy } from "../displace.ts";

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const EOCD_SIZE = 22;
const ZIP64_EOCD_SIZE = 56;
const ZIP64_LOCATOR_SIZE = 20;
/** The end-of-central-directory record is the last 22 bytes, followed only by a comment of at most 65,535. */
const EOCD_SEARCH = EOCD_SIZE + 0xffff;

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const STORED = 0;
const EXTRA_ZIP64 = 0x0001;
const EXTRA_UNICODE_PATH = 0x7075;
/** 2.0 is what yazl declares for stored members; zip64 needs 4.5. */
const VERSION_STORED = 20;
const VERSION_ZIP64 = 45;
/** Made by "Unix", so the external attributes below are read as a file mode and Info-ZIP restores rw-r--r--. */
const MADE_BY = (3 << 8) | VERSION_ZIP64;
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;
/** A fixed DOS date, 1980-01-01 00:00:00: the archive's bytes then depend only on its contents. */
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;
const CHUNK = 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------- names

// Cardboard's importer joins each member name onto the new bundle's path, so it refuses names that could land outside
// it: one with a backslash or a NUL, or starting with "/"; then it splits on "/", drops empty and "." segments, and
// refuses an empty result or any "..". yauzl, which hands it the names, also refuses a leading drive letter ("C:x").
// We check the drive letter on the first segment rather than the raw name, so "./C:x" is refused too: on Windows,
// path.join turns that segment into a drive-relative path.
function nameSegments(name: string): string[] | null {
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/")) return null;
  const segments = name.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.includes("..") || /^[a-zA-Z]:/.test(segments[0])) return null;
  return segments;
}

/** The canonical `/`-separated form of a member name, or null if Cardboard would refuse to extract it. */
export function sanitizeEntryName(name: string): string | null {
  const segments = nameSegments(name);
  return segments === null ? null : segments.join("/");
}

/** Where a member lands relative to the bundle, joined with the platform separator as Cardboard joins it; or null. */
export function safeEntryPath(name: string): string | null {
  const segments = nameSegments(name);
  return segments === null ? null : path.join(...segments);
}

// yauzl decodes a name without the UTF-8 flag (and without an Info-ZIP Unicode Path field) as IBM code page 437,
// including its graphic characters for 0x01–0x1F. We decode the same way, so both readers see the same names.
const CP437 = Array.from(
  "\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼" +
    " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂" +
    "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
    "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ",
);

function decodeCp437(raw: Uint8Array): string {
  let s = "";
  for (const byte of raw) s += CP437[byte];
  return s;
}

// ------------------------------------------------------------------------------------------------------- helpers

const damaged = (what: string): Error => new Error(`Project file is damaged: ${what}`);

function readU64(b: Buffer, at: number): number {
  const hi = b.readUInt32LE(at + 4);
  if (hi >= 0x200000) throw damaged("a 64-bit size or offset is beyond 2^53"); // not exactly representable as a number
  return hi * 0x100000000 + b.readUInt32LE(at);
}

function writeU64(b: Buffer, value: number, at: number): void {
  b.writeUInt32LE(value >>> 0, at);
  b.writeUInt32LE(Math.floor(value / 0x100000000), at + 4);
}

async function readExact(fh: FileHandle, length: number, position: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length);
  for (let done = 0; done < length; ) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw damaged("it ends early");
    done += bytesRead;
  }
  return buf;
}

async function writeExact(fh: FileHandle, data: Uint8Array, position: number): Promise<void> {
  for (let done = 0; done < data.byteLength; ) {
    const { bytesWritten } = await fh.write(data, done, data.byteLength - done, position + done);
    done += bytesWritten;
  }
}

// Copies `size` bytes of `src`, starting at `from`, to `write` in 1 MiB chunks, reading the next chunk while the
// current one is written (yazl and yauzl pipe streams, which overlap the two the same way). Stops early at the end of
// the file; the caller compares `copied` with what it expected.
async function copyChunks(
  src: FileHandle,
  from: number,
  size: number,
  write: (chunk: Buffer) => Promise<void>,
): Promise<{ copied: number; crc: number }> {
  let crc = 0;
  let copied = 0;
  let buf = Buffer.allocUnsafe(Math.min(CHUNK, size));
  let spare = Buffer.allocUnsafe(buf.length);
  const readAt = (into: Buffer, done: number) => src.read(into, 0, Math.min(into.length, size - done), from + done);
  let next = size > 0 ? readAt(buf, 0) : null;
  try {
    while (next !== null) {
      const { bytesRead } = await next;
      next = null;
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      copied += bytesRead;
      const filled = buf;
      buf = spare;
      spare = filled;
      if (copied < size) next = readAt(buf, copied);
      crc = zlib.crc32(chunk, crc);
      await write(chunk);
    }
  } finally {
    // Never leave a read in flight on a handle the caller is about to close.
    await next?.catch(() => undefined);
  }
  return { copied, crc };
}

// Windows reports a file that another process holds open (an antivirus scan, the search indexer) as busy, and rename
// fails with EPERM, EBUSY or EACCES until the holder lets go: `retryBusy` waits that out on timers (5 s in all, Windows
// only; on Linux and macOS these codes mean a real permission error and fail at once).
const renameRetry = (from: string, to: string): Promise<void> => retryBusy(() => fsp.rename(from, to));

// -------------------------------------------------------------------------------------------------------- writer

interface Member {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  zip64: boolean;
}

export interface ZipWriterOptions {
  /**
   * Test only: the size or offset from which zip64 records are used, 0xFFFFFFFF by default. A small value exercises
   * the zip64 path without writing 4 GiB.
   */
  zip64Threshold?: number;
}

export interface ZipWriteResult {
  path: string;
  /** Bytes in the finished archive. */
  size: number;
  entries: number;
}

// A local header: sizes are known before the data is written (from the buffer, or from the file's stat, checked
// after the copy), only the CRC of a streamed file is patched afterwards. A zip64 local header must carry both sizes in
// its 0x0001 extra field, with 0xFFFFFFFF in the fixed fields.
function localHeader(name: Buffer, crc: number, size: number, zip64: boolean): Buffer {
  const extraLength = zip64 ? 4 + 16 : 0;
  const b = Buffer.alloc(LOCAL_SIZE + name.length + extraLength);
  b.writeUInt32LE(SIG_LOCAL, 0);
  b.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION_STORED, 4);
  b.writeUInt16LE(FLAG_UTF8, 6);
  b.writeUInt16LE(STORED, 8);
  b.writeUInt16LE(DOS_TIME, 10);
  b.writeUInt16LE(DOS_DATE, 12);
  b.writeUInt32LE(crc, 14);
  b.writeUInt32LE(zip64 ? U32_MAX : size, 18); // compressed size: stored, so the same
  b.writeUInt32LE(zip64 ? U32_MAX : size, 22);
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(extraLength, 28);
  name.copy(b, LOCAL_SIZE);
  if (zip64) {
    const at = LOCAL_SIZE + name.length;
    b.writeUInt16LE(EXTRA_ZIP64, at);
    b.writeUInt16LE(16, at + 2);
    writeU64(b, size, at + 4);
    writeU64(b, size, at + 12);
  }
  return b;
}

// A central header. A zip64 member puts all three of its sizes and its offset in the extra field, as yazl does: the
// fields a reader finds there are exactly those whose fixed value is 0xFFFFFFFF.
function centralHeader(m: Member): Buffer {
  const extraLength = m.zip64 ? 4 + 24 : 0;
  const b = Buffer.alloc(CENTRAL_SIZE + m.name.length + extraLength);
  b.writeUInt32LE(SIG_CENTRAL, 0);
  b.writeUInt16LE(MADE_BY, 4);
  b.writeUInt16LE(m.zip64 ? VERSION_ZIP64 : VERSION_STORED, 6);
  b.writeUInt16LE(FLAG_UTF8, 8);
  b.writeUInt16LE(STORED, 10);
  b.writeUInt16LE(DOS_TIME, 12);
  b.writeUInt16LE(DOS_DATE, 14);
  b.writeUInt32LE(m.crc, 16);
  b.writeUInt32LE(m.zip64 ? U32_MAX : m.size, 20);
  b.writeUInt32LE(m.zip64 ? U32_MAX : m.size, 24);
  b.writeUInt16LE(m.name.length, 28);
  b.writeUInt16LE(extraLength, 30);
  // 32: comment length, 34: disk number start, 36: internal attributes, all 0
  b.writeUInt32LE(EXTERNAL_ATTRS, 38);
  b.writeUInt32LE(m.zip64 ? U32_MAX : m.offset, 42);
  m.name.copy(b, CENTRAL_SIZE);
  if (m.zip64) {
    const at = CENTRAL_SIZE + m.name.length;
    b.writeUInt16LE(EXTRA_ZIP64, at);
    b.writeUInt16LE(24, at + 2);
    writeU64(b, m.size, at + 4);
    writeU64(b, m.size, at + 12);
    writeU64(b, m.offset, at + 20);
  }
  return b;
}

/**
 * Writes a `.cbproj` (or any stored zip) to `<path>.part`, renamed to `path` by `close()`. Members are written one
 * after another; a call made before the previous one settles waits for it.
 */
export class ZipWriter {
  /** Called with the archive's size so far, after each chunk. */
  onProgress?: (written: number) => void;

  private readonly fh: FileHandle;
  private readonly target: string;
  private readonly part: string;
  private readonly zip64At: number;
  private readonly members: Member[] = [];
  private readonly names = new Set<string>();
  private pos = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private state: "open" | "closed" | "aborted" = "open";

  private constructor(fh: FileHandle, target: string, part: string, zip64At: number) {
    this.fh = fh;
    this.target = target;
    this.part = part;
    this.zip64At = zip64At;
  }

  static async create(file: string, options: ZipWriterOptions = {}): Promise<ZipWriter> {
    const part = `${file}.part`;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const fh = await fsp.open(part, "w");
    return new ZipWriter(fh, file, part, options.zip64Threshold ?? U32_MAX);
  }

  /** Adds a member holding `data`. */
  addBuffer(name: string, data: Uint8Array): Promise<void> {
    return this.serial(async () => {
      const nameBytes = this.checkName(name);
      const offset = this.pos;
      const size = data.byteLength;
      const zip64 = size >= this.zip64At || offset >= this.zip64At;
      const crc = zlib.crc32(data);
      try {
        await this.put(localHeader(nameBytes, crc, size, zip64));
        await this.put(data);
      } catch (e) {
        this.pos = offset; // see addFile
        throw e;
      }
      this.names.add(name);
      this.members.push({ name: nameBytes, crc, size, offset, zip64 });
      this.onProgress?.(this.pos);
    });
  }

  /**
   * Adds a member holding the file at `sourcePath`, streamed. Throws if the file changes while it is copied (its size
   * or modification time moves); the archive then holds nothing of it, and other members can still be added.
   */
  addFile(name: string, sourcePath: string): Promise<void> {
    return this.serial(async () => {
      const nameBytes = this.checkName(name);
      // Stat before opening: opening a FIFO for reading would block until something writes to it.
      if (!(await fsp.stat(sourcePath)).isFile()) throw new Error(`Not a regular file: ${sourcePath}`);
      const changed = (): Error => new Error(`File changed while it was being saved: ${sourcePath}`);
      const src = await fsp.open(sourcePath, "r");
      const offset = this.pos;
      try {
        const before = await src.stat({ bigint: true });
        const size = Number(before.size);
        const zip64 = size >= this.zip64At || offset >= this.zip64At;
        await this.put(localHeader(nameBytes, 0, size, zip64));
        const { copied, crc } = await copyChunks(src, 0, size, async (chunk) => {
          if (this.state === "aborted") throw new Error("ZipWriter was aborted");
          await this.put(chunk);
          this.onProgress?.(this.pos);
        });
        // Shorter than its stat said, or one more byte past the end: the file was truncated or grew meanwhile.
        if (copied !== size || (await src.read(Buffer.alloc(1), 0, 1, size)).bytesRead !== 0) throw changed();
        const after = await src.stat({ bigint: true });
        if (after.size !== before.size || after.mtimeNs !== before.mtimeNs) throw changed();
        const patch = Buffer.alloc(4);
        patch.writeUInt32LE(crc, 0);
        await writeExact(this.fh, patch, offset + 14);
        this.names.add(name);
        this.members.push({ name: nameBytes, crc, size, offset, zip64 });
      } catch (e) {
        // Forget the half-written member: the next one overwrites its bytes, and close() truncates any left over.
        this.pos = offset;
        throw e;
      } finally {
        await src.close();
      }
    });
  }

  /** Writes the central directory and moves the archive to its final path. */
  close(): Promise<ZipWriteResult> {
    return this.serial(async () => {
      try {
        await this.writeCentralDirectory();
        await this.fh.truncate(this.pos);
        await this.fh.close();
        if (this.state !== "open") throw new Error("ZipWriter was aborted");
        await renameRetry(this.part, this.target);
      } catch (e) {
        this.state = "aborted";
        await this.discard();
        throw e;
      }
      this.state = "closed";
      this.onProgress?.(this.pos);
      return { path: this.target, size: this.pos, entries: this.members.length };
    });
  }

  /** Stops (a member being copied stops at its next chunk) and deletes the partial archive. Safe to call twice. */
  async abort(): Promise<void> {
    if (this.state !== "open") return;
    this.state = "aborted";
    await this.queue;
    await this.discard();
  }

  private async discard(): Promise<void> {
    await this.fh.close().catch(() => undefined); // may already be closed
    await fsp.rm(this.part, { force: true });
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      if (this.state !== "open") throw new Error(`ZipWriter is ${this.state}`);
      return op();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  // Only canonical names are written ("a/b", never "a//b", "./a" or "a/"), so a duplicate is an exact duplicate.
  private checkName(name: string): Buffer {
    if (sanitizeEntryName(name) !== name) throw new Error(`Unsafe or non-canonical member name: ${JSON.stringify(name)}`);
    if (this.names.has(name)) throw new Error(`Duplicate member name: ${name}`);
    const bytes = Buffer.from(name, "utf8");
    if (bytes.length > U16_MAX) throw new Error(`Member name is longer than 65,535 bytes: ${name.slice(0, 80)}…`);
    return bytes;
  }

  private async put(data: Uint8Array): Promise<void> {
    await writeExact(this.fh, data, this.pos);
    this.pos += data.byteLength;
  }

  private async writeCentralDirectory(): Promise<void> {
    const cdOffset = this.pos;
    let batch: Buffer[] = [];
    let batched = 0;
    for (const m of this.members) {
      const header = centralHeader(m);
      batch.push(header);
      batched += header.length;
      if (batched >= CHUNK) {
        await this.put(Buffer.concat(batch, batched));
        batch = [];
        batched = 0;
      }
    }
    if (batched > 0) await this.put(Buffer.concat(batch, batched));
    const cdSize = this.pos - cdOffset;
    const count = this.members.length;
    // 0xFFFF entries already needs zip64: in the 16-bit field that value means "see the zip64 record".
    const zip64 = count >= U16_MAX || cdSize >= this.zip64At || cdOffset >= this.zip64At;
    if (zip64) {
      const recordAt = this.pos;
      const b = Buffer.alloc(ZIP64_EOCD_SIZE + ZIP64_LOCATOR_SIZE);
      b.writeUInt32LE(SIG_ZIP64_EOCD, 0);
      writeU64(b, ZIP64_EOCD_SIZE - 12, 4); // size of the rest of the record
      b.writeUInt16LE(MADE_BY, 12);
      b.writeUInt16LE(VERSION_ZIP64, 14);
      // 16: this disk, 20: the central directory's disk, both 0
      writeU64(b, count, 24);
      writeU64(b, count, 32);
      writeU64(b, cdSize, 40);
      writeU64(b, cdOffset, 48);
      const loc = ZIP64_EOCD_SIZE;
      b.writeUInt32LE(SIG_ZIP64_LOCATOR, loc);
      // loc + 4: the zip64 record's disk, 0
      writeU64(b, recordAt, loc + 8);
      b.writeUInt32LE(1, loc + 16); // disks in all
      await this.put(b);
    }
    // With zip64, every field points at the zip64 record, as yazl writes it.
    const b = Buffer.alloc(EOCD_SIZE);
    b.writeUInt32LE(SIG_EOCD, 0);
    // 4: this disk, 6: the central directory's disk, both 0
    b.writeUInt16LE(zip64 ? U16_MAX : count, 8);
    b.writeUInt16LE(zip64 ? U16_MAX : count, 10);
    b.writeUInt32LE(zip64 ? U32_MAX : cdSize, 12);
    b.writeUInt32LE(zip64 ? U32_MAX : cdOffset, 16);
    // 20: comment length, 0
    await this.put(b);
  }
}

// -------------------------------------------------------------------------------------------------------- reader

export interface ZipEntry {
  /** The name as stored, decoded as yauzl decodes it. */
  readonly name: string;
  /** Uncompressed size in bytes. */
  readonly size: number;
  readonly compressedSize: number;
  /** 0 is stored; Cardboard refuses any other. */
  readonly method: number;
  readonly crc32: number;
  /** Where the member's local header starts. */
  readonly offset: number;
  /** General-purpose flags (0x0001 encrypted, 0x0008 data descriptor, 0x0800 UTF-8 name). */
  readonly flags: number;
}

function decodeName(raw: Buffer, flags: number, unicodePath: string | null): string {
  if (unicodePath !== null) return unicodePath;
  return flags & FLAG_UTF8 ? raw.toString("utf8") : decodeCp437(raw);
}

async function readCentralDirectory(fh: FileHandle, fileSize: number): Promise<ZipEntry[]> {
  const tailLength = Math.min(fileSize, EOCD_SEARCH);
  const tailAt = fileSize - tailLength;
  const tail = await readExact(fh, tailLength, tailAt);
  // Scan back for the record whose comment runs exactly to the end of the file: a comment may itself contain the
  // signature.
  let eocd = -1;
  for (let i = tailLength - EOCD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD && i + EOCD_SIZE + tail.readUInt16LE(i + 20) === tailLength) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file: no end of central directory record");

  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  let cdEnd = tailAt + eocd; // the central directory ends where the (zip64) end record starts
  if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    const locatorAt = tailAt + eocd - ZIP64_LOCATOR_SIZE;
    if (locatorAt < 0) throw damaged("zip64 end record locator missing");
    const locator = await readExact(fh, ZIP64_LOCATOR_SIZE, locatorAt);
    if (locator.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) throw damaged("zip64 end record locator missing");
    const recordAt = readU64(locator, 8);
    if (recordAt + ZIP64_EOCD_SIZE > locatorAt) throw damaged("zip64 end record out of place");
    const record = await readExact(fh, ZIP64_EOCD_SIZE, recordAt);
    if (record.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw damaged("zip64 end record missing");
    if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) throw new Error("Multi-disk zip files are not supported");
    count = readU64(record, 32);
    cdSize = readU64(record, 40);
    cdOffset = readU64(record, 48);
    cdEnd = recordAt;
  } else if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
    throw new Error("Multi-disk zip files are not supported");
  }
  if (cdOffset + cdSize > cdEnd) throw damaged("central directory out of place");

  const cd = await readExact(fh, cdSize, cdOffset);
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + CENTRAL_SIZE > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw damaged("central directory entry");
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc32 = cd.readUInt32LE(p + 16);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const nameAt = p + CENTRAL_SIZE;
    const extraAt = nameAt + nameLength;
    p = extraAt + extraLength + commentLength;
    if (p > cd.length) throw damaged("central directory entry");
    const raw = cd.subarray(nameAt, extraAt);
    const extra = cd.subarray(extraAt, extraAt + extraLength);

    // Extra fields, read as yauzl reads them: the first zip64 field supplies, in order, each value whose fixed field
    // is 0xFFFFFFFF; an Info-ZIP Unicode Path field (version 1) gives the name if it was made from these name bytes.
    let unicodePath: string | null = null;
    let zip64Seen = false;
    for (let q = 0; q + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(q);
      const length = extra.readUInt16LE(q + 2);
      if (q + 4 + length > extra.length) throw damaged("extra field");
      const data = extra.subarray(q + 4, q + 4 + length);
      q += 4 + length;
      if (id === EXTRA_ZIP64 && !zip64Seen) {
        zip64Seen = true;
        let d = 0;
        const next = (what: string): number => {
          if (d + 8 > data.length) throw damaged(`zip64 field without the ${what}`);
          d += 8;
          return readU64(data, d - 8);
        };
        if (size === U32_MAX) size = next("size");
        if (compressedSize === U32_MAX) compressedSize = next("compressed size");
        if (offset === U32_MAX) offset = next("header offset");
      } else if (id === EXTRA_UNICODE_PATH && unicodePath === null) {
        if (data.length >= 6 && data[0] === 1 && data.readUInt32LE(1) === zlib.crc32(raw)) {
          unicodePath = data.subarray(5).toString("utf8");
        }
      }
    }

    const name = decodeName(raw, flags, unicodePath);
    // yauzl refuses the whole file when a stored member's two sizes disagree (12 bytes of an encryption header aside).
    if (method === STORED && compressedSize !== size + (flags & FLAG_ENCRYPTED ? 12 : 0)) {
      throw damaged(`sizes of ${name} disagree`);
    }
    // Two members with one name would let two readers disagree about which is real; Cardboard's importer fails on
    // the second (it creates every file with "wx").
    if (seen.has(name)) throw new Error(`Project file has a duplicate member: ${name}`);
    seen.add(name);
    entries.push({ name, size, compressedSize, method, crc32, offset, flags });
  }
  return entries;
}

/** Reads a `.cbproj` (or any zip) from its central directory. Members are read or extracted one by one. */
export class ZipReader {
  readonly path: string;
  readonly entries: ReadonlyArray<ZipEntry>;

  private readonly fh: FileHandle;
  private readonly fileSize: number;
  private readonly byName: Map<string, ZipEntry>;
  private closed = false;

  private constructor(fh: FileHandle, file: string, fileSize: number, entries: ZipEntry[]) {
    this.fh = fh;
    this.path = file;
    this.fileSize = fileSize;
    this.entries = entries;
    this.byName = new Map(entries.map((e) => [e.name, e]));
  }

  static async open(file: string): Promise<ZipReader> {
    const fh = await fsp.open(file, "r");
    try {
      const { size } = await fh.stat();
      return new ZipReader(fh, file, size, await readCentralDirectory(fh, size));
    } catch (e) {
      await fh.close().catch(() => undefined);
      throw e;
    }
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** A member's bytes, CRC-checked. Throws if it is larger than `maxBytes` (Cardboard caps project.json at 64 MiB). */
  async readEntry(name: string, maxBytes = Infinity): Promise<Buffer> {
    const entry = this.readable(name);
    if (entry.size > maxBytes) throw new Error(`Project file has an oversized ${name}`);
    const data = await readExact(this.fh, entry.size, await this.dataStart(entry));
    if (zlib.crc32(data) !== entry.crc32) throw damaged(`CRC-32 mismatch in ${name}`);
    return data;
  }

  /**
   * A member's bytes by its entry, whatever its name: to tell what it is (a member 1.4.0's importer extracts under a
   * name this reader won't extract, `.scratch\views\x.tsx`), never to extract it. Stored and unencrypted only, as
   * every read here; CRC-checked.
   */
  async readMember(entry: ZipEntry, maxBytes = Infinity): Promise<Buffer> {
    if (entry.method !== STORED) throw new Error(`Project file has a compressed member: ${entry.name}`);
    if (entry.flags & FLAG_ENCRYPTED) throw new Error(`Project file has an encrypted member: ${entry.name}`);
    if (entry.size > maxBytes) throw new Error(`Project file has an oversized ${entry.name}`);
    const data = await readExact(this.fh, entry.size, await this.dataStart(entry));
    if (zlib.crc32(data) !== entry.crc32) throw damaged(`CRC-32 mismatch in ${entry.name}`);
    return data;
  }

  /**
   * The first `n` bytes of a stored member, to tell what it is by its head (a view's `// cardboard:rev` line), whatever
   * its size. Not CRC-checked: the rest isn't read (a member kept is checked whole when it is extracted).
   */
  async readMemberHead(entry: ZipEntry, n: number): Promise<Buffer> {
    if (entry.method !== STORED) throw new Error(`Project file has a compressed member: ${entry.name}`);
    if (entry.flags & FLAG_ENCRYPTED) throw new Error(`Project file has an encrypted member: ${entry.name}`);
    return readExact(this.fh, Math.min(entry.size, n), await this.dataStart(entry));
  }

  /**
   * Streams a member to `destPath` (replacing it), through `<destPath>.part` so the file appears only whole and
   * CRC-checked.
   */
  async extractEntry(name: string, destPath: string): Promise<void> {
    const entry = this.readable(name);
    const start = await this.dataStart(entry);
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    const part = `${destPath}.part`;
    const out = await fsp.open(part, "w");
    try {
      let written = 0;
      const { copied, crc } = await copyChunks(this.fh, start, entry.size, async (chunk) => {
        await writeExact(out, chunk, written);
        written += chunk.length;
      });
      if (copied !== entry.size) throw damaged(`${name} ends early`);
      if (crc !== entry.crc32) throw damaged(`CRC-32 mismatch in ${name}`);
      await out.close();
      await renameRetry(part, destPath);
    } catch (e) {
      await out.close().catch(() => undefined); // may already be closed
      await fsp.rm(part, { force: true });
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.fh.close();
  }

  // The checks Cardboard makes before it reads a member.
  private readable(name: string): ZipEntry {
    const entry = this.byName.get(name);
    if (!entry) throw new Error(`Project file has no member ${name}`);
    if (nameSegments(entry.name) === null) throw new Error(`Project file has an unsafe member: ${name}`);
    if (entry.method !== STORED) throw new Error(`Project file has a compressed member: ${name}`);
    if (entry.flags & FLAG_ENCRYPTED) throw new Error(`Project file has an encrypted member: ${name}`);
    return entry;
  }

  // The data follows the member's own local header, whose name and extra field lengths are its own.
  private async dataStart(entry: ZipEntry): Promise<number> {
    const header = await readExact(this.fh, LOCAL_SIZE, entry.offset);
    if (header.readUInt32LE(0) !== SIG_LOCAL) throw damaged(`no local header for ${entry.name}`);
    const start = entry.offset + LOCAL_SIZE + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (start + entry.compressedSize > this.fileSize) throw damaged(`${entry.name} runs past the end of the file`);
    return start;
  }
}
