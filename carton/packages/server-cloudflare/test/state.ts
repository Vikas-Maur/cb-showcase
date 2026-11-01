import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Where local workerd state goes: CARTON_SCRATCH when set (the shared dev box keeps /tmp small), else this
// package's git-ignored .wrangler/ folder. Never os.tmpdir().
export function stateDir(name: string): string {
  const d = process.env.CARTON_SCRATCH ? join(process.env.CARTON_SCRATCH, "server-cloudflare", name) : join(import.meta.dirname, "..", ".wrangler", "test", name);
  mkdirSync(d, { recursive: true });
  return d;
}
