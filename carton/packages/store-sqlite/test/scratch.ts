// A fresh, empty folder for one test. CARTON_SCRATCH moves test files off a small /tmp (the shared dev box);
// elsewhere the OS temp folder is used.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function scratch(name: string): string {
  const base = process.env.CARTON_SCRATCH || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, `carton-${name}-`));
}
