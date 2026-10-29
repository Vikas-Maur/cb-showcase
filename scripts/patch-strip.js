// Patches Cardboard's tab strip (the bar along the top of the window) so it is the title bar on Windows.
// Usage: node patch-strip.js <path-to-dist/renderer/assets/tabs-*.js>
const fs = require("fs");
const path = require("path");

const file = process.argv[2];
// Keep the pristine bundle outside the asar source tree so it is not repacked.
const orig = path.join(path.dirname(file), "..", "..", "..", "..", "tabs.orig.js");
if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);
let src = fs.readFileSync(orig, "utf8");

const replace = (from, to, count = 1) => {
  const n = src.split(from).length - 1;
  if (n !== count) throw new Error(`expected ${count} match(es), found ${n}: ${from}`);
  src = src.split(from).join(to);
};

// 1. The menu button and its menus (see strip-titlebar.js), after the bundle's imports.
replace(`from"./string-BideQp2G.js";`, `from"./string-BideQp2G.js";` + require("./strip-titlebar"));

// 2. Cardboard's logomark opens the app menu, at the strip's leading edge where macOS has its traffic
// lights. A divider separates it from the tabs, as one separates Dashboard from the projects.
replace(
  `pl-[max(6px,var(--desktop-controls-inset)_+_4px)]",children:[k&&`,
  `pl-[max(6px,var(--desktop-controls-inset)_+_4px)]",children:[__cbWinBar&&n.jsx(__cbMenu,{separated:k}),k&&`,
);

// 3. Room for the native window controls at the right end. On macOS the strip leaves room for the
// traffic lights on the left until the window goes full screen; on Windows it does the same on the right.
replace(
  `className:"desktop-drag-region flex h-[40px] items-stretch bg-[var(--desktop-chrome)] text-neutral-100",children:`,
  `className:"desktop-drag-region flex h-[40px] items-stretch bg-[var(--desktop-chrome)] text-neutral-100",style:{paddingRight:"var(--desktop-controls-inset-end,0px)"},children:`,
);
replace(
  `s=re()==="darwin",o=c.useCallback(i=>{s&&(document.documentElement.classList.toggle(ee,!i),t(!i))},[s])`,
  `s=re()==="darwin"||__cbWinBar,o=c.useCallback(i=>{s&&(__cbWinBar?__cbEndInset(!i):document.documentElement.classList.toggle(ee,!i),t(!i))},[s])`,
);
replace(`()=>document.documentElement.classList.remove(ee)`, `()=>__cbWinBar?__cbEndInset(!1):document.documentElement.classList.remove(ee)`);

fs.writeFileSync(file, src);
console.log(`patched ${path.basename(file)} (${src.length} bytes)`);
