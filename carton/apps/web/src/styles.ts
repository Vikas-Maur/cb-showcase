// The demo's own layout, on Cardboard's design tokens (the same variables and 1.4.0 fallbacks the cardboard skin
// reads), so the editor around @carton/react's panels looks like Cardboard: dark surfaces, Geist, 32/36 px controls,
// 6/8/10 px radii, 11–13 px text.

export const appCss = `
:root{color-scheme:dark}
html,body{margin:0;height:100%;background:var(--desktop-content,#171717);color:var(--text-primary,#f5f5f5);font:13px/1.4 var(--font-sans,Geist,ui-sans-serif,system-ui,sans-serif)}
#root{height:100%}
*{box-sizing:border-box}
.cb-app{display:grid;grid-template-rows:50px auto minmax(0,1fr) auto;height:100%;min-height:0}
.cb-topbar{display:flex;align-items:center;gap:10px;padding:0 12px;border-bottom:1px solid var(--border-subtle,#ffffff0f);background:var(--desktop-panel,#151515);min-width:0}
.cb-tab{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 10px;border-radius:8px;background:var(--surface-raised,#262626);font-weight:500;white-space:nowrap}
.cb-tab-dim{background:none;color:var(--text-tertiary,#999)}
.cb-tab-thumb{width:22px;height:14px;border-radius:3px;background:linear-gradient(135deg,#e8505b,#f6b5a5)}
.cb-sep{width:1px;height:20px;background:var(--border-strong,#ffffff29)}
.cb-flex{flex:1 1 auto}
.cb-me{color:var(--text-tertiary,#999);font-size:12px;white-space:nowrap}
.cb-dim{color:var(--text-tertiary,#999)}
.cb-error{color:var(--destructive,#e37878)}
.cb-banner{padding:6px 12px;background:#3a2f12;color:var(--status-warning,#fbbd23);font-size:12px}
.cb-main{display:grid;grid-template-columns:minmax(0,1fr) 380px;min-height:0}
.cb-stage{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px;padding:12px;min-height:0}
.cb-viewer{position:relative;display:flex;flex-direction:column;gap:8px;min-height:0;min-width:0}
.cb-preview-banner{position:absolute;top:8px;left:8px;right:8px;z-index:5}
.cb-player{position:relative;flex:1 1 auto;min-height:160px;background:#000;border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center}
.cb-player-video{width:100%;height:100%;object-fit:contain;background:#000}
.cb-player-empty{color:var(--text-disabled,#737373)}
.cb-player-caption{position:absolute;left:50%;bottom:8%;transform:translateX(-50%);max-width:90%;padding:4px 10px;border-radius:6px;background:#000000b3;color:#fff;font-size:18px;font-weight:600;text-align:center;white-space:pre-wrap}
.cb-player-caption:empty{display:none}
.cb-transport{display:flex;align-items:center;gap:10px}
.cb-time{font-family:var(--font-mono,"Geist Mono",ui-monospace,monospace);font-size:12px;color:var(--text-secondary,#c2c2c2)}
.cb-inspector{display:flex;flex-direction:column;gap:12px;padding:12px;border-radius:10px;background:var(--card,#202020);border:1px solid var(--border-subtle,#ffffff0f);min-height:0;overflow:auto;position:relative}
.cb-inspector-empty{justify-content:center}
.cb-inspector-head{display:flex;align-items:center;gap:8px;min-width:0}
.cb-inspector-head strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cb-credits{position:absolute;top:48px;right:12px;z-index:20}
.cb-field{display:grid;grid-template-columns:90px 1fr auto;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary,#c2c2c2)}
.cb-field input[type=range]{width:100%;accent-color:var(--primary,#f4f4f4)}
.cb-field-value{min-width:40px;text-align:right;font-family:var(--font-mono,"Geist Mono",ui-monospace,monospace)}
.cb-input{height:32px;padding:0 10px;border-radius:6px;border:1px solid var(--border-strong,#ffffff29);background:var(--surface-sunken,#161616);color:var(--text-primary,#f5f5f5);font:inherit;min-width:0;width:100%}
.cb-input:focus{outline:2px solid var(--ring,#a0a0a0);outline-offset:-1px}
label.cb-field:has(.cb-input){grid-template-columns:90px 1fr}
.cb-side{border-left:1px solid var(--border-subtle,#ffffff0f);background:var(--desktop-panel,#151515);min-height:0;display:flex;flex-direction:column}
.cb-history{flex:1 1 auto;min-height:0}
.cb-bottom{position:relative;border-top:1px solid var(--border-subtle,#ffffff0f);background:var(--desktop-panel,#151515)}
.cb-timeline{user-select:none;padding-bottom:10px}
.cb-tl-ruler{display:flex;height:26px;border-bottom:1px solid var(--border-subtle,#ffffff0f)}
.cb-tl-corner{flex:none;display:flex;align-items:center;padding-left:12px;font-family:var(--font-mono,"Geist Mono",ui-monospace,monospace);font-size:11px;color:var(--text-secondary,#c2c2c2)}
.cb-tl-ticks{position:relative;flex:1 1 auto;cursor:pointer;overflow:hidden}
.cb-tl-tick{position:absolute;top:0;bottom:0;border-left:1px solid var(--border-subtle,#ffffff0f);padding:5px 0 0 4px;font-size:10px;color:var(--text-tertiary,#999)}
.cb-tl-body{display:flex}
.cb-tl-heads{flex:none}
.cb-tl-head{display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--border-subtle,#ffffff0f);font-size:12px;color:var(--text-secondary,#c2c2c2);white-space:nowrap}
.cb-tl-head-icon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:4px;background:var(--surface-raised,#262626);font-size:10px;color:var(--text-tertiary,#999)}
.cb-tl-lanes{position:relative;flex:1 1 auto;overflow:hidden;min-width:0}
.cb-tl-lane{border-bottom:1px solid var(--border-subtle,#ffffff0f)}
.cb-clip{position:absolute;left:0;top:0;display:flex;align-items:center;border-radius:6px;overflow:hidden;cursor:grab;touch-action:none;will-change:transform;box-shadow:inset 0 0 0 1px #ffffff1f}
.cb-clip-video{background:#2b4a6f;background-size:auto 100%;background-repeat:repeat-x}
.cb-clip-caption{background:#5b4a1f}
.cb-clip.is-selected{box-shadow:inset 0 0 0 2px var(--primary,#f4f4f4)}
.cb-clip.is-dragging{cursor:grabbing;box-shadow:inset 0 0 0 2px var(--status-info,#61a6fa),0 6px 20px -6px #0000008c;z-index:3}
.cb-clip-label{flex:1 1 auto;padding:0 10px;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px #000}
.cb-clip-video .cb-clip-label{align-self:flex-start;margin-top:4px}
.cb-clip-video .cb-clip-label span,.cb-clip-video .cb-clip-label{background:none}
.cb-clip-edge{flex:none;width:7px;align-self:stretch;cursor:ew-resize}
.cb-clip:hover .cb-clip-edge{background:#ffffff33}
.cb-tl-ghosts{position:absolute;inset:0;pointer-events:none}
.cb-tl-playhead{position:absolute;left:0;top:0;width:2px;margin-left:-1px;background:var(--destructive,#e37878);pointer-events:none;will-change:transform}
.cb-conflicts{position:absolute;right:12px;bottom:calc(100% + 12px);width:380px;max-height:60vh;overflow:auto;z-index:30}
.cb-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:flex;gap:12px;align-items:center;padding:10px 14px;border-radius:8px;background:var(--popover,#202020);box-shadow:var(--shadow-surface-raised,0 16px 40px -12px #000000b3,0 0 0 1px #ffffff0a);z-index:90}
.cb-toast-x{background:none;border:0;color:var(--text-tertiary,#999);font-size:16px;cursor:pointer}
.cb-link{font-family:var(--font-mono,"Geist Mono",ui-monospace,monospace);font-size:11px}
.cb-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.cb-watch-overlay{background:#000000a6}
.cb-watch{width:min(1100px,calc(100% - 48px));max-height:calc(100% - 48px);overflow:auto;padding:16px;border-radius:12px;background:var(--surface-dialog,#1f1f1f);box-shadow:var(--shadow-surface-raised,0 16px 40px -12px #000000b3,0 0 0 1px #ffffff0a)}
.cb-watch-preview{position:relative;aspect-ratio:16/9;max-height:42vh;margin:0 auto;background:#000;border-radius:8px;overflow:hidden}
.cb-watch-preview img{width:100%;height:100%;object-fit:contain}
.cb-watch-side{position:absolute;left:8px;top:8px;padding:2px 8px;border-radius:6px;background:#000000b3;font-size:11px}
.cb-gate{display:flex;align-items:center;justify-content:center;height:100%;padding:24px}
.cb-gate-card{width:min(420px,100%);padding:24px;border-radius:12px;background:var(--surface-dialog,#1f1f1f);box-shadow:var(--shadow-surface-raised,0 16px 40px -12px #000000b3,0 0 0 1px #ffffff0a)}
.cb-gate-card h1{margin:0 0 8px;font-size:18px;font-weight:600}
.cb-gate-form{display:flex;flex-direction:column;gap:12px;margin-top:16px}
.cb-gate-form .cb-field{grid-template-columns:90px 1fr}
.cb-watch-page{display:grid;grid-template-rows:50px minmax(0,1fr);height:100%}
.cb-watch-main{display:flex;flex-direction:column;gap:12px;padding:16px;max-width:1100px;width:100%;margin:0 auto;min-height:0}
.cb-newer{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:8px;background:#1d2a3d;color:var(--status-info,#61a6fa);font-size:12px}
@media (max-width:1100px){.cb-stage{grid-template-columns:1fr}.cb-main{grid-template-columns:minmax(0,1fr) 320px}}
`;
