// The free-tier guard's worst case for one laptop run (laptop.ts with its defaults), declared before a self-test on
// this box and when a pack is handed out (the run itself happens on the person's machine, out of the guard's sight).
//
// Per run, at most: 250 edits (60 sync, 10 offline, 150 while uploading, 20 shaped, 10 for a shaped cut), each a push
// and the room's rows (~6 written, ~200 read, as sync.ts counts them); about 30 WebSocket connects; the upload twice
// (a first try that was too slow, then a smaller one) in 8 MiB parts, the dedup check, a 16 MiB MediaReader download
// in growing ranges, each a signed request; one room and the write-cap counter awake for 20 minutes. Rounded up a lot.
import type { Estimate } from "../guard.ts";

export function laptopEstimate(test: string, uploadMB: number, opts: { fromThisBox?: boolean } = {}): Estimate {
  const parts = Math.ceil((uploadMB * 1e6) / (8 << 20));
  return {
    test,
    workersReq: 2000,
    doReq: 3000,
    doRowsWritten: 3000,
    doRowsRead: 60_000,
    doGBs: 300,
    r2ClassA: Math.max(500, 4 * parts + 50),
    r2ClassB: 500,
    r2StoredBytes: uploadMB * 1e6 + 1e6,
    // only what leaves this box counts: a pack's upload goes from the person's network
    uploadBytes: opts.fromThisBox ? uploadMB * 1e6 * 3 : 0,
  };
}
