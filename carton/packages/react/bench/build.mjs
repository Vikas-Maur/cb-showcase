// Build the benchmark page (bench/dist/index.html + preact.html), like the gallery but with keepNames, so render
// counts can name components, and React DevTools' hook installed before React loads (render counting on React).
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
mkdirSync(out, { recursive: true });

// Counts fibers that performed work (flag PerformedWork = 1) in each React commit.
const reactHook = `window.__renders={};window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(){return 1},
onScheduleFiberRoot(){},onCommitFiberUnmount(){},onPostCommitFiberRoot(){},checkDCE(){},
onCommitFiberRoot(id,root){const walk=(f)=>{while(f){const t=f.type;if(t&&(typeof t==="function"||typeof t==="object")&&(f.flags&1)){const n=(t.displayName||t.name||(t.type&&(t.type.displayName||t.type.name))||(t.render&&t.render.name));if(n)window.__renders[n]=(window.__renders[n]||0)+1;}walk(f.child);f=f.sibling;}};walk(root.current.child);}};`;

const common = {
  entryPoints: [join(here, "bench.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  minify: true,
  keepNames: true,
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' },
};
await Promise.all([
  build({ ...common, outfile: join(out, "bench.react.js"), banner: { js: `globalThis.__CARTON_RUNTIME__="react";${reactHook}` } }),
  build({
    ...common,
    outfile: join(out, "bench.preact.js"),
    banner: { js: 'globalThis.__CARTON_RUNTIME__="preact";window.__renders={};' },
    alias: { react: "preact/compat", "react-dom/client": "preact/compat/client", "react-dom": "preact/compat" },
  }),
]);
const page = (rt) => `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>html,body{margin:0;background:#0a0a0a}</style></head><body><div id="root"></div><script src="./bench.${rt}.js"></script></body></html>`;
writeFileSync(join(out, "index.html"), page("react"));
writeFileSync(join(out, "preact.html"), page("preact"));
console.log(`bench built: ${out}`);
