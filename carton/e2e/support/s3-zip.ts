// Scenario 3's own look at `.cbproj` files, independent of the adapter's ZipReader/ZipWriter: the member names as the
// central directory lists them (what any unzip, Cardboard 1.4.0's yauzl included, would extract), and a bare stored-zip
// writer for hand-made files that the adapter's writer refuses to make (backslash names, `./` prefixes, aliases).
import { readFileSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Every member name in the zip's central directory, in order (zip64 aware). */
export function zipNames(file: string): string[] {
  const b = readFileSync(file);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (b.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${file}: no end of central directory`);
  let count = b.readUInt16LE(eocd + 10);
  let offset = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const loc = eocd - 20;
    if (b.readUInt32LE(loc) !== ZIP64_LOCATOR) throw new Error(`${file}: zip64 fields without a zip64 locator`);
    const z = Number(b.readBigUInt64LE(loc + 8));
    if (b.readUInt32LE(z) !== ZIP64_EOCD) throw new Error(`${file}: no zip64 end of central directory`);
    count = Number(b.readBigUInt64LE(z + 32));
    offset = Number(b.readBigUInt64LE(z + 48));
  }
  const names: string[] = [];
  for (let p = offset, i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== CENTRAL) throw new Error(`${file}: bad central header #${i}`);
    const n = b.readUInt16LE(p + 28), x = b.readUInt16LE(p + 30), c = b.readUInt16LE(p + 32);
    names.push(b.toString("utf8", p + 46, p + 46 + n));
    p += 46 + n + x + c;
  }
  return names;
}

/** Writes a stored (uncompressed) zip with exactly these member names, UTF-8 flagged. No checks: a hostile sender. */
export function writeRawZip(file: string, members: { name: string; data: string | Uint8Array }[]): void {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;
  for (const m of members) {
    const name = Buffer.from(m.name, "utf8");
    const data = Buffer.from(m.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CENTRAL, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(at, 42);
    parts.push(local, name, data);
    central.push(cen, name);
    at += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(at, 16);
  writeFileSync(file, Buffer.concat([...parts, cd, end]));
}
