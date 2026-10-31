// One store-idb measurement in a fresh headless Chromium on a persistent profile (so the database outlives the
// browser, as it does for a user); prints one JSON line.
// usage: node bench/cell.ts <profile dir> gen <n> <kf items> | open | commit <n> <relaxed|strict> | readlog   (id = "bench-<n>")
import { launchPersistent } from "./launch.ts";

const [profile, mode, ...rest] = process.argv.slice(2);
const { ctx, page, close } = await launchPersistent(profile);
try {
  const api = "/carton/packages/store-idb/bench/page.ts";
  const id = process.env.BENCH_ID ?? "bench";
  const out = await page.evaluate(
    async ({ api, mode, id, rest }: { api: string; mode: string; id: string; rest: string[] }) => {
      const m = await import(api);
      if (mode === "gen") return m.gen(id, Number(rest[0]), Number(rest[1]));
      if (mode === "open") return m.open(id);
      if (mode === "commit") return m.commit(id, Number(rest[0]), rest[1]);
      if (mode === "readlog") return m.readlog(id);
      throw new Error(`unknown mode ${mode}`);
    },
    { api, mode, id, rest },
  );
  console.log(JSON.stringify({ ...out, browser: "chromium-headless" }));
} finally {
  await close();
  void ctx;
}
