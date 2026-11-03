// Carton UX v2, History (docs/carton-ux/v2 DESIGN-V2 §2–§4; N2): the search field and its results, landmark rows
// and their pictures, Go back… and Bring back one clip in the card, the Compare button and pick mode. Kept apart from
// the first skin (cardboard.ts) so the two can change separately; injected with it (`injectCardboardSkin`). Same rules:
// scoped under `[data-carton-skin="cardboard"]`, wrapped in :where(), Cardboard's tokens.

const S = '[data-carton-skin="cardboard"]';

export const historyV2Css = `
/* ---------------------------------------------------------------- search (§2.3) */
:where(${S}) :where(.carton-search){position:relative;display:flex;align-items:center;gap:8px;height:32px;margin:0 12px 8px;padding:0 6px 0 10px;border:1px solid var(--cb-line-2);
  border-radius:8px;background:var(--cb-sunken);transition:border-color var(--cb-fast),box-shadow var(--cb-fast)}
:where(${S}) :where(.carton-search:focus-within){border-color:color-mix(in srgb, var(--cb-ring) 70%, transparent);box-shadow:0 0 0 3px color-mix(in srgb, var(--cb-ring) 22%, transparent)}
:where(${S}) :where(.carton-search-icon){flex:none;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-search-input){flex:1;min-width:0;height:100%;padding:0;border:0;background:none;font:inherit;font-size:13px;color:var(--cb-fg-1);outline:none}
:where(${S}) :where(.carton-search-input::placeholder){color:color-mix(in srgb, var(--cb-fg-3) 72%, transparent)}
:where(${S}) :where(.carton-search-x){display:flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;border:0;border-radius:5px;background:none;color:var(--cb-fg-3);cursor:pointer}
:where(${S}) :where(.carton-search-x:hover){background:#ffffff14;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-hit){background:color-mix(in srgb, var(--cb-warn) 26%, transparent);color:inherit;border-radius:3px;padding:0 1px;margin:0 -1px}
:where(${S}) :where(.carton-find-count){margin:2px 14px 2px;font-size:11.5px;line-height:16px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-find-why){flex:none;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-find-snippet){min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--cb-fg-2)}
:where(${S}) :where(.carton-find-why ~ .carton-find-snippet, .carton-find-why ~ .carton-actor-name, .carton-find-why ~ .carton-more)::before{content:"";display:inline-block;width:3px;height:3px;margin:0 6px 2px 0;border-radius:50%;background:var(--cb-fg-4);vertical-align:middle}
:where(${S}) :where(.carton-find-clip){display:flex;align-items:center;gap:8px;margin:0 12px 8px;padding:8px 8px 8px 0;border-radius:8px;background:#ffffff08}
:where(${S}) :where(.carton-find-clip .carton-clip-credits){flex:1;min-width:0;margin:0;padding:0 0 0 10px;background:none}
:where(${S}) :where(.carton-find-clip .carton-find-only){flex:none;height:28px;padding:0 10px;font-size:12.5px;border-radius:7px}
:where(${S}) :where(.carton-find-empty){padding:28px 22px;text-align:center}
:where(${S}) :where(.carton-find-empty-title){margin:0 0 6px;font-size:13px;font-weight:600;color:var(--cb-fg-1);text-wrap:balance}
:where(${S}) :where(.carton-find-empty-body){margin:0 0 6px;font-size:12.5px;line-height:18px;color:var(--cb-fg-3);text-wrap:pretty}
:where(${S}) :where(.carton-find-empty .carton-btn){margin-top:8px;height:28px;padding:0 12px;font-size:12.5px;border-radius:7px}

/* ---------------------------------------------------------------- landmark rows (§2.1, §2.2) */
:where(${S}) :where(.carton-version[data-landmark]:not([data-child])){grid-template-columns:44px minmax(0,1fr) auto}
:where(${S}) :where(.carton-landmark-tile){grid-row:1 / span 2;align-self:center;display:flex;align-items:center;justify-content:center;width:44px;height:25px;overflow:hidden;
  border-radius:5px;background:#1d2533;color:var(--cb-fg-3);box-shadow:inset 0 0 0 1px #ffffff14}
:where(${S}) :where(.carton-landmark-tile[data-kind=before], .carton-landmark-tile[data-kind=start]:not([data-picture])){background:var(--cb-raised)}
:where(${S}) :where(.carton-landmark-tile img){display:block;width:100%;height:100%;object-fit:cover}
:where(${S}) :where(.carton-landmark-tag){display:inline-block;margin-right:6px;padding:0 5px;border-radius:4px;font-size:10px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;vertical-align:1px;
  background:#ffffff12;color:var(--cb-fg-2)}
:where(${S}) :where(.carton-landmark-tag[data-tone=ok]){background:color-mix(in srgb, var(--cb-ok) 16%, transparent);color:#86efac}
:where(${S}) :where(.carton-landmark-tag[data-tone=info]){background:color-mix(in srgb, var(--cb-info) 16%, transparent);color:#9cc7fc}
:where(${S}) :where(.carton-landmark-tag[data-tone=warn]){background:color-mix(in srgb, var(--cb-warn) 16%, transparent);color:#fcd77f}
:where(${S}) :where(.carton-landmark-title[data-named]){font-weight:600}
:where(${S}) :where(.carton-version[data-landmark] .carton-version-title){font-weight:400}

/* ---------------------------------------------------------------- hold to peek (§2.4) */
:where(${S}) :where(.carton-version[data-hold]){background:#8ab4ff14;box-shadow:inset 2px 0 0 #8ab4ff}
:where(${S}) :where(.carton-version[data-hold] .carton-version-when){visibility:visible!important;color:#8ab4ff}
:where(${S}) :where(.carton-version[data-hold] .carton-version-more){opacity:0!important}

/* ---------------------------------------------------------------- Go back… and Bring back one clip (§3) */
:where(${S}) :where(.carton-goback, .carton-bringback, .carton-bringback-confirm){margin-top:2px}
:where(${S}) :where(.carton-goback-title){margin:0!important;font-size:13px;line-height:18px;font-weight:600;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-goback-sub){margin:2px 0 8px!important;font-size:12px;line-height:17px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-goback-choices){display:flex;flex-direction:column;gap:4px}
:where(${S}) :where(.carton-goback-choice){display:flex;align-items:flex-start;gap:10px;width:100%;padding:8px 10px;border:1px solid transparent;border-radius:8px;background:none;
  font:inherit;text-align:left;color:inherit;cursor:pointer;transition:background-color var(--cb-fast),border-color var(--cb-fast)}
:where(${S}) :where(.carton-goback-choice:hover){background:#ffffff08}
:where(${S}) :where(.carton-goback-choice[aria-checked=true]){background:var(--cb-raised);border-color:var(--cb-line-2)}
:where(${S}) :where(.carton-goback-choice:focus-visible){outline:none;box-shadow:0 0 0 2px color-mix(in srgb, var(--cb-ring) 50%, transparent)}
:where(${S}) :where(.carton-goback-radio){flex:none;width:14px;height:14px;margin-top:2px;border:1.5px solid var(--cb-fg-3);border-radius:50%;box-sizing:border-box}
:where(${S}) :where(.carton-goback-choice[aria-checked=true] .carton-goback-radio){border:4px solid var(--cb-fg-1)}
:where(${S}) :where(.carton-goback-text){display:flex;flex-direction:column;gap:2px;min-width:0}
:where(${S}) :where(.carton-goback-name){font-size:13px;line-height:18px;font-weight:500;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-goback-line){font-size:12px;line-height:16px;color:var(--cb-fg-3);text-wrap:pretty}
:where(${S}) :where(.carton-goback-hint){font-size:11.5px;color:var(--cb-fg-4);white-space:nowrap}
:where(${S}) :where(.carton-goback-note){margin:8px 0 0;font-size:12px;color:var(--cb-fg-2)}
/* N0b's refusal: the clip changed again since the confirmation showed it (its words, above the question asked again) */
:where(${S}) :where(.carton-goback-warn){display:flex;gap:6px;margin:0 0 8px!important;padding:6px 8px;border-radius:6px;font-size:12px;line-height:16px;
  background:color-mix(in srgb, var(--cb-warn) 12%, transparent);color:#fcd77f}
:where(${S}) :where(.carton-bringback-head){display:flex;align-items:center;gap:6px}
:where(${S}) :where(.carton-bringback-back){display:flex;align-items:center;justify-content:center;width:22px;height:22px;margin-left:-4px;border:0;border-radius:5px;background:none;color:var(--cb-fg-2);cursor:pointer}
:where(${S}) :where(.carton-bringback-back:hover){background:#ffffff12;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-bringback-find){height:28px;margin:0 0 6px;font-size:12.5px}
:where(${S}) :where(.carton-bringback-list){display:flex;flex-direction:column}
:where(${S}) :where(.carton-bringback-group){margin:8px 0 2px!important;font-size:11.5px;line-height:16px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-bringback-row){position:relative;display:flex;align-items:center;gap:10px;min-height:44px;padding:4px 6px;margin:0 -6px;border-radius:7px}
:where(${S}) :where(.carton-bringback-row:hover, .carton-bringback-row:focus-within){background:#ffffff0a}
:where(${S}) :where(.carton-bringback-icon){display:flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;border-radius:5px;background:#3b82f6;color:#fff}
:where(${S}) :where(.carton-bringback-icon[data-clip=title]){background:#7c3aed}
:where(${S}) :where(.carton-bringback-icon[data-clip=caption]){background:#6d5bd0}
:where(${S}) :where(.carton-bringback-icon[data-clip=audio]){background:#0d9488}
:where(${S}) :where(.carton-bringback-icon[data-clip=image]){background:#ca8a04}
:where(${S}) :where(.carton-bringback-icon[data-clip=code]){background:#475569}
:where(${S}) :where(.carton-bringback-text){display:flex;flex-direction:column;flex:1;min-width:0}
:where(${S}) :where(.carton-bringback-name){font-size:13px;line-height:18px;color:var(--cb-fg-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-bringback-meta){font-size:11.5px;line-height:16px;color:var(--cb-fg-3);text-wrap:pretty}
:where(${S}) :where(.carton-bringback-btn){flex:none;height:26px;padding:0 9px;font-size:12px;border-radius:6px;opacity:0;transition:opacity var(--cb-fast)}
:where(${S}) :where(.carton-bringback-row:hover .carton-bringback-btn, .carton-bringback-btn:focus-visible){opacity:1}
@media (hover: none){ :where(${S}) :where(.carton-bringback-btn){opacity:1} }
:where(${S}) :where(.carton-bringback-confirm){padding:10px;border-radius:8px;background:var(--cb-raised);box-shadow:inset 0 0 0 1px #ffffff10}

:where(${S}) :where(.carton-bringback-same){margin:8px 0 0!important;font-size:11.5px;line-height:16px;color:var(--cb-fg-3)}

/* ---------------------------------------------------------------- Compare and pick mode (§4) */
:where(${S}) :where(.carton-compare-anchor){flex:none;align-self:flex-start;margin-top:1px}
:where(${S}) :where(.carton-compare-btn){display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border:1px solid var(--cb-line-2);border-radius:7px;background:none;
  font:inherit;font-size:12.5px;font-weight:500;color:var(--cb-fg-1);cursor:pointer;white-space:nowrap}
:where(${S}) :where(.carton-compare-btn:hover, .carton-compare-btn[data-active]){background:#ffffff0d}
:where(${S}) :where(.carton-compare-btn:focus-visible){outline:none;box-shadow:0 0 0 2px color-mix(in srgb, var(--cb-ring) 50%, transparent)}
/* an icon alone at the panel's narrowest (§4.2) */
@container (max-width: 316px){ :where(${S}) :where(.carton-compare-word){display:none} :where(${S}) :where(.carton-compare-btn){width:28px;padding:0;justify-content:center} }
:where(${S}) :where(.carton-compare-menu){width:280px;max-width:calc(100vw - 24px)}
/* the cut bar's Compare menu spans the bar, as the cuts menu does (never past the panel's edge at 300 px) */
:where(${S}) :where(.carton-cutbar .carton-compare-anchor){position:static}
:where(${S}) :where(.carton-cutbar .carton-compare-anchor .carton-menu-pop){left:12px;right:10px}
:where(${S}) :where(.carton-cutbar .carton-compare-menu){width:auto;max-width:none}
/* the pick line's cut menu spans the line itself, never wider than the panel (300 px) */
:where(${S}) :where(.carton-pick-line){position:relative}
:where(${S}) :where(.carton-pick-line .carton-pick-cut){position:static}
:where(${S}) :where(.carton-pick-line .carton-menu-pop){left:0;right:0;top:calc(100% + 4px)}
:where(${S}) :where(.carton-pick-line .carton-compare-menu){width:auto;max-width:none}
:where(${S}) :where(.carton-compare-entry){gap:10px}
:where(${S}) :where(.carton-compare-entry .carton-landmark-tile){width:40px;height:23px}
:where(${S}) :where(.carton-pick-line){display:flex;align-items:flex-start;gap:8px;margin:0 12px 8px;padding:8px 8px 8px 10px;border-radius:8px;
  background:color-mix(in srgb, #8ab4ff 9%, transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb, #8ab4ff 26%, transparent)}
:where(${S}) :where(.carton-pick-icon){flex:none;margin-top:2px;color:#8ab4ff}
:where(${S}) :where(.carton-pick-text){flex:1;min-width:0}
:where(${S}) :where(.carton-pick-title){margin:0!important;font-size:12.5px;line-height:17px;font-weight:600;color:var(--cb-fg-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(${S}) :where(.carton-pick-sub){display:flex;flex-wrap:wrap;align-items:center;column-gap:6px;margin:2px 0 0!important;font-size:12px;line-height:17px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-pick-cut-btn){display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 6px;border:0;border-radius:5px;background:#ffffff0d;font:inherit;font-size:12px;
  font-weight:500;color:var(--cb-fg-1);cursor:pointer}
:where(${S}) :where(.carton-pick-cut-btn:hover){background:#ffffff18}
:where(${S}) :where(.carton-pick-esc){flex:none;padding:0;border:0;background:none;cursor:pointer}
:where(${S}) :where(.carton-pick-esc kbd){display:inline-block;padding:0 5px;border-radius:4px;background:#ffffff10;font:inherit;font-size:11px;line-height:17px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-version-pick){grid-column:3;grid-row:1;display:none;align-items:center;gap:4px;font-size:12px;line-height:18px;font-weight:500;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-history[data-picking] .carton-version:hover .carton-version-pick, .carton-history[data-picking] .carton-history-list:focus-within .carton-version[data-active] .carton-version-pick){display:inline-flex}
:where(${S}) :where(.carton-history[data-picking] .carton-version:hover .carton-version-when){display:none}
:where(${S}) :where(.carton-history[data-picking] .carton-version-more){display:none}
:where(${S}) :where(.carton-version[data-pick-from]){background:#8ab4ff0f;box-shadow:inset 2px 0 0 #8ab4ff}
:where(${S}) :where(.carton-pick-from){margin-right:2px}
/* Compare with… on another cut (N2c): its History to pick from */
:where(${S}) :where(.carton-cut-picker){display:flex;flex-direction:column;flex:1 1 0;min-height:0}
:where(${S}) :where(.carton-cut-picker-head){display:flex;flex-direction:column;gap:2px;margin:0 12px 6px}
:where(${S}) :where(.carton-cut-picker-back){display:inline-flex;align-items:center;gap:5px;align-self:flex-start;height:24px;padding:0 6px 0 4px;margin-left:-4px;border:0;border-radius:5px;
  background:none;font:inherit;font-size:12px;color:var(--cb-fg-2);cursor:pointer}
:where(${S}) :where(.carton-cut-picker-back:hover){background:#ffffff10;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-cut-picker-title){margin:0!important;font-size:13px;line-height:18px;font-weight:600;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-cut-picker-loading){margin:8px 14px;font-size:12px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-cut-pick-row){cursor:pointer}
:where(${S}) :where(.carton-cut-pick-row:hover .carton-cut-pick-go, .carton-cut-picker-list:focus-within .carton-cut-pick-row[aria-selected=true] .carton-cut-pick-go){display:inline-flex}
:where(${S}) :where(.carton-cut-pick-row:hover .carton-version-when){display:none}
:where(${S}) :where(.carton-cut-pick-row[data-now] .carton-version-title){grid-row:1 / span 2;align-self:center;font-weight:500}
:where(${S}) :where(.carton-cut-pick-row[data-now] .carton-cut-pick-go){grid-row:1 / span 2;align-self:center}
:where(${S}) :where(.carton-panel-head.carton-cutbar){container-type:inline-size}
`;
