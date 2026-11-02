// What the watch page reads besides the Published cut (review R2-1): its name, only the media its document uses, and
// its source for the newer-edits count. Publishing writes it; every open of the editor checks it is there before a
// watch link is given out, so a publication made before the file existed, or one whose upload was cut off, still
// gets a link that opens (review R3-3). Idempotent: an existing file is kept, a failed write is retried next time.

import type { CutRecord, Doc } from "@carton/core";
import { publishedSource, watchKey, type ProjectDescriptor, type WatchDescriptor } from "./descriptor.ts";

export interface WatchFileIo {
  read(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  checkout(cut: string): Promise<Doc>;
  /** This browser's memory of files already known to be there (saves a request per publication per open). */
  keys: { get(k: string): string | null; set(k: string, v: string): void };
}

export function watchDescriptorFor(rec: CutRecord, doc: Doc, project: Pick<ProjectDescriptor, "name" | "media">): WatchDescriptor {
  const used = new Set(((doc.timelineItems ?? []) as { mediaItemId?: string }[]).map((r) => r.mediaItemId).filter((x): x is string => !!x));
  const source = publishedSource(rec);
  return { v: 1, name: String(doc.name ?? project.name), media: Object.fromEntries(Object.entries(project.media).filter(([id]) => used.has(id))), ...(source ? { source } : {}) };
}

export async function ensureWatchFile(rec: CutRecord, project: Pick<ProjectDescriptor, "name" | "media">, io: WatchFileIo): Promise<void> {
  const mark = `carton.watchfile.${rec.id}`;
  if (io.keys.get(mark)) return;
  if (!(await io.read(watchKey(rec.id)))) {
    const watch = watchDescriptorFor(rec, await io.checkout(rec.id), project);
    await io.put(watchKey(rec.id), new TextEncoder().encode(JSON.stringify(watch)), "application/json");
  }
  io.keys.set(mark, "1");
}
