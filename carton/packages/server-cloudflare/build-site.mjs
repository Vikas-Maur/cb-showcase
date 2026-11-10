// Builds the static files the production Worker serves (dist/site): the plain landing page, the cost calculator
// (site/cost/, served at /cost/) and service-worker retirer from ./site, and the changelog from
// apps/web/public/changelog. The calculator's build script and type declarations stay out of dist. The web demo itself (apps/web) isn't served for now;
// `npm run deploy:cloudflare:web` (carton/package.json) builds and deploys it in place of this when it's wanted again.
// The home page's videos are too large for git: they are assets of the public GitHub release `site-media`, listed in
// site/videos/media.json with each one's size and SHA-256. A copy already in site/videos/ (ignored by git) is used when
// it matches; otherwise it's downloaded. A file that doesn't match, or that is over Cloudflare's 25 MiB limit for one
// static file, stops the build, so the site never goes live with a broken or missing video.
//   node packages/server-cloudflare/build-site.mjs   (from carton/)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist", "site");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, "site"), out, { recursive: true, filter: (src) => !/(build-data\.mjs|\.d\.ts|media\.json)$/.test(src) });
cpSync(join(here, "..", "..", "apps", "web", "public", "changelog"), join(out, "changelog"), { recursive: true });

const ASSET_LIMIT = 25 * 1024 * 1024;
const { files } = JSON.parse(readFileSync(join(here, "site", "videos", "media.json"), "utf8"));
for (const m of files) {
  if (m.size > ASSET_LIMIT) throw new Error(`${m.file}: ${m.size} bytes is over Cloudflare's 25 MiB limit for one file`);
  const matches = (buf) => buf.length === m.size && createHash("sha256").update(buf).digest("hex") === m.sha256;
  const dest = join(out, "videos", m.file);
  if (existsSync(dest) && matches(readFileSync(dest))) continue;
  const res = await fetch(m.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${m.file}: ${m.url} answered ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!matches(buf)) throw new Error(`${m.file}: the download (${buf.length} bytes) doesn't match site/videos/media.json`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  console.log(`  ${m.file}: downloaded and checked (${buf.length} bytes)`);
}
console.log(`built ${out}`);
