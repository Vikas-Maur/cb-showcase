// The shared minute clock (useNow) on its first subscriber's first render, on React 19 and on preact/compat (pnpm test
// runs this file twice). UI audit R7, PLAN 9.4: preact/compat read the clock as the module last left it (when it
// loaded), so a time a minute old read "just now" until the next tick, where React read "1 min ago".
import { $, React, cleanup, closeDom, render, runtime } from "./dom.ts";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { useNow, when } from "../src/index.ts";

const h = React.createElement;
afterEach(cleanup);
after(closeDom);

test(`R7: the first render reads the clock as it is now, not as the module loaded [${runtime}]`, async () => {
  const real = Date.now;
  const at = real();
  // a minute and a half after the module loaded (and read the clock), the first component that asks for it mounts
  Date.now = () => real() + 90_000;
  try {
    const seen: string[] = [];
    function Ago() {
      const now = useNow();
      const text = when(at, now);
      seen.push(text);
      return h("span", { className: "ago" }, text);
    }
    const m = await render(h(Ago));
    assert.equal(seen[0], "1 min ago", `the first render: ${JSON.stringify(seen)}`);
    assert.equal($(m.container, ".ago")?.textContent, "1 min ago");
    await m.unmount();
    // the last subscriber gone, the clock rests; the next first render reads it afresh again
    Date.now = () => real() + 200_000;
    seen.length = 0;
    const n = await render(h(Ago));
    assert.equal(seen[0], "3 min ago", `after a rest: ${JSON.stringify(seen)}`);
    await n.unmount();
  } finally {
    Date.now = real;
  }
});
