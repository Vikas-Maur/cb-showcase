// Test scratch space: never /tmp (a small shared tmpfs on the build box). CARTON_SCRATCH overrides.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function scratch(): string {
  const dir = process.env.CARTON_SCRATCH ?? join(homedir(), "gfv-scratch", "carton", "local-cli", "test");
  mkdirSync(dir, { recursive: true });
  return dir;
}
