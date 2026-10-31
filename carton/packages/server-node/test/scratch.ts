import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Test data goes under CARTON_SCRATCH when set (the shared dev box keeps /tmp small), else the OS temp dir.
export function scratch(name: string): string {
  const root = join(process.env.CARTON_SCRATCH ?? tmpdir(), "server-node-tests");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, name + "-"));
}
