// The demo profile's paths for the laptop's Node tooling, read from demo-env.ps1 (the one place they are set): the
// installed build ($Cardboard), the demo folder ($Demo), the stand-in's port ($Port), the project ($Project). Also cb as
// demo-env.ps1 runs it (Cardboard's Node, the demo library and socket, no CLAUDE*/ANTHROPIC*/actor variables).
const fs = require("fs"), path = require("path");
const { spawnSync } = require("child_process");
const src = fs.readFileSync(path.join(__dirname, "..", "demo-env.ps1"), "utf8");
const get = (name) => { const m = new RegExp(`^\\$${name}\\s*=\\s*(?:"([^"]*)"|(\\d+))`, "m").exec(src); if (!m) throw new Error(`demo-env.ps1 sets no $${name}`); return m[1] ?? Number(m[2]); };
const Cardboard = get("Cardboard"), Demo = get("Demo"), Port = get("Port"), Project = get("Project");
const Exe = path.join(Cardboard, "Cardboard.exe"), Cli = path.join(Cardboard, "resources", "cli", "cardboard.mjs");
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", CARDBOARD_HOME: path.join(Demo, "home"), CARDBOARD_SOCKET: path.join(Demo, "userdata", "cardboard.sock") };
for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC)/.test(k) || ["CARDBOARD_CARTON", "CDP_PORT", "CARDBOARD_ACTOR", "CARDBOARD_USER_DATA"].includes(k)) delete env[k];
const cb = (...a) => { const r = spawnSync(Exe, [Cli, ...a], { env, encoding: "utf8", timeout: 180e3 }); return ((r.stdout || "") + (r.stderr || "")).replace(/^\[carton\][^\n]*\n/gm, "").trim(); };
// a run's folder for shots and logs: <demo>\runs\<yyyymmdd-hhmmss>, or the one given
const stamp = () => { const t = new Date(), p = (n) => String(n).padStart(2, "0"); return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`; };
const runDir = (given) => { const d = given || path.join(Demo, "runs", stamp()); fs.mkdirSync(path.join(d, "shots"), { recursive: true }); return d; };
module.exports = { Cardboard, Demo, Port, Project, Exe, Cli, cb, runDir };
