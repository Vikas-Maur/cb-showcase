// A file as a ByteSource, for uploads (each part is read into its own buffer, which the upload holds until the part
// is acknowledged). The size is fixed when the file is opened; the upload re-checks every leaf against the manifest.

import { open } from "node:fs/promises";
import type { ByteSource } from "../hash.ts";

export async function fileSource(path: string): Promise<ByteSource & { close(): Promise<void> }> {
  const fh = await open(path, "r");
  let size: number;
  try {
    size = (await fh.stat()).size;
  } catch (e) {
    await fh.close();
    throw e;
  }
  return {
    size,
    async read(offset, length, signal) {
      signal?.throwIfAborted();
      const want = Math.max(0, Math.min(length, size - offset));
      const buf = new Uint8Array(want);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, offset + got);
        if (bytesRead === 0) break; // the file shrank: the caller sees a short read
        got += bytesRead;
      }
      return got === want ? buf : buf.subarray(0, got);
    },
    close: () => fh.close(),
  };
}
