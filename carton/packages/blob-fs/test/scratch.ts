import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Test files go under CARTON_SCRATCH (the shared dev box's /tmp is a small tmpfs), else the OS temp dir.
export function scratchDir(): string {
  const d = join(process.env.CARTON_SCRATCH ?? tmpdir(), "blob-fs-tests");
  mkdirSync(d, { recursive: true });
  return d;
}
