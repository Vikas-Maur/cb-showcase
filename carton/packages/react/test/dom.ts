// A DOM for component tests (happy-dom), and render/act helpers that work the same on React 19 and preact/compat.
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/", width: 1280, height: 800 });
const g = globalThis as Record<string, unknown>;
for (const key of [
  "window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLDivElement",
  "SVGElement", "Text", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "FocusEvent", "InputEvent", "CustomEvent",
  "MutationObserver", "ResizeObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DocumentFragment",
] as const) {
  // Always take happy-dom's: Node has its own Event/EventTarget, which happy-dom's dispatchEvent rejects.
  Object.defineProperty(g, key, { value: (win as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
}

/** Close the DOM so its timers can't keep the test process alive. */
export async function closeDom(): Promise<void> {
  await win.happyDOM.close();
}
g.IS_REACT_ACT_ENVIRONMENT = true;

export const runtime = process.env.CARTON_RUNTIME === "preact" ? "preact" : "react";

const React = await import("react");
const client = await import("react-dom/client");
type Act = (fn: () => unknown) => Promise<void>;
const act: Act =
  runtime === "preact"
    ? ((await import("preact/test-utils")).act as unknown as Act)
    : ((React as unknown as { act: Act }).act);

export { act };

export interface Mounted {
  container: HTMLElement;
  rerender(el: unknown): Promise<void>;
  unmount(): Promise<void>;
}

const mounted = new Set<Mounted>();

export async function render(el: unknown): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = client.createRoot(container);
  await act(() => root.render(el as never));
  const m: Mounted = {
    container,
    rerender: (next) => act(() => root.render(next as never)),
    unmount: async () => {
      if (!mounted.delete(m)) return;
      await act(() => root.unmount());
      container.remove();
    },
  };
  mounted.add(m);
  return m;
}

/** Unmount whatever a failed test left mounted (its timers and subscriptions go with it). */
export async function cleanup(): Promise<void> {
  for (const m of [...mounted]) await m.unmount();
}

/** Let microtask-batched notifications and pending promises settle inside act(). */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("click: no element");
  await act(() => {
    (el as HTMLElement).click();
  });
  await flush();
}

export async function key(el: Element | null | undefined, k: string): Promise<void> {
  if (!el) throw new Error("key: no element");
  await act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await flush();
}

export async function type(input: Element | null | undefined, text: string): Promise<void> {
  if (!input) throw new Error("type: no element");
  const el = input as HTMLInputElement;
  await act(() => {
    // React tracks the value through its own setter, so set it through the prototype like a user's keystroke does.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

export const $ = (root: ParentNode, sel: string) => root.querySelector(sel) as HTMLElement | null;
export const $$ = (root: ParentNode, sel: string) => [...root.querySelectorAll(sel)] as HTMLElement[];
export const byText = (root: ParentNode, sel: string, text: string | RegExp) =>
  $$(root, sel).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? ""))) ?? null;

/** Count DOM mutations under an element while `fn` runs: real work done, in either runtime. */
export async function mutationsDuring(el: Element, fn: () => Promise<void>): Promise<number> {
  let n = 0;
  const mo = new MutationObserver((list) => (n += list.length));
  mo.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  await fn();
  await new Promise((r) => setTimeout(r, 0));
  n += mo.takeRecords().length;
  mo.disconnect();
  return n;
}

export { React };
