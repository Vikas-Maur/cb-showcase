// System conformance (PLAN §6, §12, §15): the 97 system-v11 tests (names kept), H1–H4, and the four v12 rules no
// test pinned (list on the "behind" reject, scan from the oldest pending base, drop before rebase, hello rid claim),
// run against a real sequencer through a Transport. Owner: sync-sequencer.
import type { HostFixture } from "../hosts/index.ts";

const todo = (what: string): never => {
  throw new Error(`not implemented: ${what}`);
};

export function systemSuite(name: string, make: () => Promise<HostFixture>): void {
  todo("systemSuite");
}
