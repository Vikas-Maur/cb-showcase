// The Cuts menu (§0.1: a cut is a separate line of the edit). Switch cuts, make a new cut from here, rename, and fold
// the current cut into Main. Cuts from someone else's copy are read-only (§5.3) and say so. Two cuts with one name
// are told apart by owner ("Bob's main cut").

import { createElement as h, useState } from "react";
import { useCartonUi, useCurrentCut, useCuts, usePreview, useWords } from "../hooks.ts";
import { Icon } from "../icons.ts";
import type { Cut } from "../model.ts";
import { InlineName, MenuButton, MenuItem, MenuLabel, MenuSeparator, cx } from "./ui.ts";

export interface CutsMenuProps {
  /** Fold the current cut into another (opens the Fold in dialog). */
  onFoldIn?: (from: Cut, into: Cut) => void;
  /** Ref "new cut from here" starts from. Default: the preview being watched, else the current cut's newest version. */
  fromRef?: string;
  className?: string;
}

export function CutsMenu(p: CutsMenuProps) {
  const ui = useCartonUi();
  const words = useWords();
  const cuts = useCuts();
  const current = useCurrentCut();
  const preview = usePreview();
  const [mode, setMode] = useState<"menu" | "new" | "rename">("menu");
  // A failed switch, new cut or rename says so next to the menu; nothing fails silently.
  const [error, setError] = useState<string | null>(null);
  const attempt = (run: () => Promise<unknown>, after?: () => void) => {
    setError(null);
    run().then(
      () => after?.(),
      (e: unknown) => setError(e instanceof Error && e.message ? e.message : words.failed),
    );
  };
  const main = cuts.find((c) => c.kind === "main" && !c.readOnly);
  const writable = cuts.filter((c) => !c.readOnly);
  const readOnly = cuts.filter((c) => c.readOnly);
  const fromRef = p.fromRef ?? preview?.ref ?? current?.head;

  const item = (c: Cut, close: () => void) =>
    h(
      MenuItem,
      {
        key: c.id,
        checked: c.current,
        title: c.readOnly ? words.readOnlyCut : undefined,
        hint: c.readOnly ? h(Icon, { name: "lock", size: 12 }) : c.shared ? h(Icon, { name: "users", size: 12 }) : null,
        onSelect: () => {
          close();
          if (!c.current) attempt(() => ui.switchCut(c.id));
        },
      },
      c.label,
    );

  const menu = h(MenuButton, {
    label: words.cuts,
    title: words.cuts,
    triggerClassName: cx("carton-cuts-trigger", p.className),
    onOpenChange: (open) => !open && setMode("menu"),
    trigger: [
      h(Icon, { key: "i", name: "cut" }),
      h("span", { key: "n", className: "carton-cuts-name" }, current?.label ?? words.mainCut),
      h(Icon, { key: "c", name: "caretDown", size: 12 }),
    ],
    children: (close) => {
      const done = () => {
        setMode("menu");
        close();
      };
      if (mode === "new" && fromRef)
        return h(
          "div",
          { className: "carton-menu-form" },
          h(MenuLabel, null, words.newCutName),
          h(InlineName, {
            placeholder: words.newCutPlaceholder,
            label: words.newCutName,
            saveLabel: words.create,
            onSave: (name) => attempt(() => ui.newCut(name, fromRef), done),
            onCancel: () => setMode("menu"),
          }),
        );
      const rename = ui.renameCut;
      if (mode === "rename" && current && rename)
        return h(
          "div",
          { className: "carton-menu-form" },
          h(MenuLabel, null, words.renameCut),
          h(InlineName, {
            initial: current.name,
            label: words.renameCut,
            saveLabel: words.save,
            onSave: (name) => attempt(() => rename.call(ui, current.id, name), done),
            onCancel: () => setMode("menu"),
          }),
        );
      return [
        h(MenuLabel, { key: "l" }, words.cuts),
        ...writable.map((c) => item(c, close)),
        readOnly.length ? h(MenuSeparator, { key: "s0" }) : null,
        ...readOnly.map((c) => item(c, close)),
        h(MenuSeparator, { key: "s1" }),
        h(MenuItem, { key: "new", icon: "plus", disabled: !fromRef, onSelect: () => setMode("new") }, words.newCutFromHere),
        // Offered only when the engine can rename cuts.
        rename ? h(MenuItem, { key: "ren", icon: "pencil", disabled: !current || current.readOnly, onSelect: () => setMode("rename") }, words.renameCut) : null,
        main && current && current.id !== main.id && p.onFoldIn
          ? h(MenuItem, { key: "fold", icon: "fold", onSelect: () => (close(), p.onFoldIn!(current, main)) }, words.foldInto(main.label))
          : null,
      ];
    },
  });
  return h(
    "span",
    { className: "carton-cuts" },
    menu,
    error ? h("span", { className: "carton-cuts-error", role: "alert" }, error) : null,
  );
}
