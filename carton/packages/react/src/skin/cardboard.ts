// Styles, as strings so a host can inject them without a CSS loader (the Windows build's renderer patch does).
//
// - `baseCss`: structure only (positions of menus and popups, the playhead). Any host needs it; it sets no colours.
// - `cardboardSkin`: looks native in Cardboard 1.4.0. It reads Cardboard's own design tokens (its CSS variables:
//   --popover, --surface-raised, --border-strong, --text-secondary, --font-sans, …) with their 1.4.0 values as
//   fallbacks, so inside the app it follows Cardboard, and in the gallery it looks the same. Sizes follow its
//   Tailwind scale: controls 32/36 px, radius 6/8/10 px, text 11/12/13 px, Geist, thin Phosphor-weight icons.
//
// Everything is scoped under `[data-carton-skin="cardboard"]` and wrapped in :where(), so it never leaks into the
// host and a host rule always wins.

export const baseCss = `
:where(.carton-menu-anchor){position:relative;display:inline-flex}
:where(.carton-menu-pop){position:absolute;top:calc(100% + 6px);left:0;z-index:50}
:where(.carton-menu-anchor[data-align=end] .carton-menu-pop){left:auto;right:0}
:where(.carton-history){position:relative;display:flex;flex-direction:column;min-height:0}
:where(.carton-history-list){flex:1 1 0;min-height:0}
:where(.carton-history-menu){z-index:50}
:where(.carton-overlay){position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center}
:where(.carton-dialog){max-height:calc(100% - 48px);display:flex;flex-direction:column}
:where(.carton-dialog-body){overflow:auto;min-height:0}
:where(.carton-strip-track){position:relative}
:where(.carton-strip){display:flex;position:relative}
:where(.carton-strip-col){position:relative;flex:none}
:where(.carton-shot){position:absolute;top:0;bottom:0}
:where(.carton-playhead){position:absolute;top:0;bottom:0;left:0;width:0;pointer-events:none;will-change:transform}
:where(.carton-strip-scroll){overflow-x:auto;overflow-y:hidden}
:where(.carton-ghost){position:absolute;left:0;top:0;will-change:transform}
:where([data-carton-tip]){position:relative}
:where(.carton-more) > :where(.carton-more-long){display:none}
:where(.carton-more:hover) > :where(.carton-more-short){display:none}
:where(.carton-more:hover) > :where(.carton-more-long){display:inline}
:where(.carton-version, .carton-conflict-who, .carton-credit, .carton-compare-side dl, .carton-comment-head, .carton-comment-meta){-webkit-user-select:none;user-select:none}
`;

const S = '[data-carton-skin="cardboard"]';

