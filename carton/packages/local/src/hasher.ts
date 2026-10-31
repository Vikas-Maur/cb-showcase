// SHA-256 from node:crypto (§3.1 `Hasher`), with the synchronous hex form core uses for state hashes.
import { createHash } from "node:crypto";
import type { Hasher } from "@carton/core/plugins";

export const nodeHasher: Hasher = {
  name: "node:crypto",
  sha256: async (data) => new Uint8Array(createHash("sha256").update(data).digest()),
  sha256HexSync: (text) => createHash("sha256").update(text, "utf8").digest("hex"),
};
