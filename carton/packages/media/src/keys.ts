// Where media lives in a BlobStore. One object per media variant (PLAN §11): an original and each of its proxies are
// separate objects, each named by its own content hash, so identical files share one object (whole-file dedup within
// whatever namespace the store is: a team's bucket or prefix).
//
//   m/<hash>                  the bytes
//   mf/<hash>                 the leaf manifest (written before the bytes are completed, so whoever sees m/<hash>
//                             can always verify it)
//   px/<sourceHash>/<profile> which proxy was made from a source with a profile: JSON { hash, size, encoder }. Lets a
//                             teammate reuse a proxy someone already encoded instead of encoding it again.

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

export interface ProxyPointer {
  hash: string;
  size: number;
  encoder: string;
}
