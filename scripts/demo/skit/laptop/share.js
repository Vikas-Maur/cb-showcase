// Shares the promo from the demo Cardboard (README steps 3-4, for a rehearsal or a take driven over DevTools):
//   node share.js <DevTools port> <project id> [run folder] [--name Vikas]
// In the demo Cardboard started by launch-demo.ps1: runs the first-run screens, opens the project (its tab selected
// with a DevTools click), opens the title bar's Share, types the name, clicks "Share project" (the default server), and
// prints the invite link ("Can edit": the link's token says role "editor") as its first line: LINK <url>.
// It reads the link from the dialog's field and doesn't click Copy link (that would overwrite the person's clipboard).
// Facts to <run>\share.json, shots to <run>\shots\00-*.png (run folder: <demo>\runs\<time> unless given).
// Paths come from demo-env.ps1. DevTools page input only: nothing is sent to the OS. Each share counts against the
// sharing server's 10 new shared projects a day.
const fs = require("fs"), path = require("path");
const argv = process.argv.slice(2), nameAt = argv.indexOf("--name"), NAME_AS = nameAt >= 0 ? argv.splice(nameAt, 2)[1] : "Vikas";
const [port, id, given] = argv;
if (!port || !id) { console.error("usage: node share.js <DevTools port> <project id> [run folder] [--name Vikas]"); process.exit(2); }
process.env.CDP_PORT = port;
const h = require("./lib/cdp-helpers");
const U = require("./lib/open");
const D = require("./lib/demo-env");
const OUT = D.runDir(given), SH = path.join(OUT, "shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000, every = 300) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { try { if ((v = await fn())) return v; } catch {} await sleep(every); } return v; };
const T = () => new Date().toTimeString().slice(0, 8);
const lines = (sel) => `(document.querySelector(${JSON.stringify(sel)})?.innerText ?? "").split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean)`;
const center = (sel) => `(() => { const b = ${sel}; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: !!b.disabled }; })()`;
(async () => {
  const t00 = Date.now();
  await U.ready(h, port); console.error(T(), "ready after", Date.now() - t00, "ms");
  const E = await U.open(h, D.cb, id, D.Project); const page = await h.page(E); await sleep(2500);
  await h.shot(E, path.join(SH, "00-opened.png"));
  const sb = await until(() => h.ev("tabs.html", center(`[...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "") === "Share" && b.offsetParent)`)), 15000);
  if (!sb) throw new Error("no Share in the title bar");
  await h.mouse(await h.page("tabs.html"), sb.x, sb.y);
  await until(() => h.ev(E, `!!document.querySelector(".carton-share-dialog")`), 15000); await sleep(1000);
  const dialog = await h.ev(E, lines(".carton-share-dialog"));
  console.error(T(), "dialog:", JSON.stringify(dialog));
  if (await h.ev(E, `!!document.getElementById("carton-share-name")`)) {
    const p = await h.ev(E, center(`document.getElementById("carton-share-name")`));
    await h.mouse(page, p.x, p.y); await sleep(200); await h.ev(E, `document.getElementById("carton-share-name").select()`);
    await page.send("Input.insertText", { text: NAME_AS }); await sleep(400);
  }
  await h.shot(E, path.join(SH, "00-share-dialog.png"));
  const sp = await h.ev(E, center(`[...document.querySelectorAll(".carton-share-dialog button")].find((b) => b.offsetParent && /^Share project$/.test(b.innerText.trim()))`));
  if (!sp || sp.disabled) throw new Error("no enabled Share project button");
  const t0 = Date.now(); await h.mouse(page, sp.x, sp.y);
  const link = await until(() => h.ev(E, `(() => { const i = document.querySelector('.carton-share-dialog input[aria-label="Invite link"]'); return i && /^https?:/.test(i.value) ? i.value : null; })()`), 90000, 500);
  if (!link) throw new Error("no invite link: " + JSON.stringify(await h.ev(E, lines(".carton-share-dialog"))));
  const shared = await h.ev(E, lines(".carton-share-dialog"));
  let linkRole = null; try { linkRole = JSON.parse(Buffer.from(link.split(".ct1.")[1].split(".")[0], "base64url").toString()).role; } catch {}
  await h.shot(E, path.join(SH, "00-shared.png"));
  await h.keys(E, "Escape"); await sleep(500);
  const facts = { id, name: D.Project, as: NAME_AS, shareMs: Date.now() - t0, dialogBefore: dialog, sharedView: shared, linkRole, link };
  fs.writeFileSync(path.join(OUT, "share.json"), JSON.stringify(facts, null, 1));
  console.log("LINK " + link);
  console.error(T(), `shared in ${facts.shareMs} ms as ${NAME_AS}; link role: ${linkRole}; run folder ${OUT}`);
  h.forget(); process.exit(0);
})().catch((e) => { console.error("ERR", e.stack); h.forget(); process.exit(1); });
