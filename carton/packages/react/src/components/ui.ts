// Small unstyled building blocks: button, avatar, menu, dialog. They carry roles, keyboard handling and class names;
// the look comes from a skin (skin/cardboard.ts) or the host's own CSS.

import {
  createElement as h,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { actorColor, actorDetail, actorLabel, initials } from "../actors.ts";
import { useCartonUi, useWords } from "../hooks.ts";
import { Icon, type IconName } from "../icons.ts";
import type { Actor } from "../model.ts";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export interface ButtonProps {
  children?: ReactNode;
  icon?: IconName;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  className?: string;
  label?: string;
  pressed?: boolean;
  type?: "button" | "submit";
  /** More about it for screen readers, with no tooltip (inside rows and cards, where one would cover the next). */
  description?: string;
}

export function Button(p: ButtonProps) {
  return h(
    "button",
    {
      type: p.type ?? "button",
      className: cx("carton-btn", p.className),
      "data-variant": p.variant ?? "secondary",
      "data-size": p.size ?? "sm",
      "data-icon-only": p.children == null ? "" : undefined,
      "aria-label": p.label,
      "aria-pressed": p.pressed,
      "aria-description": p.description,
      "aria-busy": p.busy || undefined,
      "data-carton-tip": p.title,
      disabled: p.disabled || p.busy,
      onClick: p.onClick,
    },
    p.icon ? h(Icon, { name: p.icon }) : null,
    p.children != null ? h("span", { className: "carton-btn-text" }, p.children) : null,
  );
}

/**
 * An actor's avatar. `named`: its name is shown beside it (History rows, cards, Credits), so the avatar is decoration:
 * no tooltip of its own (it would repeat the name over the row below) and hidden from screen readers. A system actor
 * has none.
 */
export function Avatar({ actor, size = 22, title, named }: { actor: Actor; size?: number; title?: string; named?: boolean }) {
  const ui = useCartonUi();
  const words = useWords();
  if (actor.kind === "system") return null;
  const color = actorColor(actor, ui.actor.bind(ui));
  const label = title ?? actorLabel(actor, ui.actor.bind(ui), words.you);
  // Two letters need about 20 px; smaller avatars (history rows, card headers) show one.
  const letters = (s: string) => (size < 20 ? Array.from(s)[0] ?? "?" : s);
  const style: CSSProperties = { width: size, height: size, fontSize: Math.max(7, Math.round(size * (size < 20 ? 0.5 : 0.4))), ["--carton-actor" as string]: color };
  const glyph =
    actor.kind === "human"
      ? h("span", { className: "carton-avatar-initials" }, letters(initials(actor.name)))
      : actor.kind === "subagent" && !named
        ? h("span", { className: "carton-avatar-initials" }, initials(actor.subagentType ?? actor.name).slice(0, 1))
        : h(Icon, { name: "sparkle", size: Math.round(size * 0.62) });
  // Beside a name, a subagent is its agent ("Director"): the agent's look too.
  return named
    ? h("span", { className: "carton-avatar", "data-kind": actor.kind === "subagent" ? "agent" : actor.kind, style, "aria-hidden": true }, glyph)
    : h("span", { className: "carton-avatar", "data-kind": actor.kind, style, role: "img", "aria-label": label, "data-carton-tip": label }, glyph);
}

/**
 * A short text that says more on hover, in its own place: "just now" becomes "Nov 1, 2026, 8:47 PM", "Director" becomes
 * "Director › general-purpose · Opus 5.5". Never a tooltip: one would cover the row below (laptop report 90c4127, the
 * user). Screen readers get the short text, and the element its own meaning (a <time>'s dateTime).
 */
export function HoverMore({ as = "span", short, more, className, ...rest }: { as?: string; short: ReactNode; more?: string; className?: string } & Record<string, unknown>) {
  if (!more || more === short) return h(as, { className, ...rest }, short);
  return h(as, { className: cx("carton-more", className), ...rest }, h("span", { className: "carton-more-short" }, short), h("span", { className: "carton-more-long", "aria-hidden": true }, more));
}

/**
 * An actor's name in an author slot ("You", "Director", "Leo's Director"); nothing for a system actor. What more there
 * is (a subagent's type, a model: actorDetail) shows in its place on hover; no tooltip. `detail`: show the detail
 * itself (a details view: Credits).
 */
export function ActorName({ actor, detail }: { actor: Actor; detail?: boolean }) {
  const ui = useCartonUi();
  const words = useWords();
  if (actor.kind === "system") return null;
  const byKey = ui.actor.bind(ui);
  const label = actorLabel(actor, byKey, words.you);
  const more = actorDetail(actor, byKey, words.you);
  if (detail) return h("span", { className: "carton-actor-name", "data-kind": actor.kind }, more ?? label);
  return h(HoverMore, { className: "carton-actor-name", "data-kind": actor.kind, short: label, more });
}

/**
 * Arrow keys in a role=radiogroup of buttons (WAI-ARIA radio group): Left/Up and Right/Down move the choice and the
 * focus, Home and End go to the ends. Only one radio is a tab stop (the checked one: `tabIndex: checked ? 0 : -1`).
 * The keys stop here, so a player's own arrow keys around the group don't also fire.
 */
export function radioKeys(e: KeyboardEvent<HTMLElement>) {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  const n =
    e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % items.length
    : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + items.length) % items.length
    : e.key === "Home" ? 0
    : e.key === "End" ? items.length - 1
    : -1;
  if (n < 0) return;
  e.preventDefault();
  e.stopPropagation();
  items[n]!.focus();
  items[n]!.click();
}

