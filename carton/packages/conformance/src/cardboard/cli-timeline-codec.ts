// A `TimelineCodec` backed by Cardboard 1.4.0's own printer and parser, run as the real CLI in a subprocess (tests
// only: each call starts Node). The materializer injects this exactly as the Windows patch injects 1.4.0's functions,
// so a test through it exercises Cardboard's real timeline.tsx on both sides.
//
// Parse is 1.4.0's apply of the file onto a scratch copy of the current project (no `.revs`, so a plain diff against
// it), read back from project.json: what Cardboard itself makes of the file, with unchanged text and code items keeping
// their media. (Applying onto an empty timeline would re-synthesize their media under new ids.)
import fs from "node:fs";
import path from "node:path";
import { setRev, type TimelineCodec } from "@carton/cardboard";
import { CardboardCliError, type CardboardCli } from "./cli-codec.ts";

export function cliTimelineCodec(cli: CardboardCli): TimelineCodec {
  const envelope = (project: Record<string, unknown>) => ({ format: "cardboard-project", version: 1, project, media: [] });
  return {
    async print(project, rev) {
      // the CLI prints its own `// cardboard:rev <stateUpdatedAt>` line; Carton's header takes its place
      return setRev(await cli.print(envelope(project)), `// cardboard:rev ${rev}`);
    },
    async parse(text, project) {
      const bundle = cli.makeBundle(envelope(project));
      try {
        const r = await cli.apply(bundle, text);
        if (!r.applied && r.ops.length) throw new CardboardCliError("Cardboard refused the file", r);
        const env = JSON.parse(fs.readFileSync(path.join(bundle, "project.json"), "utf8")) as { project: Record<string, unknown> };
        return env.project;
      } finally {
        fs.rmSync(path.dirname(bundle), { recursive: true, force: true });
      }
    },
  };
}
