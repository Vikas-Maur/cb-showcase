// Runs the injected __cbTools/__cbSock helpers from the patched main.js in isolation.
const fs = require("fs"), path = require("path"), net = require("net");
const [mainJs, binDir, toolsDir, pyRoot] = process.argv.slice(2);
const src = fs.readFileSync(mainJs, "utf8");
const start = src.indexOf("\n") + 1, end = src.indexOf("var rCe=");
eval(src.slice(start, end) + ";globalThis.__t={__cbTools,__cbSock,__cbExe};");
const { __cbTools: tools, __cbSock: sock } = globalThis.__t;
const t = { ffmpeg: path.join(binDir, "ffmpeg.exe"), ffprobe: path.join(binDir, "ffprobe.exe"), uv: path.join(binDir, "uv.exe") };
// Same values and env-name hash as main.js (o3, Pke, xWt) so the app reuses this env.
const py = "3.12", pkgs = ["numpy==2.5.3", "opencv-python-headless==5.0.0.93", "pillow==12.3.0", "scipy==1.18.1"];
const envName = "env-" + require("crypto").createHash("sha256").update([py, ...pkgs].join("\n")).digest("hex").slice(0, 12);
tools(toolsDir, t, pyRoot, { envName, py, pkgs });
console.log("shims:", fs.readdirSync(toolsDir).join(" "));
const pipe = sock(path.join(process.env.APPDATA, "ai.cardboard.desktop", "control.sock"));
const srv = net.createServer((c) => c.end("pong\n")).listen(pipe, () => {
  net.connect(pipe).on("data", (d) => { console.log("pipe", pipe, "->", d.toString().trim()); srv.close(); });
}).on("error", (e) => console.log("pipe error", e.message));