/**
 * A native tooltip only when the text doesn't fit: set on hover from the element's own size, so a name that shows
 * whole never gets one (and a truncated name always does: History rows, the cut switcher, Compare's labels).
 */
export function tipIfCut(e: { currentTarget: EventTarget | null }) {
  const el = e.currentTarget as HTMLElement | null;
  if (!el) return;
  const text = el.textContent ?? "";
  if (el.scrollWidth > el.clientWidth + 1) {
    if (el.title !== text) el.title = text;
  } else if (el.title) el.removeAttribute("title");
}

// ---------------------------------------------------------------- menus

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"])')];
}

// children are optional in the props types because createElement passes them as extra arguments.
export interface MenuListProps {
  children?: ReactNode;
  /** `why`: "escape" (the keyboard: focus goes back where the menu came from) or "outside" (a click elsewhere). */
  onClose: (why?: "escape" | "outside") => void;
  label: string;
  style?: CSSProperties;
  className?: string;
  /** Elements whose clicks don't count as "outside" (the trigger). */
  ignore?: () => (HTMLElement | null)[];
}

/** role=menu with arrow-key focus, Escape and click-outside to close. Positioned by the caller. */
export function MenuList(p: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const onCloseRef = useRef(p.onClose);
  onCloseRef.current = p.onClose;
  const ignoreRef = useRef(p.ignore);
  ignoreRef.current = p.ignore;

  // Focus comes in without scrolling anything around the menu (a scroll moved the whole panel: UI audit P2-3). When
  // the menu's content changes under the focus (a form inside it closes), focus comes back to its first item instead of
  // falling to <body>, where Esc and the arrows did nothing (P2-1).
  useLayoutEffect(() => {
    const el = ref.current;
    const lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
    if (el && (lost || !el.contains(document.activeElement)) && (lost || !focused.current)) (focusables(el)[0] ?? el).focus({ preventScroll: true });
    focused.current = true;
  });

  useEffect(() => {
    const down = (e: Event) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t)) return;
      if (ignoreRef.current?.().some((x) => x?.contains(t))) return;
      onCloseRef.current("outside");
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      p.onClose("escape");
      return;
    }
    // Typing in an inline field (new cut name) must not move the menu focus.
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const items = focusables(el);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    let n = -1;
    if (e.key === "ArrowDown") n = (i + 1) % items.length;
    else if (e.key === "ArrowUp") n = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = items.length - 1;
    if (n >= 0) {
      e.preventDefault();
      items[n]!.focus();
    }
  };

  return h(
    "div",
    { ref, role: "menu", "aria-label": p.label, tabIndex: -1, className: cx("carton-menu", p.className), style: p.style, onKeyDown },
    p.children,
  );
}

export interface MenuItemProps {
  children?: ReactNode;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  hint?: ReactNode;
  /** What it does, in a line under its name (never a tooltip over the item below). */
  title?: string;
}

export function MenuItem(p: MenuItemProps) {
  const radio = p.checked !== undefined;
  return h(
    "button",
    {
      type: "button",
      role: radio ? "menuitemradio" : "menuitem",
      "aria-checked": radio ? p.checked : undefined,
      "aria-disabled": p.disabled || undefined,
      className: "carton-menu-item",
      "data-danger": p.danger || undefined,
      "data-described": p.title ? "" : undefined,
      tabIndex: -1,
      onClick: () => !p.disabled && p.onSelect(),
    },
    h("span", { className: "carton-menu-icon" }, p.icon ? h(Icon, { name: p.icon }) : radio && p.checked ? h(Icon, { name: "check" }) : null),
    p.title
      ? h("span", { className: "carton-menu-text" }, p.children, h("span", { className: "carton-menu-desc" }, p.title))
      : h("span", { className: "carton-menu-text" }, p.children),
    p.hint != null ? h("span", { className: "carton-menu-hint" }, p.hint) : null,
  );
}

