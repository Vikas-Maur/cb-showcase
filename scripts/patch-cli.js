// Patches Cardboard's bundled CLI so it reaches the desktop app's control socket on Windows,
// where the app listens on a named pipe derived from the socket path (see patch-main.js).
// Usage: node patch-cli.js <path-to-resources/cli/cardboard.mjs> <pristine-backup-path>
const fs = require("fs");

const [file, orig] = process.argv.slice(2);
if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);
let src = fs.readFileSync(orig, "utf8");

const replace = (from, to, count = 1) => {
  const n = src.split(from).length - 1;
  if (n !== count) throw new Error(`expected ${count} match(es), found ${n}: ${from}`);
  src = src.split(from).join(to);
};

// Same mapping as __cbSock in main.js, and the rename retry for project saves (see rename-retry.js).
replace(
  `const require = __createRequire(import.meta.url);\n`,
  `const require = __createRequire(import.meta.url);\n` +
    require("./rename-retry") +
    String.raw`const __cbPipe = (p) => process.platform === "win32" && !p.startsWith("\\\\") ? "\\\\.\\pipe\\cardboard-" + require("node:crypto").createHash("sha256").update(p.toLowerCase()).digest("hex").slice(0, 16) : p;` +
    `\n`,
);
replace(`Ik=t=>new Promise((e,r)=>{let n=kk(t);`, `Ik=t=>new Promise((e,r)=>{let n=kk(__cbPipe(t));`);
// No socket file exists on Windows; the token file beside it marks a running app.
replace(`Fh);return xk(n)?n:null}`, `Fh);return xk(process.platform==="win32"?fn(Ck(n),qh):n)?n:null}`);

fs.writeFileSync(file, src);
console.log("patched cardboard.mjs");
