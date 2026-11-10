// Builds the static files the production Worker serves (dist/site): the plain landing page, the cost calculator
// (site/cost/, served at /cost/) and service-worker retirer from ./site, and the changelog from
// apps/web/public/changelog. The calculator's build script and type declarations stay out of dist. The web demo itself (apps/web) isn't served for now;
// `pnpm run deploy:cloudflare:web` (carton/package.json) builds and deploys it in place of this when it's wanted again.
//   node packages/server-cloudflare/build-site.mjs   (from carton/)
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist", "site");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, "site"), out, { recursive: true, filter: (src) => !/(build-data\.mjs|\.d\.ts)$/.test(src) });
cpSync(join(here, "..", "..", "apps", "web", "public", "changelog"), join(out, "changelog"), { recursive: true });
console.log(`built ${out}`);