export const MenuSeparator = () => h("div", { role: "separator", className: "carton-menu-sep" });
export const MenuLabel = ({ children }: { children?: ReactNode }) => h("div", { className: "carton-menu-label", role: "presentation" }, children);

export interface MenuButtonProps {
  label: string;
  /** Content of the trigger button. */
  trigger: ReactNode;
  triggerClassName?: string;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  title?: string;
  /** The trigger's accessible name, when its content alone doesn't say what it is ("Cut: Main cut"). */
  ariaLabel?: string;
  onOpenChange?: (open: boolean) => void;
}

/** A button that opens a menu below it. */
export function MenuButton(p: MenuButtonProps) {
  const [open, setOpenState] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  const onOpenChange = useRef(p.onOpenChange);
  onOpenChange.current = p.onOpenChange;
  const setOpen = useCallback((next: boolean | ((o: boolean) => boolean)) => {
    setOpenState((o) => {
      const v = typeof next === "function" ? next(o) : next;
      if (v !== o) queueMicrotask(() => onOpenChange.current?.(v));
      return v;
    });
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    btn.current?.focus({ preventScroll: true });
  }, [setOpen]);
  return h(
    "div",
    { className: "carton-menu-anchor", "data-align": p.align ?? "start" },
    h(
      "button",
      {
        ref: btn,
        type: "button",
        className: cx("carton-menu-trigger", p.triggerClassName),
        "aria-haspopup": "menu",
        "aria-label": p.ariaLabel,
        "aria-expanded": open,
        "aria-controls": open ? id : undefined,
        "data-carton-tip": open ? undefined : p.title,
        onClick: () => setOpen((o) => !o),
        onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        },
      },
      p.trigger,
    ),
    open ? h("div", { id, className: "carton-menu-pop" }, h(MenuList, { label: p.label, onClose: close, ignore: () => [btn.current] }, p.children(close))) : null,
  );
}

// ---------------------------------------------------------------- dialog

export interface DialogProps {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Text for the close button. */
  closeLabel?: string;
  describedBy?: string;
}

/** A modal dialog: focus moves in and is trapped, Escape closes, focus returns to where it was. */
export function Dialog(p: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const words = useWords();
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // The dialog itself takes focus, as Cardboard's own do (Export), not its first button (the ✕: UI audit P3-5); Tab
    // goes on from there. A field marked data-autofocus takes it instead.
    (el?.querySelector<HTMLElement>("[data-autofocus]") ?? el)?.focus({ preventScroll: true });
    return () => before?.focus?.();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      p.onClose();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const f = [...ref.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [tabindex='0']")];
    if (!f.length) return;
    const first = f[0]!, last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return h(
    "div",
    { className: "carton-overlay", onPointerDown: (e: MouseEvent) => e.target === e.currentTarget && p.onClose() },
    h(
      "div",
      {
        ref,
        role: "dialog",
        "aria-modal": true,
        "aria-labelledby": titleId,
        "aria-describedby": p.describedBy,
        tabIndex: -1,
        className: cx("carton-dialog", p.className),
        onKeyDown,
      },
      h(
        "div",
        { className: "carton-dialog-head" },
        h("h2", { id: titleId, className: "carton-dialog-title" }, p.title),
        h(Button, { variant: "ghost", icon: "x", label: p.closeLabel ?? words.close, onClick: p.onClose, className: "carton-dialog-close" }),
      ),
      h("div", { className: "carton-dialog-body" }, p.children),
      p.footer ? h("div", { className: "carton-dialog-foot" }, p.footer) : null,
    ),
  );
}

/** A one-line text field with Save/Cancel, used to name versions and cuts in place. */
export function InlineName(p: { initial?: string; placeholder?: string; label: string; onSave: (name: string) => void; onCancel: () => void; saveLabel: string }) {
  const [value, setValue] = useState(p.initial ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const save = () => {
    const v = value.trim();
    if (v) p.onSave(v);
  };
  return h(
    "form",
    {
      className: "carton-inline-name",
      onSubmit: (e: { preventDefault(): void }) => {
        e.preventDefault();
        save();
      },
    },
    h("input", {
      ref,
      className: "carton-input",
      value,
      placeholder: p.placeholder,
      "aria-label": p.label,
      maxLength: 120,
      // React fires onChange on every keystroke; preact/compat maps it to the input event, so both behave the same.
      onChange: (e: { currentTarget: HTMLInputElement }) => setValue(e.currentTarget.value),
      onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          p.onCancel();
        }
      },
    }),
    h(Button, { type: "submit", variant: "primary", disabled: !value.trim() }, p.saveLabel),
  );
}
