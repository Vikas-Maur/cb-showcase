// The Windows title bar menu, injected into Cardboard's tab strip bundle by patch-strip.js. It runs in
// that bundle's scope: c is React, n the JSX runtime, w joins class names, T calls main, O listens to
// main, re() is the platform, E and S are motion and AnimatePresence, $/F claim and release room below
// the strip for popovers, W/Y/fe/me are the strip's tab styles, mn its divider, Ae a caret, ae a check.
// Classes are the ones Cardboard's own menus use (the timeline context menu), so they exist in its CSS.
module.exports = String.raw`
const __cbWinBar = re() === "win32";
// Width of the native minimize/maximize/close buttons drawn over the strip's right end.
const __cbCaptionWidth = 138;
const __cbEndInset = (on) => document.documentElement.style.setProperty("--desktop-controls-inset-end", on ? __cbCaptionWidth + "px" : "0px");
__cbWinBar && __cbEndInset(!0);
// Cardboard's logomark (renderer/brand/cardboard-logomark-white.svg).
const __cbMarkPaths = [
  "M20.8757 24.5854C19.2768 24.6999 17.7231 24.6979 16.1415 24.5854C16.1243 24.4771 16.1028 24.3666 16.1028 24.2644L16.077 22.6021L16.0426 20.8274L16.0082 19.0527L15.9738 17.28L15.9609 16.4601C17.6586 16.5603 19.322 16.5623 21.0283 16.4601L21.0089 18.2553L20.9745 20.03L20.938 21.8047L20.9036 23.5774L20.88 24.5813L20.8757 24.5854Z",
  "M26.8281 23.5757L27.3804 15.5322C28.7644 15.2091 30.0473 14.7859 31.3625 14.2482L30.5824 22.1731C29.3811 22.7518 28.1648 23.2138 26.8281 23.5757Z",
  "M10.1465 23.5657C8.84634 23.2161 7.63216 22.7519 6.40723 22.1651L5.625 14.2443C6.92729 14.7738 8.22743 15.2052 9.59419 15.5283L10.1465 23.5657Z",
  "M20.3401 5.63111L20.3186 6.37944C19.2334 6.33242 18.1546 6.32015 17.0436 6.36513L17.0221 5.09951L16.9899 1.78926L16.9727 0.0308854C18.1396 -0.016141 19.2549 -0.00796256 20.4132 0.0451977L20.4025 0.527729L20.3702 3.11213L20.3401 5.63111Z",
  "M12.7384 6.83177C11.7262 7.0301 10.7312 7.25297 9.68468 7.56579L9.26562 1.09251C10.3251 0.824666 11.3759 0.61407 12.4719 0.446411L12.7405 6.83177H12.7384Z",
  "M27.3307 7.56988C26.2992 7.26319 25.2999 7.03419 24.2812 6.83791L24.5069 1.53211L24.5434 0.446411C25.6179 0.609981 26.6709 0.820577 27.7476 1.09251L27.3307 7.56784V7.56988Z",
  "M3.81601 10.451L3.07031 3.66287C3.81386 3.17625 4.5918 2.75506 5.4557 2.38293L6.06601 9.02387C5.27303 9.42871 4.56172 9.89079 3.81816 10.451H3.81601Z",
  "M33.2066 10.4588C32.4781 9.91292 31.7647 9.44061 30.9609 9.03373L31.5713 2.39075C32.418 2.75469 33.1937 3.17588 33.9523 3.66864L33.2066 10.4588Z",
  "M35.6359 17.5689C35.2749 18.3561 34.7935 19.0472 34.1445 19.679L35.103 11.9932L35.4404 11.6661L36.1947 5.75098C36.5987 6.30098 36.8609 6.85916 37.0027 7.49708L36.0206 14.7637L35.6359 17.571V17.5689Z",
  "M2.85171 19.6633C2.20917 19.0478 1.72994 18.3486 1.37321 17.5737L0.982091 14.7296L0 7.49162C0.14828 6.8537 0.401863 6.29347 0.81447 5.73938L1.57306 11.677L1.89111 11.9714L2.84957 19.6612L2.85171 19.6633Z",
];
const __cbMark = () => n.jsx("svg", { viewBox: "0 0 37 25", width: 20, height: 14, fill: "currentColor", "aria-hidden": !0, className: "relative shrink-0", children: __cbMarkPaths.map((d, i) => n.jsx("path", { d }, i)) });
// Accelerators the way Cardboard writes shortcuts on Windows: Ctrl+Shift+E, Ctrl+←.
const __cbKeyNames = { CmdOrCtrl: "Ctrl", CommandOrControl: "Ctrl", Command: "Ctrl", Cmd: "Ctrl", Control: "Ctrl", Option: "Alt", Super: "Win", Meta: "Win", Left: "←", Right: "→", Up: "↑", Down: "↓", Plus: "+", Delete: "Del", Escape: "Esc", Return: "Enter" };
const __cbAccel = (a) => a.split(/\+(?!$)/).map((k) => __cbKeyNames[k] ?? k).join("+");
const __cbLabel = (l) => (l ?? "").replace(/&&?/g, (s) => (s === "&&" ? "&" : ""));
// Hidden items can leave separators doubled or at either end.
const __cbTidy = (items) => items.filter((m, i, a) => m.type !== "separator" || (i > 0 && i < a.length - 1 && a[i - 1].type !== "separator"));
// Motion of Cardboard's menus: a short scale-in, or a fade when reduced motion is on.
const __cbPanelMotion = () => {
  const t = { ease: [0.16, 1, 0.3, 1] };
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { ...t, duration: 0.08 } }
    : { initial: { opacity: 0, scale: 0.965, y: -3 }, animate: { opacity: 1, scale: 1, y: 0 }, exit: { opacity: 0, scale: 0.985, y: -2 }, transition: { ...t, duration: 0.13 } };
};
const __cbPanel = "absolute z-30 overflow-y-auto overscroll-contain rounded-ui-xl border-0 bg-surface-elevated p-[6px] text-neutral-200 shadow-surface-raised outline-none [scrollbar-width:none]";
const __cbItem = "flex h-[30px] w-full cursor-pointer items-center gap-[8px] rounded-ui-md px-panel-gutter text-left text-ui-md whitespace-nowrap outline-none transition-colors duration-motion-fast ease-standard focus:bg-accent focus:text-neutral-50 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none";
const __cbKbd = "inline-flex h-icon-md min-w-icon-md items-center justify-center rounded-ui-xs bg-white/[0.08] px-1 font-sans text-ui-2xs font-medium text-neutral-400";
const __cbRule = "-mx-[6px] my-[4px] h-px bg-white/[0.09]";
const __cbRowH = 30, __cbTop = 38, __cbRootW = 184, __cbGap = 4;
const __cbFocus = (el) => el?.focus({ preventScroll: !0 });
const __cbRows = (el) => (el ? Array.from(el.querySelectorAll('[role^="menuitem"]:not(:disabled)')) : []);

const __cbMenu = ({ separated }) => {
  const [menu, setMenu] = c.useState([]);
  const [open, setOpen] = c.useState(!1);
  const [sub, setSub] = c.useState(null);
  const [vh, setVh] = c.useState(window.innerHeight);
  const wrap = c.useRef(null), rootEl = c.useRef(null), subEl = c.useRef(null);
  const timer = c.useRef(null), focusRoot = c.useRef(null), focusSub = c.useRef(!1);
  const openRef = c.useRef(open);
  openRef.current = open;
  const load = c.useCallback(() => T("window:menu").then((m) => Array.isArray(m) && setMenu(m)).catch(() => {}), []);
  c.useEffect(() => { load(); }, [load]);
  const roots = menu.filter((m) => m.submenu && m.submenu.length > 0);
  const clearTimer = () => { timer.current && clearTimeout(timer.current); timer.current = null; };
  // refocus: hand the keyboard back to the editor. Not when focus already left the strip.
  const close = c.useCallback((refocus) => {
    clearTimer();
    setOpen(!1);
    setSub(null);
    refocus && T("window:menu-close");
  }, []);
  const show = c.useCallback((keyboard) => {
    load();
    focusRoot.current = keyboard ? "first" : "panel";
    setSub(null);
    setOpen(!0);
  }, [load]);
  const toggle = c.useRef(null);
  toggle.current = (keyboard) => (openRef.current ? close(!0) : show(keyboard));
  O("window:menu-open", c.useCallback(() => toggle.current(!0), []));

  // Alt on its own or F10 while the strip has focus; main does the same for the editor below. Not Alt
  // pressed with a mouse button held (in the middle of dragging a tab).
  c.useEffect(() => {
    let armed = !1, held = !1;
    const down = (e) => {
      if (e.key === "F10" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        armed = !1;
        toggle.current(!0);
      } else armed = e.key === "Alt" ? (e.repeat ? armed : !held && !e.shiftKey && !e.ctrlKey && !e.metaKey) : !1;
    };
    // Another key let go while Alt is down is a combination, even one whose press never came here
    // (Alt+PrintScreen).
    const up = (e) => {
      if (e.key !== "Alt") return void (armed = !1);
      if (!armed) return;
      armed = !1;
      e.preventDefault();
      toggle.current(!0);
    };
    const pointer = (e) => {
      held = e.buttons !== 0;
      if (held || e.type !== "pointermove") armed = !1;
    };
    const disarm = () => { armed = !1; };
    const reset = () => { armed = !1; held = !1; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    for (const t of ["pointerdown", "pointerup", "pointermove"]) window.addEventListener(t, pointer, !0);
    window.addEventListener("wheel", disarm, { capture: !0, passive: !0 });
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      for (const t of ["pointerdown", "pointerup", "pointermove"]) window.removeEventListener(t, pointer, !0);
      window.removeEventListener("wheel", disarm, { capture: !0 });
      window.removeEventListener("blur", reset);
    };
  }, []);

  // While open, the strip claims the rest of the window: the menu has room, and a click outside it
  // closes the menu without also landing on the editor, like a native menu.
  c.useEffect(() => {
    if (!open) return;
    $("app-menu", 4e3);
    const down = (e) => { wrap.current && e.target instanceof Node && !wrap.current.contains(e.target) && close(!0); };
    const blur = () => close(!1);
    const resize = () => setVh(window.innerHeight);
    window.addEventListener("pointerdown", down);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", resize);
    resize();
    return () => {
      F("app-menu");
      clearTimer();
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", resize);
    };
  }, [open, close]);
  c.useLayoutEffect(() => {
    if (!open || !rootEl.current || focusRoot.current === null) return;
    __cbFocus(focusRoot.current === "first" ? __cbRows(rootEl.current)[0] : rootEl.current);
    focusRoot.current = null;
  }, [open, roots.length]);
  // Keep the submenu inside the window: it lines up with its row, moving up when it would run off
  // the bottom, and scrolls when the window is shorter than it. Until main has grown the strip
  // (innerHeight is still the 40px bar) there is nothing to measure against.
  c.useLayoutEffect(() => {
    const el = subEl.current;
    if (!open || sub === null || !el) return;
    if (vh > 200) {
      const room = vh - 14;
      const top = Math.max(__cbTop, Math.min(__cbTop + sub * __cbRowH, room - el.scrollHeight));
      el.style.top = top + "px";
      el.style.maxHeight = room - top + "px";
    }
    if (focusSub.current) {
      focusSub.current = !1;
      __cbFocus(__cbRows(el)[0]);
    }
  }, [open, sub, vh, menu]);

  const openSub = (i, keyboard) => {
    clearTimer();
    focusSub.current = keyboard;
    setSub(i);
  };
  // Hover opens a submenu after a moment, and switches more slowly so the pointer can cross other
  // rows on its way into the open one.
  const hoverRoot = (i) => {
    clearTimer();
    if (sub === i) return;
    timer.current = setTimeout(() => { timer.current = null; setSub(i); }, sub === null ? 60 : 160);
  };
  const run = (m) => {
    if (!m.enabled || m.submenu || m.type === "separator") return;
    clearTimer();
    setOpen(!1);
    setSub(null);
    T("window:menu-run", { path: m.path });
  };
  const backToRoot = () => {
    const i = sub;
    setSub(null);
    __cbFocus(__cbRows(rootEl.current)[i]);
  };
  const onKey = (e) => {
    if (!open || e.target === e.currentTarget.firstChild) return;
    const inSub = !!subEl.current && subEl.current.contains(document.activeElement);
    const rows = __cbRows(inSub ? subEl.current : rootEl.current);
    const at = rows.indexOf(document.activeElement);
    const go = (i) => {
      e.preventDefault();
      if (!inSub) { clearTimer(); setSub(null); }
      __cbFocus(rows[(i + rows.length) % rows.length]);
    };
    switch (e.key) {
      case "ArrowDown": return go(at + 1);
      case "ArrowUp": return go(at < 0 ? -1 : at - 1);
      case "Home": return go(0);
      case "End": return go(-1);
      case "ArrowRight":
        if (!inSub && at >= 0) { e.preventDefault(); openSub(at, !0); }
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        if (at < 0) return;
        return inSub ? rows[at].click() : openSub(at, !0);
      case "ArrowLeft":
        if (inSub) { e.preventDefault(); backToRoot(); }
        return;
      case "Escape":
        e.preventDefault();
        return inSub ? backToRoot() : close(!0);
      case "Tab":
        return e.preventDefault();
    }
    // Typeahead: the next row starting with the typed letter.
    if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    const next = [...rows.slice(at + 1), ...rows.slice(0, at + 1)].find((r) => r.textContent.trim().toLowerCase().startsWith(k));
    next && (e.preventDefault(), __cbFocus(next));
  };

  const motion = __cbPanelMotion();
  const caret = n.jsx(Ae, { weight: "bold", "aria-hidden": !0, className: "size-2.5 shrink-0 text-neutral-400", style: { transform: "rotate(-90deg)" } });
  const rootPanel = open
    ? n.jsx(E.div, {
        ref: rootEl,
        role: "menu",
        "aria-label": "Menu",
        tabIndex: -1,
        "data-no-drag": !0,
        ...motion,
        className: __cbPanel,
        style: { top: __cbTop, left: 0, width: __cbRootW, transformOrigin: "top left", maxHeight: vh > 200 ? vh - 14 - __cbTop : void 0 },
        children: roots.map((m, i) =>
          n.jsxs("button", {
            type: "button",
            role: "menuitem",
            "aria-haspopup": "menu",
            "aria-expanded": sub === i,
            tabIndex: -1,
            onPointerMove: (e) => e.currentTarget !== document.activeElement && __cbFocus(e.currentTarget),
            onPointerEnter: () => hoverRoot(i),
            onPointerLeave: clearTimer,
            onClick: () => openSub(i, !1),
            className: w(__cbItem, sub === i && "bg-accent text-neutral-50"),
            children: [n.jsx("span", { className: "min-w-0 flex-1 truncate", children: __cbLabel(m.label) }), caret],
          }, m.path.join(".")),
        ),
      }, "root")
    : null;
  const items = open && sub !== null && roots[sub] ? __cbTidy(roots[sub].submenu) : null;
  const subPanel = items
    ? n.jsx(E.div, {
        ref: subEl,
        role: "menu",
        "aria-label": __cbLabel(roots[sub].label),
        tabIndex: -1,
        "data-no-drag": !0,
        ...motion,
        onPointerEnter: clearTimer,
        onPointerLeave: () => subEl.current?.contains(document.activeElement) && __cbFocus(subEl.current),
        className: __cbPanel,
        style: { top: __cbTop + sub * __cbRowH, left: __cbRootW + __cbGap, minWidth: 248, transformOrigin: "top left" },
        children: items.map((m, j) => {
          if (m.type === "separator") return n.jsx("div", { role: "separator", className: __cbRule }, "s" + j);
          const toggles = m.type === "checkbox" || m.type === "radio";
          return n.jsxs("button", {
            type: "button",
            role: toggles ? (m.type === "radio" ? "menuitemradio" : "menuitemcheckbox") : "menuitem",
            "aria-checked": toggles ? m.checked : void 0,
            tabIndex: -1,
            disabled: !m.enabled,
            onPointerMove: (e) => e.currentTarget !== document.activeElement && __cbFocus(e.currentTarget),
            onClick: () => run(m),
            className: __cbItem,
            children: [
              toggles && n.jsx(ae, { weight: "bold", className: w("size-3 shrink-0", !m.checked && "invisible") }),
              n.jsx("span", { className: "min-w-0 flex-1 truncate", children: __cbLabel(m.label) }),
              m.accelerator && n.jsx("span", { className: "ml-auto flex shrink-0 items-center gap-[3px] pl-[12px]", children: n.jsx("kbd", { className: __cbKbd, children: __cbAccel(m.accelerator) }) }),
            ],
          }, m.path.join("."));
        }),
      }, "sub")
    : null;

  return n.jsxs(n.Fragment, {
    children: [
      n.jsxs("div", {
        ref: wrap,
        "data-no-drag": !0,
        onKeyDown: onKey,
        className: "relative flex shrink-0 items-center",
        children: [
          n.jsxs("button", {
            type: "button",
            "aria-label": "Menu",
            "aria-haspopup": "menu",
            "aria-expanded": open,
            title: "Menu (Alt)",
            onClick: (e) => toggle.current(e.detail === 0),
            onKeyDown: (e) => { !open && e.key === "ArrowDown" && (e.preventDefault(), show(!0)); },
            className: w(W, "w-[28px] shrink-0 justify-center", open ? fe : Y),
            children: [open && n.jsx(me, {}), n.jsx(__cbMark, {})],
          }),
          n.jsx(S, { children: rootPanel }),
          n.jsx(S, { children: subPanel }),
        ],
      }),
      separated && n.jsx(mn, {}),
    ],
  });
};
`;
