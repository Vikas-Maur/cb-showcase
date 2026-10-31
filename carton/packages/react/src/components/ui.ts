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
import { actorColor, actorLabel, initials } from "../actors.ts";
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
      "aria-busy": p.busy || undefined,
      "data-carton-tip": p.title,
      disabled: p.disabled || p.busy,
      onClick: p.onClick,
    },
    p.icon ? h(Icon, { name: p.icon }) : null,
    p.children != null ? h("span", { className: "carton-btn-text" }, p.children) : null,
  );
}

export function Avatar({ actor, size = 22, title }: { actor: Actor; size?: number; title?: string }) {
  const ui = useCartonUi();
  const words = useWords();
  const color = actorColor(actor, ui.actor.bind(ui));
  const label = title ?? actorLabel(actor, ui.actor.bind(ui), words.you);
  // Two letters need about 20 px; smaller avatars (history rows, card headers) show one.
  const letters = (s: string) => (size < 20 ? Array.from(s)[0] ?? "?" : s);
  const style: CSSProperties = { width: size, height: size, fontSize: Math.max(7, Math.round(size * (size < 20 ? 0.5 : 0.4))), ["--carton-actor" as string]: color };
  const glyph =
    actor.kind === "human"
      ? h("span", { className: "carton-avatar-initials" }, letters(initials(actor.name)))
      : actor.kind === "subagent"
        ? h("span", { className: "carton-avatar-initials" }, initials(actor.subagentType ?? actor.name).slice(0, 1))
        : h(Icon, { name: "sparkle", size: Math.round(size * 0.62) });
  return h("span", { className: "carton-avatar", "data-kind": actor.kind, style, role: "img", "aria-label": label, "data-carton-tip": label }, glyph);
}

/** An actor's name with its chain: "Director › Explore". */
export function ActorName({ actor }: { actor: Actor }) {
  const ui = useCartonUi();
  const words = useWords();
  const label = actorLabel(actor, ui.actor.bind(ui), words.you);
  // A native title: long chains ("Director › caption-fixer") are cut with an ellipsis in narrow places.
  return h("span", { className: "carton-actor-name", "data-kind": actor.kind, title: label }, label);
}

// ---------------------------------------------------------------- menus

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"])')];
}

// children are optional in the props types because createElement passes them as extra arguments.
export interface MenuListProps {
  children?: ReactNode;
  onClose: () => void;
  label: string;
  style?: CSSProperties;
  className?: string;
  /** Elements whose clicks don't count as "outside" (the trigger). */
  ignore?: () => (HTMLElement | null)[];
}

/** role=menu with arrow-key focus, Escape and click-outside to close. Positioned by the caller. */
export function MenuList(p: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(p.onClose);
  onCloseRef.current = p.onClose;
  const ignoreRef = useRef(p.ignore);
  ignoreRef.current = p.ignore;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) (focusables(el)[0] ?? el).focus();
  }, []);

  useEffect(() => {
    const down = (e: Event) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t)) return;
      if (ignoreRef.current?.().some((x) => x?.contains(t))) return;
      onCloseRef.current();
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
      p.onClose();
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
      "data-carton-tip": p.title,
      tabIndex: -1,
      onClick: () => !p.disabled && p.onSelect(),
    },
    h("span", { className: "carton-menu-icon" }, p.icon ? h(Icon, { name: p.icon }) : radio && p.checked ? h(Icon, { name: "check" }) : null),
    h("span", { className: "carton-menu-text" }, p.children),
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
    btn.current?.focus();
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
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>("button, input, [tabindex='0']");
    (first ?? el)?.focus();
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
