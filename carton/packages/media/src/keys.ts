// Where media lives in a BlobStore. Each object is named by its own content hash, so identical files share one object
// (whole-file dedup within whatever namespace the store is: a team's bucket or prefix).
//
//   m/<hash>                  the bytes
//   mf/<hash>                 the leaf manifest (written before the bytes are completed, so whoever sees m/<hash>
//                             can always verify it)
//   px/<sourceHash>/<profile> which proxy was made from a source with a profile (JSON, see ProxyPointer). Lets a
//                             teammate find, and reuse, a proxy someone already made instead of encoding it again.
//   ps/<stream>/init          a segmented proxy (e2e S5-1): its init segment, then one entry per media segment, then the
//   ps/<stream>/s/<000000>    end marker. Each is small JSON written once (ifAbsent) after the segment's bytes are up as
//   ps/<stream>/end           m/<hash>, so the list only grows and readers never see an entry without its bytes.
//   bad/<hash or stream>      a reader found bytes that never verify there (e2e S5-5): the next upload of that media
//                             replaces the object instead of deduping on it.
//
// Originals and T1 files are one object each (multipart). Collab proxies are segmented, so a teammate can play the
// first segments while the rest are still being encoded and uploaded: a multipart object is invisible until complete.

import { isMediaHash } from "./bytes.ts";

function check(hash: string): string {
  if (!isMediaHash(hash)) throw new TypeError(`not a media hash: ${hash}`);
  return hash;
}

export const mediaKey = (hash: string): string => `m/${check(hash)}`;
export const manifestKey = (hash: string): string => `mf/${check(hash)}`;
export function proxyPointerKey(sourceHash: string, profileId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profileId)) throw new TypeError(`bad proxy profile id: ${profileId}`);
  return `px/${check(sourceHash)}/${profileId}`;
}
/** Stream ids are random 64-hex strings, so they share the media hash's syntax (and the range server's URL form). */
export const streamInitKey = (stream: string): string => `ps/${check(stream)}/init`;
export const streamSegmentKey = (stream: string, index: number): string => {
  if (!Number.isSafeInteger(index) || index < 0 || index > 999_999) throw new RangeError(`bad segment index ${index}`);
  return `ps/${check(stream)}/s/${String(index).padStart(6, "0")}`;
};
export const streamEndKey = (stream: string): string => `ps/${check(stream)}/end`;
export const damagedKey = (hashOrStream: string): string => `bad/${check(hashOrStream)}`;

/** A whole-object proxy (one m/<hash>), or a segmented one (a stream). */
export type ProxyPointer =
  | { hash: string; size: number; encoder: string }
  | { stream: string; encoder: string; at: number };
