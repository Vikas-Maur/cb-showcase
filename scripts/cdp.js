// Drives a running Cardboard over the Chrome DevTools Protocol, for testing the app as a user would.
// Start Cardboard with --remote-debugging-port=<port> (CDP_PORT, default 9334), then:
//   node cdp.js list
//   node cdp.js eval <url-part> "<expression>"         evaluates in the first page whose URL contains url-part
//   node cdp.js keys <url-part> "Control+t" "Enter"…   presses keys there (modifiers joined with +)
//   node cdp.js type <url-part> "some text"            types text into the focused field
//   node cdp.js click <url-part> "<selector>" [text]   clicks the first match (whose text starts with text)
//   node cdp.js shot <url-part> out.png
// Keys go through Input.dispatchKeyEvent, the same path as keyboard input: Electron's before-input-event,
// the page's keydown handlers, then the window's menu accelerators.
const PORT = process.env.CDP_PORT || 9334;

const MODS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const NAMED = {
  Enter: [13, "Enter", "\r"], Escape: [27, "Escape"], Tab: [9, "Tab"], Backspace: [8, "Backspace"],
  Delete: [46, "Delete"], Space: [32, "Space", " "], " ": [32, "Space", " "],
  ArrowLeft: [37, "ArrowLeft"], ArrowUp: [38, "ArrowUp"], ArrowRight: [39, "ArrowRight"], ArrowDown: [40, "ArrowDown"],
  Home: [36, "Home"], End: [35, "End"], F10: [121, "F10"], F11: [122, "F11"],
  Control: [17, "ControlLeft"], Shift: [16, "ShiftLeft"], Alt: [18, "AltLeft"], Meta: [91, "MetaLeft"],
};
const PUNCT = { "[": [219, "BracketLeft"], "]": [221, "BracketRight"], "\\": [220, "Backslash"], "/": [191, "Slash"],
  ",": [188, "Comma"], "=": [187, "Equal"], "-": [189, "Minus"], "`": [192, "Backquote"], ".": [190, "Period"] };

const keyInfo = (k) => {
  if (NAMED[k]) return { vk: NAMED[k][0], code: NAMED[k][1], key: k === "Space" ? " " : k, text: NAMED[k][2] };
  if (PUNCT[k]) return { vk: PUNCT[k][0], code: PUNCT[k][1], key: k, text: k };
  if (/^[a-z]$/i.test(k)) return { vk: k.toUpperCase().charCodeAt(0), code: "Key" + k.toUpperCase(), key: k, text: k };
  if (/^[0-9]$/.test(k)) return { vk: k.charCodeAt(0), code: "Digit" + k, key: k, text: k };
  throw new Error("unknown key " + k);
};

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

const connect = async (part) => {
  const t = (await targets()).find((x) => x.type === "page" && x.url.includes(part));
  if (!t) throw new Error(`no page matching ${part}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (d) => (d.error ? rej(new Error(method + ": " + d.error.message)) : res(d.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, close: () => ws.close(), target: t };
};

const evaluate = async (c, expression) => {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

// "Control+Shift+e": modifiers go down in order, the key is pressed, then everything comes up.
const press = async (c, combo) => {
  const parts = combo === "+" ? ["+"] : combo.split(/\+(?!$)/);
  const key = parts.pop();
  let mods = 0;
  for (const m of parts) {
    if (!(m in MODS)) throw new Error("unknown modifier " + m);
    mods |= MODS[m];
    const i = keyInfo(m);
    await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: mods, key: m, code: i.code, windowsVirtualKeyCode: i.vk, nativeVirtualKeyCode: i.vk });
  }
  const i = keyInfo(key);
  const shifted = mods & MODS.Shift && i.text && /^[a-z]$/.test(i.text);
  const k = shifted ? i.key.toUpperCase() : i.key;
  // Text only when no Ctrl/Alt/Meta, as a keyboard would produce it.
  const text = !(mods & (MODS.Control | MODS.Alt | MODS.Meta)) && i.text ? (shifted ? i.text.toUpperCase() : i.text) : undefined;
  const base = { modifiers: mods, key: k, code: i.code, windowsVirtualKeyCode: i.vk, nativeVirtualKeyCode: i.vk };
  await c.send("Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", text, unmodifiedText: text });
  await c.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  for (const m of parts.reverse()) {
    mods &= ~MODS[m];
    const mi = keyInfo(m);
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: mods, key: m, code: mi.code, windowsVirtualKeyCode: mi.vk, nativeVirtualKeyCode: mi.vk });
  }
};

module.exports = { targets, connect, evaluate, press };

if (require.main === module) {
  (async () => {
    const [cmd, part, ...rest] = process.argv.slice(2);
    if (cmd === "list") {
      for (const t of await targets()) console.log(t.type.padEnd(8), t.id.slice(0, 8), t.url);
      return;
    }
    const c = await connect(part);
    try {
      if (cmd === "eval") console.log(JSON.stringify(await evaluate(c, rest[0]), null, 2));
      else if (cmd === "keys") for (const k of rest) { await press(c, k); await new Promise((r) => setTimeout(r, 120)); }
      else if (cmd === "type") await c.send("Input.insertText", { text: rest[0] });
      else if (cmd === "click") {
        // A mouse click on the middle of the first element matching the selector (and, if given, text).
        const at = await evaluate(c, `(() => { const e = [...document.querySelectorAll(${JSON.stringify(rest[0])})].find((e) => !${JSON.stringify(rest[1] ?? null)} || e.textContent.trim().startsWith(${JSON.stringify(rest[1] ?? "")}));
          if (!e) return null; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        if (!at) throw new Error("nothing matches " + rest.join(" "));
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
          await c.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
      }
      else if (cmd === "shot") {
        const r = await c.send("Page.captureScreenshot", { format: "png" });
        require("fs").writeFileSync(rest[0], Buffer.from(r.data, "base64"));
        console.log("saved", rest[0]);
      } else throw new Error("unknown command " + cmd);
    } finally { c.close(); }
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
