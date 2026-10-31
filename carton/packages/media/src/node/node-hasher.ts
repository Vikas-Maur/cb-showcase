// SHA-256 from node:crypto: about 1.8x WebCrypto's per-core rate on the P6 box [V], so desktop hashes here.

import { createHash } from "node:crypto";
import type { Hasher } from "../contracts.ts";

export function sha256Sync(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

export const nodeHasher: Hasher = {
  async sha256(data) {
    return sha256Sync(data);
  },
};
