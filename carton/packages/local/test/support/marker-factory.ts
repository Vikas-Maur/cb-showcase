// real-factory.ts, plus a record of who ran it: each process that opens an engine through it appends its pid to
// `config.marker`, so a test can tell which factory a spawned helper ran.
import { appendFileSync } from "node:fs";
import type { HelperFactoryOptions } from "../../src/helper.ts";
import { createHolderEngine as real } from "./real-factory.ts";

export async function createHolderEngine(o: HelperFactoryOptions) {
  if (typeof o.config.marker === "string") appendFileSync(o.config.marker, `${process.pid}\n`);
  return real(o);
}
