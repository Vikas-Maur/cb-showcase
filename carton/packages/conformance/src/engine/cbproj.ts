// `.cbproj` export walk (PLAN §16 H11, R5-03, R6-02), as the engine suite's R5-03/R6-02 test needs it (port of core-v5
// `cbproj.mjs`; the shipping one is `@carton/local`'s). Mirrors Cardboard 1.4.0's walk `iS`
// (_inspect/pretty/chunk-LL26E55H.mjs:6283-6296): every bundle file except the top-level names in
// nS = {cache, converted, proxies, .revs} and top-level `.*.tmp`, plus `project.json` written separately as the manifest.
// Carton adds `.carton` to the top-level set, and `.scratch/views` as a nested-path check (nS is compared with top-level
// names only, so adding ".scratch/views" to it would not exclude anything). The shallow export is its own entry.
// Zip: stored (Cardboard uses compress:false), UTF-8 names, no zip64 (fine for these test bundles). Zero dependencies.
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import type { ShallowExport } from "@carton/core";

// port: Takes was renamed Carton (PLAN v14 §0.1): `.takes/` is `.carton/`, `takes-shallow.json` is `carton-shallow.json`.
export const TOP_EXCLUDED = new Set(["cache", "converted", "proxies", ".revs", ".carton"]);
export const NESTED_EXCLUDED = [".scratch/views"];
export const SHALLOW_ENTRY = "carton-shallow.json";
const MANIFEST = "project.json";
const nestedExcluded = (rel: string) => NESTED_EXCLUDED.some((p) => rel === p || rel.startsWith(p + "/"));

export async function walkBundle(dir: string): Promise<{ archivePath: string; sourcePath: string; size: number }[]> {
  const out: { archivePath: string; sourcePath: string; size: number }[] = [];
  const rec = async (abs: string, rel: string) => {
    for (const d of await readdir(abs, { withFileTypes: true })) {
      const top = rel === "";
      if (top && (TOP_EXCLUDED.has(d.name) || d.name === MANIFEST)) continue;
      if (top && d.name.startsWith(".") && d.name.endsWith(".tmp")) continue;
      const r = top ? d.name : `${rel}/${d.name}`;
      if (nestedExcluded(r)) continue;
      if (d.isDirectory()) await rec(join(abs, d.name), r);
      else if (d.isFile()) out.push({ archivePath: r, sourcePath: join(abs, d.name), size: (await stat(join(abs, d.name))).size });
    }
  };
  await rec(dir, "");
  return out;
}

export function zip(entries: readonly { name: string; data: string | Buffer }[]): Buffer {
  const parts: Buffer[] = [],
    central: Buffer[] = [];
  let off = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name, "utf8"),
      body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const crc = crc32(body) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(body.length, 22);
    h.writeUInt16LE(n.length, 26);
    h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(body.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(off, 42);
    parts.push(h, n, body);
    central.push(c, n);
    off += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(entries.length, 8);
  e.writeUInt16LE(entries.length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

export function unzip(buf: Buffer): Map<string, Buffer> {
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(i + 10),
    cdOff = buf.readUInt32LE(i + 16);
  const out = new Map<string, Buffer>();
  let p = cdOff;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const size = buf.readUInt32LE(p + 20),
      nl = buf.readUInt16LE(p + 28),
      xl = buf.readUInt16LE(p + 30),
      cl = buf.readUInt16LE(p + 32),
      lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    const lnl = buf.readUInt16LE(lho + 26),
      lxl = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnl + lxl;
    out.set(name, buf.subarray(start, start + size));
    p += 46 + nl + xl + cl;
  }
  return out;
}

/** Save As: manifest (project.json in 1.4.0's .cbproj format), the walked bundle files, and the shallow export as its own entry. */
export async function exportCbproj(bundleDir: string, outPath: string, { project, media = [], shallow = null }: { project: unknown; media?: unknown[]; shallow?: ShallowExport | null }) {
  const files = await walkBundle(bundleDir);
  const entries: { name: string; data: string | Buffer }[] = [{ name: MANIFEST, data: JSON.stringify({ format: "cardboard-project", version: 1, project, media }) }];
  for (const f of files) entries.push({ name: f.archivePath, data: await readFile(f.sourcePath) });
  if (shallow) entries.push({ name: SHALLOW_ENTRY, data: JSON.stringify(shallow) });
  const buf = zip(entries);
  await writeFile(outPath, buf);
  return { path: outPath, size: buf.length, entries: entries.map((e) => e.name) };
}

/**
 * Open: the manifest, the shallow export, and the bundle files. View files are never applied: a sender's
 * `.scratch/views/*` carry header refs to pins the recipient doesn't have.
 */
export async function importCbproj(zipPath: string) {
  const m = unzip(await readFile(zipPath));
  const manifest: unknown = JSON.parse(m.get(MANIFEST)!.toString("utf8"));
  const shallow: ShallowExport | null = m.has(SHALLOW_ENTRY) ? JSON.parse(m.get(SHALLOW_ENTRY)!.toString("utf8")) : null;
  const files: string[] = [],
    ignoredViews: string[] = [];
  for (const name of m.keys()) {
    if (name === MANIFEST || name === SHALLOW_ENTRY) continue;
    if (nestedExcluded(name) || name.startsWith(".carton/")) ignoredViews.push(name);
    else files.push(name);
  }
  return { manifest, shallow, files, ignoredViews, entries: [...m.keys()] };
}