export const cardboardSkin = `
:where(${S}){
  --cb-font:var(--font-sans, Geist, ui-sans-serif, system-ui, sans-serif);
  --cb-mono:var(--font-mono, "Geist Mono", ui-monospace, monospace);
  --cb-panel:var(--desktop-panel, #151515);
  --cb-content:var(--desktop-content, #171717);
  --cb-card:var(--card, #202020);
  --cb-popover:var(--popover, #202020);
  --cb-tip:var(--desktop-popover, #161616);
  --cb-raised:var(--surface-raised, #262626);
  --cb-elevated:var(--surface-elevated, #2e2e2e);
  --cb-sunken:var(--surface-sunken, #161616);
  --cb-dialog:var(--surface-dialog, #1f1f1f);
  --cb-secondary:var(--secondary, #303030);
  --cb-accent:var(--accent, #404040);
  --cb-fg:var(--foreground, #d9d9d9);
  --cb-fg-1:var(--text-primary, #f5f5f5);
  --cb-fg-2:var(--text-secondary, #c2c2c2);
  --cb-fg-3:var(--text-tertiary, #999);
  --cb-fg-4:var(--text-disabled, #737373);
  --cb-primary:var(--primary, #f4f4f4);
  --cb-primary-fg:var(--primary-foreground, #1a1a1a);
  --cb-line:var(--border-subtle, #ffffff0f);
  --cb-line-2:var(--border-strong, #ffffff29);
  --cb-ring:var(--ring, #a0a0a0);
  --cb-danger:var(--destructive, #e37878);
  --cb-danger-fill:var(--destructive-fill, #933);
  --cb-ok:var(--status-success, #4ade80);
  --cb-warn:var(--status-warning, #fbbd23);
  --cb-info:var(--status-info, #61a6fa);
  --cb-shadow:var(--shadow-surface-raised, 0 16px 40px -12px #000000b3, 0 0 0 1px #ffffff0a);
  --cb-shadow-near:var(--shadow-surface-near, 0 6px 20px -6px #0000008c, 0 0 0 1px #ffffff0d);
  --cb-fast:var(--motion-duration-fast, .12s);
  --cb-base:var(--motion-duration-base, .18s);
  --cb-ease:var(--motion-ease-standard, cubic-bezier(.2,0,0,1));
  --cb-decel:var(--motion-ease-decelerate, cubic-bezier(.16,1,.3,1));
  font-family:var(--cb-font);font-size:13px;line-height:18px;color:var(--cb-fg);
  -webkit-font-smoothing:antialiased;font-feature-settings:"tnum" 0;
}
:where(${S}) :where(*, *::before, *::after){box-sizing:border-box}
:where(${S}) :where(h2, h3, p, dl, dd, ul, fieldset){margin:0;padding:0}
:where(${S}) :where(ul){list-style:none}
:where(${S}) :where(fieldset){border:0;min-width:0}
:where(${S}) :where(button){font:inherit;color:inherit}
:where(${S}) :where(time, .carton-watch-clock, .carton-watch-summary, .carton-compare-diff){font-variant-numeric:tabular-nums}

/* ---------------------------------------------------------------- buttons (Cardboard's shadcn button) */
:where(${S}) :where(.carton-btn){display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;
  height:32px;padding:0 12px;border:0;border-radius:8px;font-size:13px;font-weight:500;line-height:18px;white-space:nowrap;cursor:pointer;
  outline:none;transition:background-color var(--cb-fast) var(--cb-ease),color var(--cb-fast) var(--cb-ease),box-shadow var(--cb-fast) var(--cb-ease),opacity var(--cb-fast)}
:where(${S}) :where(.carton-btn[data-size=md]){height:36px;padding:0 16px;font-size:14px}
:where(${S}) :where(.carton-btn[data-icon-only]){width:28px;height:28px;padding:0;border-radius:6px}
:where(${S}) :where(.carton-btn:has(> .carton-icon):not([data-icon-only])){padding-left:10px}
:where(${S}) :where(.carton-btn[data-variant=primary]){background:var(--cb-primary);color:var(--cb-primary-fg)}
:where(${S}) :where(.carton-btn[data-variant=primary]:hover:not(:disabled)){background:color-mix(in srgb, var(--cb-primary) 90%, transparent)}
:where(${S}) :where(.carton-btn[data-variant=secondary]){background:var(--cb-secondary);color:var(--cb-fg)}
:where(${S}) :where(.carton-btn[data-variant=secondary]:hover:not(:disabled)){background:color-mix(in srgb, var(--cb-secondary) 80%, #fff 6%)}
:where(${S}) :where(.carton-btn[data-variant=ghost]){background:transparent;color:var(--cb-fg-2)}
:where(${S}) :where(.carton-btn[data-variant=ghost]:hover:not(:disabled)){background:var(--cb-accent);color:var(--cb-fg-1)}
:where(${S}) :where(.carton-btn[data-variant=danger]){background:var(--cb-danger-fill);color:#fff}
:where(${S}) :where(.carton-btn[aria-pressed=true][data-variant=primary]){box-shadow:0 0 0 1px var(--cb-primary)}
:where(${S}) :where(.carton-btn:focus-visible){box-shadow:0 0 0 3px color-mix(in srgb, var(--cb-ring) 50%, transparent)}
:where(${S}) :where(.carton-btn:disabled){opacity:.5;cursor:not-allowed}
:where(${S}) :where(.carton-btn[aria-busy=true]){cursor:progress}
:where(${S}) :where(.carton-icon){flex:none;display:block}

/* ---------------------------------------------------------------- inputs */
:where(${S}) :where(.carton-input){height:32px;min-width:0;flex:1;padding:0 10px;border:1px solid #ffffff1a;border-radius:8px;
  background:var(--cb-sunken);color:var(--cb-fg-1);font:inherit;font-size:13px;outline:none;transition:border-color var(--cb-fast),box-shadow var(--cb-fast)}
:where(${S}) :where(.carton-input::placeholder){color:color-mix(in srgb, var(--cb-fg-3) 72%, transparent)}
:where(${S}) :where(.carton-input:focus){border-color:#ffffff40;box-shadow:none}
:where(${S}) :where(.carton-inline-name){display:flex;align-items:center;gap:6px;width:100%}
:where(${S}) :where(.carton-inline-name .carton-input){height:28px}
:where(${S}) :where(.carton-inline-name .carton-btn){height:28px;padding:0 10px;font-size:12px}
:where(${S}) :where(.carton-check){appearance:none;flex:none;width:14px;height:14px;margin:0;border:1px solid var(--cb-line-2);border-radius:4px;
  background:transparent;display:grid;place-content:center;cursor:pointer;transition:background-color var(--cb-fast)}
:where(${S}) :where(.carton-check:checked){background:var(--cb-primary);border-color:var(--cb-primary)}
:where(${S}) :where(.carton-check:checked)::after{content:"";width:8px;height:4px;margin-top:-2px;border:solid var(--cb-primary-fg);border-width:0 0 1.6px 1.6px;transform:rotate(-45deg)}
:where(${S}) :where(.carton-check:disabled){opacity:.45;cursor:not-allowed}
:where(${S}) :where(.carton-check:focus-visible){box-shadow:0 0 0 3px color-mix(in srgb, var(--cb-ring) 50%, transparent);outline:none}

/* ---------------------------------------------------------------- badges and text */
:where(${S}) :where(.carton-badge){display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;font-size:10.5px;font-weight:500;
  letter-spacing:.01em;white-space:nowrap;background:#ffffff0f;color:var(--cb-fg-2)}
:where(${S}) :where(.carton-badge[data-tone=info]){background:color-mix(in srgb, var(--cb-info) 14%, transparent);color:#9cc7fc}
:where(${S}) :where(.carton-badge[data-tone=warning]){background:color-mix(in srgb, var(--cb-warn) 13%, transparent);color:#fcd77f}
:where(${S}) :where(.carton-badge[data-tone=muted]){background:#ffffff0d;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-muted){color:var(--cb-fg-3);font-size:12px;padding:12px}
:where(${S}) :where(.carton-error){color:var(--cb-danger);font-size:12px;padding:8px 0}
:where(${S}) :where(.carton-empty){color:var(--cb-fg-3);font-size:13px;line-height:19px;text-align:center;padding:32px 24px;text-wrap:pretty}

/* ---------------------------------------------------------------- tooltips (Cardboard's: sunken bg, white/10 border) */
:where(${S}) :where([data-carton-tip]:hover)::after{content:attr(data-carton-tip);position:absolute;left:50%;top:calc(100% + 6px);transform:translateX(-50%);
  z-index:60;width:max-content;max-width:260px;padding:4px 8px;border:1px solid #ffffff1a;border-radius:6px;background:var(--cb-tip);color:var(--cb-fg-1);
  font-size:12px;font-weight:400;line-height:16px;letter-spacing:0;text-transform:none;white-space:normal;text-align:left;pointer-events:none;box-shadow:var(--cb-shadow-near);
  animation:carton-tip var(--cb-base) var(--cb-decel) .45s both}
@keyframes carton-tip{from{opacity:0;transform:translate(-50%,-2px)}to{opacity:1;transform:translate(-50%,0)}}

/* ---------------------------------------------------------------- menus (Cardboard's dropdown menu) */
:where(${S}) :where(.carton-menu){min-width:200px;max-width:320px;padding:4px;border:1px solid #ffffff12;border-radius:8px;background:var(--cb-popover);color:#e5e5e5;
  box-shadow:var(--cb-shadow);outline:none;animation:carton-pop var(--cb-fast) var(--cb-decel)}
@keyframes carton-pop{from{opacity:0;transform:scale(.97) translateY(-2px)}to{opacity:1;transform:none}}
:where(${S}) :where(.carton-menu-item){display:flex;align-items:center;gap:8px;width:100%;min-height:30px;padding:6px 8px;border:0;border-radius:5px;background:none;
  color:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;outline:none}
:where(${S}) :where(.carton-menu-item:hover, .carton-menu-item:focus){background:var(--cb-accent);color:var(--cb-fg-1)}
:where(${S}) :where(.carton-menu-item[aria-disabled=true]){opacity:.5;pointer-events:none}
:where(${S}) :where(.carton-menu-item[data-danger]){color:var(--cb-danger)}
:where(${S}) :where(.carton-menu-icon){display:flex;width:16px;height:16px;flex:none;color:#a3a3a3}
:where(${S}) :where(.carton-menu-item[aria-checked=true] .carton-menu-icon){color:var(--cb-fg-1)}
:where(${S}) :where(.carton-menu-text){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-menu-hint){display:flex;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-menu-sep){height:1px;margin:4px -4px;background:#ffffff0f}
:where(${S}) :where(.carton-menu-label){padding:6px 8px 4px;font-size:11px;font-weight:500;color:var(--cb-fg-3);letter-spacing:.01em}
:where(${S}) :where(.carton-menu-form){display:flex;flex-direction:column;gap:2px;padding:0 4px 4px;min-width:280px}
:where(${S}) :where(.carton-menu-form .carton-menu-label){padding-left:0}

/* ---------------------------------------------------------------- cuts trigger (sits in the top bar like "16:9 ▾") */
:where(${S}) :where(.carton-cuts-trigger){display:inline-flex;align-items:center;gap:6px;height:28px;max-width:260px;padding:0 8px;border:0;border-radius:6px;
  background:transparent;color:var(--cb-fg-1);font-size:13px;font-weight:500;cursor:pointer;outline:none;transition:background-color var(--cb-fast)}
:where(${S}) :where(.carton-cuts-trigger:hover, .carton-cuts-trigger[aria-expanded=true]){background:#ffffff12}
:where(${S}) :where(.carton-cuts-trigger:focus-visible){box-shadow:0 0 0 2px color-mix(in srgb, var(--cb-ring) 50%, transparent)}
:where(${S}) :where(.carton-cuts-trigger .carton-icon){color:var(--cb-fg-3)}
:where(${S}) :where(.carton-cuts-name){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-cuts){display:inline-flex;align-items:center;gap:8px}
:where(${S}) :where(.carton-cuts-error){font-size:12px;color:var(--cb-danger)}
:where(${S}) :where(.carton-menu-form .carton-error){padding:4px 0 0}

/* ---------------------------------------------------------------- panel and History */
:where(${S}) :where(.carton-history){height:100%;background:var(--cb-panel);color:var(--cb-fg)}
:where(${S}) :where(.carton-panel-head){display:flex;flex-direction:column;gap:12px;padding:16px 12px 10px}
:where(${S}) :where(.carton-panel-title){font-size:20px;line-height:26px;font-weight:600;letter-spacing:-.01em;color:var(--cb-fg-1);padding:0 4px}
:where(${S}) :where(.carton-segmented){display:inline-flex;align-self:flex-start;gap:2px;padding:2px;border-radius:8px;background:var(--cb-card)}
:where(${S}) :where(.carton-segment){height:26px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--cb-fg-3);font-size:12px;font-weight:500;cursor:pointer;
  outline:none;transition:background-color var(--cb-fast),color var(--cb-fast)}
:where(${S}) :where(.carton-segment:hover){color:var(--cb-fg-1)}
:where(${S}) :where(.carton-segment[aria-checked=true]){background:var(--cb-secondary);color:var(--cb-fg-1);box-shadow:0 1px 0 #00000040}
:where(${S}) :where(.carton-segment:focus-visible){box-shadow:0 0 0 2px color-mix(in srgb, var(--cb-ring) 50%, transparent)}
:where(${S}) :where(.carton-history-list){outline:none;padding-bottom:8px;scrollbar-width:thin;scrollbar-color:#ffffff1f transparent}
:where(${S}) :where(.carton-vrow){padding:0 6px}
:where(${S}) :where(.carton-version){position:relative;display:flex;align-items:center;gap:8px;height:100%;padding:0 4px 0 6px;border-radius:8px;cursor:default;
  transition:background-color var(--cb-fast)}
:where(${S}) :where(.carton-version:hover){background:#ffffff08}
:where(${S}) :where(.carton-version[data-active], .carton-version[data-menu]){background:#ffffff0f}
/* while one row's menu is open, it is the only row that looks picked (review finding 7) */
:where(${S}) :where(.carton-history[data-menu-open] .carton-version[data-active]:not([data-menu]):not(:hover)){background:transparent}
:where(${S}) :where(.carton-version[data-compared]){background:#ffffff0f;box-shadow:inset 2px 0 0 var(--cb-fg-2)}
:where(${S}) :where(.carton-history-list:focus-visible .carton-version[data-active]){box-shadow:inset 0 0 0 1px var(--cb-line-2)}
/* The rail: one line through every version's mark, like a timeline of versions. */
:where(${S}) :where(.carton-version-mark){position:relative;align-self:stretch;width:20px;flex:none;display:flex;align-items:center;justify-content:center;color:#6b6b6b}
:where(${S}) :where(.carton-version-mark)::before{content:"";position:absolute;left:50%;top:-1px;bottom:-1px;width:1px;background:#ffffff14;transform:translateX(-.5px)}
:where(${S}) :where(.carton-version-mark .carton-icon){position:relative;background:var(--cb-panel);border-radius:50%;box-shadow:0 0 0 2px var(--cb-panel)}
:where(${S}) :where(.carton-version[data-kind=turn] .carton-version-mark){color:#e8c37b}
:where(${S}) :where(.carton-version[data-named] .carton-version-mark){color:#9cc7fc}
:where(${S}) :where(.carton-version[data-kind=fold] .carton-version-mark, .carton-version[data-kind=restore] .carton-version-mark, .carton-version[data-kind=undo] .carton-version-mark){color:var(--cb-fg-2)}
:where(${S}) :where(.carton-version-main){flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
:where(${S}) :where(.carton-version-title){display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;line-height:17px;color:#e5e5e5}
:where(${S}) :where(.carton-version[data-named] .carton-version-title, .carton-version[data-kind=turn] .carton-version-title){font-weight:500;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-version-text){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-version-kind){flex:none;height:16px;padding:0 5px;border:1px solid #e8c37b40;border-radius:4px;color:#e8c37b;font-size:9.5px;font-weight:600;
  line-height:14px;letter-spacing:.06em;text-transform:uppercase}
:where(${S}) :where(.carton-version-meta){display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:16px;color:var(--cb-fg-3);white-space:nowrap}
:where(${S}) :where(.carton-version-meta .carton-actor-name){overflow:hidden;text-overflow:ellipsis;min-width:0;color:var(--cb-fg-2)}
:where(${S}) :where(.carton-version-meta > time, .carton-version-edits){flex:none}
:where(${S}) :where(.carton-version[data-expanded]){align-items:flex-start;padding-top:8px}
:where(${S}) :where(.carton-version-expand){flex:none;display:inline-flex;align-items:center;gap:3px;height:16px;padding:0 4px;border:0;border-radius:4px;background:none;font:inherit;color:var(--cb-fg-3);cursor:pointer}
:where(${S}) :where(.carton-version-expand:hover){background:#ffffff0a;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-version-details){margin:2px 0 0;padding:0;list-style:none;font-size:12px;line-height:18px;color:var(--cb-fg-2)}
:where(${S}) :where(.carton-version-details li){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-version-meta > time)::before, :where(${S}) :where(.carton-version-edits)::before{content:"·";margin-right:6px;color:#5c5c5c}
:where(${S}) :where(.carton-version-meta > time:first-child)::before{content:none}
:where(${S}) :where(.carton-version[data-provisional] .carton-version-title){color:var(--cb-fg-2)}
:where(${S}) :where(.carton-version[data-provisional] .carton-version-mark .carton-icon){animation:carton-pulse 1.6s ease-in-out infinite}
@keyframes carton-pulse{50%{opacity:.35}}
:where(${S}) :where(.carton-version-more){display:flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;border:0;border-radius:6px;
  background:transparent;color:var(--cb-fg-3);cursor:pointer;opacity:0;transition:opacity var(--cb-fast),background-color var(--cb-fast)}
:where(${S}) :where(.carton-version:hover .carton-version-more, .carton-version[data-menu] .carton-version-more, .carton-history-list:focus-within .carton-version[data-active] .carton-version-more){opacity:1}
:where(${S}) :where(.carton-version-more:hover){background:var(--cb-accent);color:var(--cb-fg-1)}
:where(${S}) :where(.carton-history-compare){margin:8px 12px 12px}
/* a day's header in a long History (UI audit P2-17): a quiet divider row with its count; click to fold or open */
:where(${S}) :where(.carton-day){display:flex;align-items:center;gap:8px;height:100%;padding:0 10px 0 6px;border-radius:8px;cursor:pointer;
  color:var(--cb-fg-2);font-size:12px;font-weight:500;line-height:16px;-webkit-user-select:none;user-select:none;transition:background-color var(--cb-fast)}
:where(${S}) :where(.carton-day:hover){background:#ffffff08;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-history-list:focus-visible .carton-day[data-active]){box-shadow:inset 0 0 0 1px var(--cb-line-2)}
:where(${S}) :where(.carton-day-mark){display:flex;align-items:center;justify-content:center;width:20px;flex:none;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-day-label){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-day-count){flex:none;font-size:11.5px;font-weight:400;color:var(--cb-fg-3);font-variant-numeric:tabular-nums}
/* the list scrolled under the filters: a hairline under them (UI audit P3-9) */
:where(${S}) :where(.carton-panel-head){position:relative;z-index:1;transition:box-shadow var(--cb-fast)}
:where(${S}) :where(.carton-history[data-scrolled] > .carton-panel-head){box-shadow:0 1px 0 #ffffff12}
:where(${S}) :where(.carton-history-error){padding:0 12px 8px;text-wrap:pretty}

/* ---------------------------------------------------------------- the change row and the change map (DESIGN §5.1) */
:where(${S}) :where(.carton-changes){display:flex;flex-direction:column;outline:none}
:where(${S}) :where(.carton-change){position:relative;display:grid;grid-template-columns:auto 34px 18px minmax(0,1fr) 22px;align-items:start;column-gap:6px;padding:5px 6px;margin:0 -6px;
  border-radius:6px;font-size:12.5px;line-height:17px;outline:none;transition:background-color var(--cb-fast)}
:where(${S}) :where(.carton-change:not(:has(> .carton-change-lead))){grid-template-columns:34px 18px minmax(0,1fr) 22px}
:where(${S}) :where(.carton-change[data-selectable]){cursor:pointer}
:where(${S}) :where(.carton-change:hover, .carton-change[data-active]){background:#ffffff0a}
:where(${S}) :where(.carton-change:focus-visible){box-shadow:inset 0 0 0 1px var(--cb-line-2)}
:where(${S}) :where(.carton-change[data-playing]){background:#ffffff12}
:where(${S}) :where(.carton-change[data-muted] .carton-change-words){color:var(--cb-fg-4);text-decoration:line-through;text-decoration-color:#ffffff40}
:where(${S}) :where(.carton-change-lead){display:flex;align-items:center;min-height:17px}
:where(${S}) :where(.carton-change-time){color:var(--cb-fg-3);font-variant-numeric:tabular-nums;white-space:nowrap}
:where(${S}) :where(.carton-change-chip){position:relative;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-top:-1px;border-radius:5px;
  background:#3a3a3a;color:#fff}
:where(${S}) :where(.carton-change-chip .carton-icon){stroke-width:2}
:where(${S}) :where(.carton-change-chip[data-clip=video]){background:#2680d9}
:where(${S}) :where(.carton-change-chip[data-clip=title]){background:#4f4096}
:where(${S}) :where(.carton-change-chip[data-clip=caption]){background:#5d4db3}
:where(${S}) :where(.carton-change-chip[data-clip=audio]){background:#1c7054}
:where(${S}) :where(.carton-change-chip[data-clip=image]){background:#a347d1}
:where(${S}) :where(.carton-change-chip[data-clip=code]){background:#b5405f}
:where(${S}) :where(.carton-change-badge){position:absolute;right:-3px;bottom:-3px;display:flex;align-items:center;justify-content:center;width:10px;height:10px;border-radius:50%;
  font-size:9px;line-height:9px;font-weight:700;box-shadow:0 0 0 1.5px var(--cb-card)}
:where(${S}) :where(.carton-change-chip[data-kind=add] .carton-change-badge){background:var(--cb-ok);color:#06240f}
:where(${S}) :where(.carton-change-chip[data-kind=remove] .carton-change-badge){background:var(--cb-danger);color:#2a0b0b}
:where(${S}) :where(.carton-change-chip[data-kind=change] .carton-change-badge){background:var(--cb-warn)}
:where(${S}) :where(.carton-change-text){min-width:0;color:var(--cb-fg-1);overflow-wrap:anywhere}
:where(${S}) :where(.carton-change-tag){margin-left:6px;padding:0 5px;border-radius:4px;background:#ffffff0f;color:var(--cb-fg-3);font-size:11px;white-space:nowrap}
:where(${S}) :where(.carton-change-who){display:block;margin-top:1px;font-size:11.5px;line-height:15px;color:var(--cb-fg-4)}
:where(${S}) :where(.carton-change-play){display:flex;align-items:center;justify-content:center;width:22px;height:22px;margin-top:-3px;border:0;border-radius:5px;background:none;
  color:var(--cb-fg-1);cursor:pointer;opacity:0;transition:opacity var(--cb-fast),background-color var(--cb-fast)}
:where(${S}) :where(.carton-change:hover .carton-change-play, .carton-change:focus-visible .carton-change-play, .carton-change[data-playing] .carton-change-play, .carton-change[data-active] .carton-change-play){opacity:1}
:where(${S}) :where(.carton-change-play:hover){background:#ffffff14}
:where(${S}) :where(.carton-change-progress){grid-column:1 / -1;position:relative;height:2px;margin-top:5px;border-radius:2px;background:#ffffff14;overflow:hidden}
:where(${S}) :where(.carton-change-progress-fill){position:absolute;inset:0;background:var(--cb-fg-1);transform-origin:left;transform:scaleX(0);will-change:transform}
:where(${S}) :where(.carton-map){position:relative;height:18px;margin:2px 0 8px}
:where(${S}) :where(.carton-map-track){position:absolute;left:0;right:0;top:6px;height:6px;border-radius:9px;background:#2c2c2c}
:where(${S}) :where(.carton-map-tick){position:absolute;top:2px;width:4px;height:14px;margin-left:-2px;border-radius:2px;background:var(--cb-warn)}
:where(${S}) :where(.carton-map-tick[data-kind=add]){background:var(--cb-ok)}
:where(${S}) :where(.carton-map-tick[data-kind=remove]){background:var(--cb-danger)}
:where(${S}) :where(.carton-map-tick[data-lit]){box-shadow:0 0 0 2px var(--cb-card),0 0 0 3.5px var(--cb-fg-1);z-index:1}
:where(${S}) :where(.carton-map-playhead){position:absolute;inset:-1px 0;pointer-events:none;will-change:transform;z-index:2}
:where(${S}) :where(.carton-map-playhead)::before{content:"";position:absolute;left:-1px;top:0;bottom:0;width:2px;border-radius:2px;background:var(--cb-fg-1)}
:where(${S}) :where(.carton-map-playhead[hidden]){display:none}

/* ---------------------------------------------------------------- avatars and presence */
:where(${S}) :where(.carton-avatar){--carton-actor:#999;display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:50%;
  background:var(--carton-actor);color:#141414;font-weight:600;letter-spacing:-.02em;line-height:1;user-select:none}
:where(${S}) :where(.carton-avatar[data-kind=agent]){border-radius:30%;background:color-mix(in srgb, var(--carton-actor) 22%, #1c1c1c);color:var(--carton-actor);
  box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--carton-actor) 45%, transparent)}
:where(${S}) :where(.carton-avatar[data-kind=subagent]){border-radius:30%;background:#262626;color:var(--carton-actor);
  box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--carton-actor) 55%, transparent)}
:where(${S}) :where(.carton-presence){display:inline-flex;align-items:center;gap:6px}
:where(${S}) :where(.carton-presence-group){display:inline-flex;align-items:center;padding:2px;border-radius:999px;transition:background-color var(--cb-fast)}
:where(${S}) :where(.carton-presence-group[data-has-agents]){background:#ffffff0a;padding-right:4px}
:where(${S}) :where(.carton-presence-group .carton-peer + .carton-peer){margin-left:-3px}
:where(${S}) :where(.carton-peer){display:inline-flex;border-radius:50%}
:where(${S}) :where(.carton-peer .carton-avatar){box-shadow:0 0 0 2px var(--cb-panel)}
:where(${S}) :where(.carton-peer[data-kind=agent] .carton-avatar, .carton-peer[data-kind=subagent] .carton-avatar){box-shadow:0 0 0 2px var(--cb-panel), inset 0 0 0 1px color-mix(in srgb, var(--carton-actor) 50%, transparent)}
:where(${S}) :where(.carton-peer[data-idle]){opacity:.45;filter:grayscale(.6)}
:where(${S}) :where(.carton-presence-more){display:inline-flex;align-items:center;height:24px;padding:0 7px;border-radius:999px;background:var(--cb-secondary);
  color:var(--cb-fg-2);font-size:11px;font-weight:500}

/* ---------------------------------------------------------------- ghosts of remote drags (over the timeline's clips) */
:where(${S}) :where(.carton-ghost){--carton-actor:#999;border:1.5px dashed var(--carton-actor);border-radius:4px;background:color-mix(in srgb, var(--carton-actor) 16%, transparent);
  transition:transform 60ms linear,width 60ms linear}
:where(${S}) :where(.carton-ghost-tag){position:absolute;left:-1.5px;bottom:calc(100% + 3px);padding:1px 6px;border-radius:4px;background:var(--carton-actor);color:#141414;
  font-size:10.5px;font-weight:600;line-height:15px;white-space:nowrap}

/* ---------------------------------------------------------------- cards: conflict, compare */
:where(${S}) :where(.carton-card){display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid #ffffff0f;border-radius:10px;background:var(--cb-card);color:var(--cb-fg)}
:where(${S}) :where(.carton-card-head){display:flex;align-items:flex-start;gap:8px}
:where(${S}) :where(.carton-card-head > div){flex:1;min-width:0}
:where(${S}) :where(.carton-card-head > .carton-btn){margin:-4px -4px 0 auto}
:where(${S}) :where(.carton-card-title){font-size:13px;line-height:18px;font-weight:600;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-card-sub){margin-top:2px;font-size:12px;line-height:16px;color:var(--cb-fg-3);text-wrap:pretty}
:where(${S}) :where(.carton-card-actions){display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}
:where(${S}) :where(.carton-conflict-icon){color:var(--cb-warn);margin-top:1px}
:where(${S}) :where(.carton-conflict-sides){display:grid;gap:6px}
:where(${S}) :where(.carton-conflict-side){position:relative;padding:8px 10px 9px 12px;border-radius:8px;background:var(--cb-sunken);border:1px solid transparent}
:where(${S}) :where(.carton-conflict-side)::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:2px;border-radius:2px;background:#ffffff26}
:where(${S}) :where(.carton-conflict-side[data-showing]){border-color:#ffffff14}
:where(${S}) :where(.carton-conflict-side[data-showing])::before{background:var(--cb-fg-2)}
:where(${S}) :where(.carton-conflict-who){display:flex;align-items:center;gap:6px;font-size:12px;color:var(--cb-fg-2)}
:where(${S}) :where(.carton-conflict-who time){color:var(--cb-fg-3)}
:where(${S}) :where(.carton-conflict-where){height:18px;padding:0 6px;border-radius:4px;background:#ffffff0d;color:var(--cb-fg-2);font-size:10.5px;font-weight:500;line-height:18px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
:where(${S}) :where(.carton-conflict-who .carton-badge){margin-left:auto}
:where(${S}) :where(.carton-conflict-what){margin-top:4px;font-size:13px;line-height:18px;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-conflicts){display:flex;flex-direction:column;gap:8px}
/* "See it": quiet text buttons on a card (Preview a side, Show on timeline) */
:where(${S}) :where(.carton-see){display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 6px;border:0;border-radius:5px;background:transparent;
  color:var(--cb-fg-2);font:inherit;font-size:12px;line-height:16px;cursor:pointer;transition:background var(--cb-fast) var(--cb-ease),color var(--cb-fast) var(--cb-ease)}
:where(${S}) :where(.carton-see:hover){background:#ffffff0f;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-see:focus-visible){outline:2px solid var(--cb-ring);outline-offset:1px}
:where(${S}) :where(.carton-conflict-who .carton-see){margin:-3px -4px -3px auto}
:where(${S}) :where(.carton-card-head .carton-see-reveal){margin:4px 0 0 -6px}
/* ---------------------------------------------------------------- the floating stack of conflict cards */
:where(${S}) :where(.carton-stack){display:flex;flex-direction:column;align-items:stretch;gap:8px;width:340px;max-width:100%}
:where(${S}) :where(.carton-stack[data-collapsed]){align-items:flex-end;width:auto}
:where(${S}) :where(.carton-stack-head){display:flex;align-items:center;gap:4px;align-self:flex-end;height:32px;padding:0 3px 0 10px;border:1px solid #ffffff14;
  border-radius:9px;background:#1b1b1be6;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:var(--cb-shadow-near)}
:where(${S}) :where(.carton-stack-count){display:inline-flex;align-items:center;gap:6px;margin-right:4px;font-size:12px;font-weight:500;color:var(--cb-warn)}
:where(${S}) :where(.carton-stack-head .carton-btn[data-icon-only]){width:26px;height:26px}
:where(${S}) :where(.carton-stack-cards){position:relative;display:grid}
:where(${S}) :where(.carton-stack-cards[data-behind="1"]){padding-top:8px}
:where(${S}) :where(.carton-stack-cards[data-behind="2"]){padding-top:16px}
:where(${S}) :where(.carton-stack-peek){position:absolute;height:44px;border:1px solid #ffffff1f;border-radius:10px;background:#2a2a2a;box-shadow:var(--cb-shadow-near)}
:where(${S}) :where(.carton-stack-cards > .carton-conflict){position:relative;box-shadow:var(--cb-shadow);animation:carton-pop var(--cb-base) var(--cb-decel)}
:where(${S}) :where(.carton-stack-pill){display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px 0 10px;border-radius:999px;cursor:pointer;
  border:1px solid color-mix(in srgb, var(--cb-warn) 35%, transparent);background:color-mix(in srgb, var(--cb-warn) 14%, #1c1c1c);color:var(--cb-warn);
  font:inherit;font-size:12px;font-weight:500;box-shadow:var(--cb-shadow-near);transition:background var(--cb-fast) var(--cb-ease)}
:where(${S}) :where(.carton-stack-pill:hover){background:color-mix(in srgb, var(--cb-warn) 22%, #1c1c1c)}
:where(${S}) :where(.carton-stack-aside){width:300px;padding:8px;border:1px solid #ffffff12;border-radius:10px;background:var(--cb-popover);box-shadow:var(--cb-shadow);animation:carton-pop var(--cb-fast) var(--cb-decel)}
:where(${S}) :where(.carton-stack-aside-head){padding:2px 4px 6px;font-size:11px;font-weight:500;color:var(--cb-fg-3);text-transform:uppercase;letter-spacing:.04em}
:where(${S}) :where(.carton-stack-aside li){display:flex;align-items:center;gap:8px;padding:4px 4px 4px 6px;border-radius:6px}
:where(${S}) :where(.carton-stack-aside li:hover){background:#ffffff08}
:where(${S}) :where(.carton-stack-aside-title){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--cb-fg-1)}
/* ---------------------------------------------------------------- Carton's layer over Cardboard's stage (the preview's
   column): the preview banner at its top, the card stack in its bottom-right corner. The layer passes clicks through;
   only its own controls take them. The History/Share sidebar beside the chat uses Cardboard's own classes. */
:where(.carton-stage${S}){position:absolute;inset:0;z-index:30;pointer-events:none;background:none}
:where(.carton-stage${S}) > :where(.carton-stage-banner){position:absolute;top:12px;left:12px;right:12px;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
/* a shared project's footage that isn't on this computer (scripts/carton/ui.js MediaNotice): Cardboard's toast look */
:where(${S}) :where(.carton-media-notice){display:flex;align-items:center;gap:8px;max-width:560px;min-height:40px;padding:6px 6px 6px 12px;border:1px solid #ffffff1a;border-radius:10px;
  background:#1b1b1be6;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);color:var(--cb-fg-1);font-size:12px;line-height:16px}
:where(${S}) :where(.carton-media-notice > .carton-icon){color:var(--cb-ok)}
:where(${S}) :where(.carton-media-notice[data-waiting] > .carton-icon){color:var(--cb-warn)}
:where(${S}) :where(.carton-media-notice-text){flex:1;min-width:0;text-wrap:pretty}
/* a short confirmation (Restore, Fold in, Keep …: scripts/carton/ui.js Toast), bottom centre of the stage */
:where(.carton-stage${S}) > :where(.carton-stage-toast){position:absolute;left:12px;right:12px;bottom:52px;display:flex;justify-content:center;pointer-events:none}
:where(${S}) :where(.carton-toast){display:flex;align-items:center;gap:8px;max-width:520px;min-height:40px;padding:4px 4px 4px 12px;border:1px solid #ffffff1a;border-radius:10px;
  background:#1b1b1bf2;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:var(--cb-shadow);color:var(--cb-fg-1);font-size:12px;line-height:16px;pointer-events:auto;
  animation:carton-pop var(--cb-base) var(--cb-decel)}
:where(${S}) :where(.carton-toast > .carton-icon){color:var(--cb-ok)}
/* a failure or a refusal (a save that failed, an undo refused): the warning look of the Offline chip */
:where(${S}) :where(.carton-toast[data-tone=warning]){border-color:color-mix(in srgb, var(--cb-warn) 35%, transparent)}
:where(${S}) :where(.carton-toast[data-tone=warning] > .carton-icon){color:var(--cb-warn)}
/* a shared project's status over the preview (scripts/carton/ui.js LiveChip): who is here, Offline / Syncing */
:where(.carton-stage${S}) > :where(.carton-stage-live){position:absolute;left:12px;bottom:12px;pointer-events:none}
:where(${S}) :where(.carton-live-chip){display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 6px 0 8px;border:1px solid #ffffff14;border-radius:999px;background:#1b1b1be6;
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);color:var(--cb-fg-2);font:inherit;font-size:12px;font-weight:500;cursor:pointer;pointer-events:auto;box-shadow:var(--cb-shadow-near)}
:where(${S}) :where(.carton-live-chip[data-state=ok]){padding:0 4px}
:where(${S}) :where(.carton-live-chip[data-state=offline]){color:#fcd77f;border-color:color-mix(in srgb, var(--cb-warn) 35%, transparent)}
:where(${S}) :where(.carton-live-chip[data-state=offline] .carton-icon){color:var(--cb-warn)}
:where(${S}) :where(.carton-live-chip[data-state=syncing] .carton-icon){animation:carton-spin 1.1s linear infinite}
:where(${S}) :where(.carton-live-chip:focus-visible){outline:none;box-shadow:0 0 0 2px color-mix(in srgb, var(--cb-ring) 50%, transparent)}
:where(${S}) :where(.carton-live-peers){display:inline-flex}
:where(${S}) :where(.carton-live-peers .carton-avatar){box-shadow:0 0 0 2px #1b1b1b}
:where(${S}) :where(.carton-live-peers .carton-avatar + .carton-avatar){margin-left:-4px}
:where(${S}) :where(.carton-live-peers .carton-avatar[data-idle]){opacity:.5}
:where(${S}) :where(.carton-live-more){margin-left:4px;font-size:11px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-toast-text){flex:1;min-width:0;text-wrap:pretty}
:where(${S}) :where(.carton-toast .carton-btn:not([data-icon-only])){height:28px;padding:0 10px;font-size:12px}
:where(${S}) :where(.carton-stage-banner > *){pointer-events:auto;box-shadow:var(--cb-shadow)}
:where(.carton-stage${S}) > :where(.carton-stage-stack){position:absolute;left:12px;right:12px;bottom:12px;max-height:calc(100% - 60px);display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-end;pointer-events:none}
:where(${S}) :where(.carton-stage-stack > *){pointer-events:auto}
/* the layer's own failure (scripts/carton/ui.js CartonBoundary): a small note in its corner, over nothing else */
:where(.carton-stage${S}) > :where(.carton-stage-snag){position:absolute;right:12px;bottom:12px;display:flex;align-items:center;gap:8px;padding:6px 6px 6px 12px;
  border:1px solid #ffffff1a;border-radius:10px;background:#1b1b1be6;color:var(--cb-fg-2);font-size:12px;pointer-events:auto}
:where(.carton-sidebar${S}){font-size:inherit}
:where(${S}) :where(.carton-sidebar .carton-panel-title){display:none}
:where(${S}) :where(.carton-sidebar .carton-panel-head){padding-top:6px}
:where(${S}) :where(.carton-sidebar-history){display:flex;flex-direction:column;flex:1 1 0;min-height:0}
:where(${S}) :where(.carton-sidebar-history > .carton-history){flex:1 1 0;height:auto}
:where(${S}) :where(.carton-sidebar-cuts){flex:none;padding:8px 10px 0}
:where(${S}) :where(.carton-sidebar-watch){display:flex;flex-direction:column;gap:10px;padding:8px 12px 12px}
:where(${S}) :where(.carton-sidebar-watch > .carton-btn){align-self:flex-start}
:where(${S}) :where(.carton-conflicts-count){font-size:12px;font-weight:500;color:var(--cb-warn)}
:where(${S}) :where(.carton-compare-sides){display:grid;grid-template-columns:1fr 1fr;gap:6px}
:where(${S}) :where(.carton-compare-side){padding:10px;border-radius:8px;background:var(--cb-sunken)}
:where(${S}) :where(.carton-compare-label){margin-bottom:8px;font-size:12px;font-weight:600;color:var(--cb-fg-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-facts){display:grid;grid-template-columns:auto 1fr;gap:5px 10px;font-size:12px;line-height:16px}
:where(${S}) :where(.carton-facts dt){color:var(--cb-fg-3)}
:where(${S}) :where(.carton-facts dd){color:var(--cb-fg);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-compare-who){display:flex;align-items:center;gap:5px}
:where(${S}) :where(.carton-compare-diff){display:flex;align-items:center;gap:6px;font-size:13px;font-weight:500;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-compare-diff)::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--cb-warn)}
:where(${S}) :where(.carton-compare-diff[data-same])::before{background:var(--cb-ok)}
/* the changes, in History's words (UI audit P2-5) */
:where(${S}) :where(.carton-compare-changes){display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;background:var(--cb-sunken)}
:where(${S}) :where(.carton-compare-change){position:relative;padding-left:12px;font-size:12.5px;line-height:18px;color:var(--cb-fg-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-compare-change)::before{content:"";position:absolute;left:2px;top:8px;width:4px;height:4px;border-radius:50%;background:var(--cb-fg-3)}
:where(${S}) :where(.carton-compare-more){align-self:flex-start;height:24px;margin-top:-4px;padding:0 8px;font-size:12px}

/* ---------------------------------------------------------------- dialog (Fold in) */
:where(${S}) :where(.carton-overlay){background:#000000a3;animation:carton-fade var(--cb-base) var(--cb-decel)}
@keyframes carton-fade{from{opacity:0}}
:where(${S}) :where(.carton-dialog){width:min(560px, calc(100vw - 32px));border:0;border-radius:12px;background:var(--cb-dialog);box-shadow:var(--cb-shadow);
  outline:none;animation:carton-pop var(--cb-base) var(--cb-decel)}
:where(${S}) :where(.carton-dialog-head){display:flex;align-items:center;gap:8px;padding:16px 16px 8px 20px}
:where(${S}) :where(.carton-dialog-title){flex:1;min-width:0;font-size:15px;line-height:20px;font-weight:600;color:var(--cb-fg-1);text-wrap:balance}
:where(${S}) :where(.carton-dialog-body){display:flex;flex-direction:column;gap:14px;padding:4px 20px 16px}
:where(${S}) :where(.carton-dialog-foot){display:flex;align-items:center;gap:8px;padding:12px 16px 16px 20px;border-top:1px solid #ffffff0d}
:where(${S}) :where(.carton-dialog-foot > :first-child){flex:1}
:where(${S}) :where(.carton-fold-legend){display:flex;align-items:center;justify-content:space-between;width:100%;margin-bottom:6px;font-size:12px;font-weight:500;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-fold-bulk){display:flex;gap:2px}
:where(${S}) :where(.carton-fold-bulk .carton-btn){height:24px;padding:0 8px;font-size:12px}
:where(${S}) :where(.carton-fold-list){display:flex;flex-direction:column;border:1px solid #ffffff0f;border-radius:8px;overflow:hidden}
:where(${S}) :where(.carton-fold-change + .carton-fold-change){border-top:1px solid #ffffff0a}
:where(${S}) :where(.carton-fold-change label){display:grid;grid-template-columns:14px 1fr;gap:4px 10px;align-items:center;padding:9px 12px;cursor:pointer;transition:background-color var(--cb-fast)}
:where(${S}) :where(.carton-fold-change label:hover){background:#ffffff06}
:where(${S}) :where(.carton-fold-text){font-size:13px;line-height:18px;color:var(--cb-fg-1);min-width:0}
:where(${S}) :where(.carton-fold-meta){grid-column:2;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-fold-meta time)::before{content:"·";margin-right:6px;color:#5c5c5c}
:where(${S}) :where(.carton-fold-change[data-left] .carton-fold-text){color:var(--cb-fg-4);text-decoration:line-through;text-decoration-color:#ffffff40}
:where(${S}) :where(.carton-fold-change[data-left] .carton-fold-meta){opacity:.6}
:where(${S}) :where(.carton-fold-cards){display:flex;flex-direction:column;gap:8px}
:where(${S}) :where(.carton-fold-cards-head){font-size:12px;font-weight:500;color:var(--cb-warn)}
:where(${S}) :where(.carton-fold-cards .carton-card){background:var(--cb-raised)}
:where(${S}) :where(.carton-fold-cards .carton-conflict-side){background:var(--cb-content)}
:where(${S}) :where(.carton-fold-warnings){padding:10px 12px;border-radius:8px;background:color-mix(in srgb, var(--cb-warn) 7%, transparent);border:1px solid color-mix(in srgb, var(--cb-warn) 18%, transparent)}
:where(${S}) :where(.carton-fold-warnings p){display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:#fcd77f}
:where(${S}) :where(.carton-fold-warnings li){margin-top:4px;padding-left:20px;font-size:12px;line-height:16px;color:var(--cb-fg-2)}
:where(${S}) :where(.carton-fold-later){font-size:12px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-join-dialog){width:min(440px, calc(100vw - 32px))}
:where(${S}) :where(.carton-join-lead){font-size:13px;line-height:19px;color:var(--cb-fg-3);text-wrap:pretty}
:where(${S}) :where(.carton-fold-tag){flex:none;height:16px;padding:0 5px;border:1px solid #ffffff1f;border-radius:4px;font-size:11px;line-height:14px;color:var(--cb-fg-2)}
:where(${S}) :where(.carton-fold-missing){padding:10px 12px;border-radius:8px;background:var(--cb-sunken);font-size:13px;line-height:19px;color:var(--cb-fg-1);text-wrap:pretty}

/* ---------------------------------------------------------------- toolbar status: sync, published, undo, credits */
:where(${S}) :where(.carton-sync){display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-radius:6px;font-size:12px;font-weight:500;color:var(--cb-fg-2);white-space:nowrap}
:where(${S}) :where(.carton-sync[data-state=syncing] .carton-icon){animation:carton-spin 1.1s linear infinite;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-sync[data-state=upToDate] .carton-icon){color:var(--cb-ok)}
:where(${S}) :where(.carton-sync[data-state=offline]){color:#fcd77f}
:where(${S}) :where(.carton-sync[data-state=offline] .carton-icon){color:var(--cb-warn)}
@keyframes carton-spin{to{transform:rotate(360deg)}}
:where(${S}) :where(.carton-published){display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 12px;border:1px solid #ffffff0f;border-radius:10px;background:var(--cb-card)}
:where(${S}) :where(.carton-published-actions){display:flex;gap:6px;margin-left:auto}
:where(${S}) :where(.carton-published > .carton-icon){color:var(--cb-fg-3)}
:where(${S}) :where(.carton-published[data-stale] > .carton-icon){color:var(--cb-warn)}
:where(${S}) :where(.carton-published-text){flex:1 1 200px;min-width:0;display:flex;flex-direction:column;gap:3px}
:where(${S}) :where(.carton-published-name){font-size:13px;font-weight:500;color:var(--cb-fg-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-published-meta){display:flex;align-items:center;gap:6px;font-size:12px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-published-meta time)::before{content:"·";margin-right:6px;color:#5c5c5c}
:where(${S}) :where(.carton-undo-wrap){display:inline-flex;align-items:center;gap:8px}
:where(${S}) :where(.carton-undo-note){font-size:12px;color:#fcd77f}
:where(${S}) :where(.carton-popover){width:320px;padding:12px;border:1px solid #ffffff12;border-radius:8px;background:var(--cb-popover);color:#e5e5e5;box-shadow:var(--cb-shadow);
  animation:carton-pop var(--cb-fast) var(--cb-decel)}
:where(${S}) :where(.carton-popover-head){margin-bottom:8px}
:where(${S}) :where(.carton-popover-title){font-size:13px;font-weight:600;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-credits-list){display:flex;flex-direction:column}
:where(${S}) :where(.carton-credit){display:grid;grid-template-columns:56px 1fr auto;align-items:center;gap:8px;padding:6px 0;font-size:12px}
:where(${S}) :where(.carton-credit + .carton-credit){border-top:1px solid #ffffff0a}
:where(${S}) :where(.carton-credit-what){color:var(--cb-fg-3)}
:where(${S}) :where(.carton-credit-who){display:flex;align-items:center;gap:6px;min-width:0;color:var(--cb-fg-1);font-size:13px}
:where(${S}) :where(.carton-credit-who .carton-actor-name){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-credit-when){color:var(--cb-fg-3)}

/* ---------------------------------------------------------------- read-only preview banner (Cardboard's recovery look) */
:where(${S}) :where(.carton-preview-banner){display:flex;flex-wrap:wrap;row-gap:6px;align-items:center;gap:8px;max-width:100%;min-height:40px;padding:6px 6px 6px 12px;border:1px solid #fcd34d33;border-radius:10px;
  background:#17140de6;color:#fde68a;font-size:12px;font-weight:500}
:where(${S}) :where(.carton-preview-banner > .carton-icon){color:#fcd34dcc}
:where(${S}) :where(.carton-preview-label){flex:1 1 140px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-preview-banner .carton-badge){background:#fcd34d1a;color:#fcd77fcc}
:where(${S}) :where(.carton-preview-blocked){color:#fde68acc;font-weight:400}
:where(${S}) :where(.carton-preview-banner .carton-btn){margin-left:auto;height:28px;padding:0 10px 0 8px;font-size:12px}
:where(${S}) :where(.carton-preview-banner .carton-badge, .carton-preview-banner > .carton-icon){flex:none}
:where(${S}) :where(.carton-preview-blocked){flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---------------------------------------------------------------- Watch the changes */
:where(${S}) :where(.carton-watch){display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;background:var(--cb-panel);outline:none}
:where(${S}) :where(.carton-watch-head){display:flex;align-items:flex-start;gap:10px}
:where(${S}) :where(.carton-watch-titles){flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
:where(${S}) :where(.carton-watch-summary){font-size:12px;line-height:16px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-watch-head > .carton-btn){margin:-4px -4px 0 auto}
:where(${S}) :where(.carton-watch-abrow){display:flex}
:where(${S}) :where(.carton-watch-stage){aspect-ratio:16/9;max-height:320px;border-radius:8px;overflow:hidden;background:#0f0f0f}
/* no picture of its own: one line saying where the picture is, not a 16:9 stand-in */
:where(${S}) :where(.carton-watch-stage[data-note]){aspect-ratio:auto;max-height:none;background:none;overflow:visible}
:where(${S}) :where(.carton-stage-note){display:flex;align-items:center;gap:8px;min-height:32px;padding:6px 10px;border-radius:8px;background:var(--cb-sunken);font-size:12px;line-height:16px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-stage-side){flex:none;padding:1px 6px;border-radius:4px;background:#ffffff0f;font-size:11px;font-weight:600;line-height:16px}
:where(${S}) :where(.carton-stage-note[data-side=a] .carton-stage-side){color:#f4a3a3}
:where(${S}) :where(.carton-stage-note[data-side=b] .carton-stage-side){color:#86efac}
/* the controls wrap at a narrow width (300 px panel) instead of running out of it */
:where(${S}) :where(.carton-watch-controls){display:flex;flex-wrap:wrap;align-items:center;gap:6px}
:where(${S}) :where(.carton-watch-where){display:inline-flex;align-items:baseline;gap:8px;margin-left:auto;white-space:nowrap}
:where(${S}) :where(.carton-watch-count){font-size:12px;font-weight:500;color:var(--cb-fg-2)}
:where(${S}) :where(.carton-watch-clock){font-size:12px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-strips){display:grid;grid-template-columns:52px 1fr;gap:0 6px;padding:8px 0 2px;border-top:1px solid #ffffff0a}
:where(${S}) :where(.carton-strip-labels){display:grid;grid-template-rows:40px 40px;row-gap:4px;font-size:11px;font-weight:500;color:var(--cb-fg-4)}
:where(${S}) :where(.carton-strip-labels span){display:flex;align-items:center}
:where(${S}) :where(.carton-strip-labels span[data-active]){color:var(--cb-fg-1)}
:where(${S}) :where(.carton-strip-scroll){scrollbar-width:thin;scrollbar-color:#ffffff1f transparent;padding-bottom:6px}
:where(${S}) :where(.carton-strip-track){display:grid;grid-template-rows:40px 40px;row-gap:4px}
:where(${S}) :where(.carton-strip){gap:0}
:where(${S}) :where(.carton-strip-col){height:40px;border-right:2px solid var(--cb-panel);border-radius:5px;overflow:hidden;cursor:pointer}
:where(${S}) :where(.carton-shot){--carton-shot-hue:0;border-right:1px solid #00000059;background-color:hsl(var(--carton-shot-hue) 26% 30%);background-size:cover;background-position:center}
:where(${S}) :where(.carton-shot-label){position:absolute;left:5px;right:4px;top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;font-weight:500;color:#ffffffd9;text-shadow:0 1px 2px #00000080}
:where(${S}) :where(.carton-strip-col[data-kind=same]){opacity:.62}
:where(${S}) :where(.carton-strip-col[data-kind=same]:hover){opacity:.85}
:where(${S}) :where(.carton-strip-col[data-tone])::after{content:"";position:absolute;inset:0;border-radius:5px;pointer-events:none}
:where(${S}) :where(.carton-strip[data-side=a] .carton-strip-col[data-tone=changed])::after, :where(${S}) :where(.carton-strip-col[data-tone=removed])::after{
  background:#e3787826;box-shadow:inset 0 0 0 1.5px #e37878}
:where(${S}) :where(.carton-strip[data-side=b] .carton-strip-col[data-tone=changed])::after, :where(${S}) :where(.carton-strip-col[data-tone=added])::after{
  background:#4ade8022;box-shadow:inset 0 0 0 1.5px #4ade80}
:where(${S}) :where(.carton-strip-col[data-tone=empty]){background:repeating-linear-gradient(135deg, #ffffff08 0 6px, transparent 6px 12px);cursor:pointer}
:where(${S}) :where(.carton-strip-col[data-tone=empty])::after{box-shadow:inset 0 0 0 1px #ffffff14}
:where(${S}) :where(.carton-strip-empty){position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:500;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-strip-col[data-kind=fold]){display:flex;align-items:center;justify-content:center;padding:0;border:0;border-right:2px solid var(--cb-panel);
  background:#ffffff08;color:var(--cb-fg-3);font-size:10.5px;font-weight:500;text-align:center;line-height:13px}
:where(${S}) :where(.carton-strip-col[data-kind=fold]:hover){background:#ffffff12;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-fold-chip){padding:0 6px}
:where(${S}) :where(.carton-playhead){z-index:2}
:where(${S}) :where(.carton-playhead)::before{content:"";position:absolute;top:-2px;bottom:-2px;left:-1px;width:2px;border-radius:1px;background:var(--cb-fg-1);box-shadow:0 0 0 1px #00000080}
:where(${S}) :where(.carton-playhead)::after{content:"";position:absolute;top:-6px;left:-5px;border:5px solid transparent;border-top-color:var(--cb-fg-1)}

@media (prefers-reduced-motion: reduce){
  :where(${S}) *, :where(${S}) *::before, :where(${S}) *::after{animation:none!important;transition:none!important}
}
/* the sidebar is narrow: Compare's two sides one above the other (after the Compare rules above, so it wins) */
:where(${S}) :where(.carton-sidebar .carton-compare-sides){grid-template-columns:1fr}
/* a menu item's description, on its own line under the name (no tooltip over the next item) */
:where(${S}) :where(.carton-menu-item[data-described]){height:auto;min-height:32px;padding-top:6px;padding-bottom:6px;align-items:flex-start}
:where(${S}) :where(.carton-menu-item[data-described] .carton-menu-text){display:flex;flex-direction:column;gap:1px;white-space:normal}
:where(${S}) :where(.carton-menu-desc){font-size:11.5px;line-height:15px;color:var(--cb-fg-3);font-weight:400}
`;

/** Add a stylesheet once per document (by id). Returns the <style> element. */
export function injectStyles(doc: Document, css: string, id: string): HTMLStyleElement {
  let el = doc.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = id;
    doc.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
  return el;
}

/** Add the structural base and the Cardboard skin. Put `data-carton-skin="cardboard"` on the root you mount into. */
export function injectCardboardSkin(doc: Document = document): void {
  injectStyles(doc, baseCss, "carton-base-css");
  injectStyles(doc, cardboardSkin, "carton-skin-cardboard");
}
