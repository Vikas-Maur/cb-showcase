// The laptop tooling's DevTools helpers (copied from the laptop's scenario helpers): pages by URL part, evaluate, mouse,
// keys (scripts/cdp.js's press), screenshots and polling. The port comes from CDP_PORT, read once by scripts/cdp.js.
// Small helpers for scenario scripts: a CDP client with events, pages by URL part, evaluate, click,
// keys (scripts/cdp.js's press), screenshots and polling.
const { press, targets } = require("../../../../cdp.js");
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = async (part) => {
  const t = (await targets()).find((x) => x.type === "page" && x.url.includes(part));
  if (!t) throw new Error(`no page matching ${part}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map(), listeners = new Set();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    else if (d.method) for (const l of listeners) l(d);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (d) => (d.error ? rej(new Error(method + ": " + d.error.message)) : res(d.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  // Resolves with the params of the next event called method (that passes test).
  const next = (method, test = () => true) => new Promise((res) => {
    const l = (d) => { if (d.method === method && test(d.params)) { listeners.delete(l); res(d.params); } };
    listeners.add(l);
  });
  return { send, next, on: (l) => listeners.add(l), close: () => ws.close(), target: t };
};
const evaluate = async (c, expression) => {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

let pages = {};
const page = async (part) => (pages[part] ??= await connect(part));
const forget = (part) => { if (part) { pages[part]?.close(); delete pages[part]; } else { for (const c of Object.values(pages)) c.close(); pages = {}; } };
const ev = async (part, js) => evaluate(await page(part), js);
const mouse = async (c, x, y, { button = "left", clickCount = 1, modifiers = 0 } = {}) => {
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount, modifiers });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount, modifiers });
};
// Where the middle of the first element matching selector (whose text starts with text, if given) is.
const center = async (part, selector, text) => ev(part, `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${JSON.stringify(text ?? null)} === null || e.textContent.trim().startsWith(${JSON.stringify(text ?? "")}));
    if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const click = async (part, selector, text, opts = {}) => {
  const at = await center(part, selector, text);
  if (!at) throw new Error(`nothing matches ${selector} ${text ?? ""}`);
  await mouse(await page(part), at.x, at.y, opts);
  return at;
};
const shot = async (part, file) => {
  const r = await (await page(part)).send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  return file;
};
const keys = async (part, ...combos) => { const c = await page(part); for (const k of combos) { await press(c, k); await sleep(120); } };
// Waits until fn() (async) returns truthy, polling every `every` ms, up to `ms`.
const until = async (fn, ms = 10000, every = 200) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { if ((v = await fn())) return v; await sleep(every); } return v; };
const urls = async () => (await targets()).filter((t) => t.type === "page").map((t) => t.url);
// Runs a menu item from the strip's menu, as a click would: "File", "Import Folder".
const menu = async (top, item) => {
  await click("tabs.html", 'button[aria-label="Menu"]'); await sleep(300);
  await click("tabs.html", "[role=menuitem]", top); await sleep(300);
  await click("tabs.html", "[role=menuitem]", item);
};
module.exports = { sleep, connect, evaluate, page, forget, ev, center, click, mouse, shot, keys, until, urls, targets, press, menu };
