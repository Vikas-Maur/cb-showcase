// Clicks through Cardboard's first-run screens (Get started, plan, agent setup) like a user, on whichever
// page shows them, until the Dashboard's prompt box is there.
const h = require("./cdp-helpers");
(async () => {
  let quiet = 0;
  for (let i = 0; i < 20 && quiet < 3; i++) {
    let clicked = false;
    for (const u of await h.urls()) {
      if (/tabs\.html|\/warm/.test(u)) continue;
      const part = u.replace("app://cardboard/", "");
      const b = await h.ev(part, `(() => { const b = [...document.querySelectorAll("button,a")].find((b) => /^(Get started|Let.s start|Continue|Skip|Done|Start editing|Not now|Maybe later)/i.test(b.textContent.trim()) && b.offsetParent); return b ? b.textContent.trim() : null; })()`).catch(() => null);
      if (b) { await h.click(part, "button,a", b); console.log("clicked", b, "on", part); clicked = true; await h.sleep(1200); }
    }
    quiet = clicked ? 0 : quiet + 1;
    await h.sleep(700);
  }
  h.forget();
})().catch((e) => { console.error(e.message); process.exit(1); });
