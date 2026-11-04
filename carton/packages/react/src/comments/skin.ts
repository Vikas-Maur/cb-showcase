// The Comments panel's and markers' look, in the Cardboard skin's own tokens (skin/cardboard.ts: its --cb-* variables,
// sizes and radii), scoped and wrapped in :where() the same way, so it never leaks into the host and a host rule wins.
// `injectCommentsSkin` adds the Cardboard skin too.

import { injectCardboardSkin, injectStyles } from "../skin/cardboard.ts";

export const commentsBaseCss = `
:where(.carton-comments){display:flex;flex-direction:column;min-height:0}
:where(.carton-comments-list){flex:1 1 0;min-height:0;overflow:auto}
:where(.carton-comment-markers){position:relative;pointer-events:none;height:100%}
:where(.carton-comment-marker){position:absolute;left:0;top:0;pointer-events:auto;will-change:transform}
`;

const S = '[data-carton-skin="cardboard"]';

export const commentsSkin = `
:where(${S}) :where(.carton-comments){height:100%;background:var(--cb-panel);color:var(--cb-fg)}
:where(${S}) :where(.carton-comments-head){display:flex;align-items:center;gap:8px;padding:10px 12px 6px}
/* (no heading: in Cardboard's side panel its tab already says "Comments", UI audit P2-20, PLAN 9.1) */
/* a disabled send button as Cardboard's own: a quiet grey, not the white primary at half strength */
:where(${S}) :where(.carton-comment-box .carton-btn[data-variant=primary]:disabled){background:var(--cb-secondary);color:var(--cb-fg-4);opacity:1}
:where(${S}) :where(.carton-comment-esc){margin:0;font-size:11.5px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-comments-tabs){display:flex;gap:2px;margin-left:auto}
:where(${S}) :where(.carton-comments-tab){height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--cb-fg-3);font:inherit;font-size:12px;cursor:pointer;
  transition:background-color var(--cb-fast),color var(--cb-fast)}
:where(${S}) :where(.carton-comments-tab:hover){color:var(--cb-fg-1);background:#ffffff0a}
:where(${S}) :where(.carton-comments-tab[aria-selected=true]){color:var(--cb-fg-1);background:var(--cb-secondary)}
:where(${S}) :where(.carton-comments-tab:focus-visible){outline:none;box-shadow:0 0 0 3px color-mix(in srgb, var(--cb-ring) 50%, transparent)}
:where(${S}) :where(.carton-comments-notice){display:flex;align-items:center;gap:8px;margin:4px 12px;padding:6px 6px 6px 10px;border-radius:8px;
  background:color-mix(in srgb, var(--cb-danger) 14%, transparent);color:#f2a7a7;font-size:12px}
:where(${S}) :where(.carton-comments-notice > span){flex:1}
:where(${S}) :where(.carton-comments-status){margin:2px 12px;color:var(--cb-fg-3);font-size:12px}
:where(${S}) :where(.carton-comments-status[data-state=unsupported]){color:#fcd77f}
:where(${S}) :where(.carton-comments-compose){margin:4px 12px 8px}
:where(${S}) :where(.carton-comments-readonly){padding:4px 12px 8px}
:where(${S}) :where(.carton-comments-list){padding:0 8px 12px;scrollbar-width:thin;scrollbar-color:#ffffff1f transparent}
/* a quiet list, one note under the other with a rule between (after/comments-384.png), not a stack of cards */
:where(${S}) :where(.carton-sidebar .carton-comments-list){padding:0 0 12px}

:where(${S}) :where(.carton-comment-box){display:flex;flex-direction:column;gap:6px}
/* no resize grip: the box grows with its text, up to 160 px (TextBox), then scrolls (UI audit P2-20; regress 2026-11-02 #5:
   a resize:vertical here, after a resize:none of the same weight, won and showed the grip) */
:where(${S}) :where(.carton-comment-text){height:auto;min-height:52px;max-height:160px;padding:7px 10px;line-height:18px;resize:none;overflow-y:auto;field-sizing:content}
:where(${S}) :where(.carton-comment-box-actions){display:flex;align-items:center;justify-content:flex-end;gap:6px}
/* where the note goes, beside its button (PLAN 9.1: "At the playhead · 0:13") */
:where(${S}) :where(.carton-comment-where){margin-right:auto;min-width:0;font-size:12px;color:var(--cb-fg-3);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

:where(${S}) :where(.carton-thread){position:relative;margin-top:6px;padding:8px 10px;border-radius:10px;background:var(--cb-card);
  box-shadow:inset 0 0 0 1px #ffffff0a;transition:box-shadow var(--cb-fast),background-color var(--cb-fast)}
:where(${S}) :where(.carton-thread:hover){background:color-mix(in srgb, var(--cb-card) 85%, white 3%)}
:where(${S}) :where(.carton-thread[data-selected]){box-shadow:inset 0 0 0 1px var(--cb-line-2)}
:where(${S}) :where(.carton-thread[data-resolved]){opacity:.72}
:where(${S}) :where(.carton-thread-replies){margin:6px 0 0 9px;padding-left:12px;border-left:1px solid #ffffff14;display:flex;flex-direction:column;gap:8px}
:where(${S}) :where(.carton-thread-resolved){margin:6px 0 0;color:var(--cb-fg-3);font-size:11.5px}
:where(${S}) :where(.carton-thread-actions){display:flex;gap:2px;margin:4px -6px -4px}
:where(${S}) :where(.carton-thread .carton-comment-box){margin-top:8px}
/* (after the card look above, which they replace in the side panel: same weight, so the later rule wins); Reply and
   Resolve quieter, as after/comments-384.png's "Reply" */
:where(${S}) :where(.carton-sidebar .carton-thread-actions){margin:2px -6px -2px 18px}
:where(${S}) :where(.carton-sidebar .carton-thread-actions .carton-btn){height:24px;padding:0 6px;font-size:12px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-sidebar .carton-thread-actions .carton-btn:hover){color:var(--cb-fg-1)}
:where(${S}) :where(.carton-sidebar .carton-thread){margin:0;padding:10px 14px 10px 12px;border-radius:0;background:transparent;box-shadow:inset 0 -1px 0 #ffffff12}
:where(${S}) :where(.carton-sidebar .carton-thread:hover){background:#ffffff05}
:where(${S}) :where(.carton-sidebar .carton-thread[data-selected]){background:#ffffff08;box-shadow:inset 2px 0 0 var(--cb-line-2),inset 0 -1px 0 #ffffff12}

:where(${S}) :where(.carton-comment-head){display:flex;align-items:center;gap:6px;min-width:0;min-height:22px}
:where(${S}) :where(.carton-comment-name){font-size:12.5px;font-weight:500;color:var(--cb-fg-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
:where(${S}) :where(.carton-comment){position:relative}
/* when, on the right (after/comments-384.png); a note's own Edit and Delete show over it on hover */
:where(${S}) :where(.carton-comment-when){margin-left:auto;padding-left:6px;font-size:11.5px;color:var(--cb-fg-3);white-space:nowrap}
:where(${S}) :where(.carton-comment-at){height:18px;padding:0 6px;border:0;border-radius:4px;background:#ffffff0f;color:var(--cb-fg-2);font:inherit;
  font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer}
:where(${S}) :where(.carton-comment-at:hover:not(:disabled)){background:#ffffff1a;color:var(--cb-fg-1)}
:where(${S}) :where(.carton-comment-at:disabled),:where(${S}) :where(span.carton-comment-at){cursor:default}
:where(${S}) :where(.carton-comment-at[data-status=general]){font-family:inherit;font-size:11px}
:where(${S}) :where(.carton-comment-at:focus-visible){outline:none;box-shadow:0 0 0 2px color-mix(in srgb, var(--cb-ring) 50%, transparent)}
:where(${S}) :where(.carton-comment-mine){display:flex;position:absolute;top:0;right:0;border-radius:6px;background:var(--cb-panel);opacity:0;transition:opacity var(--cb-fast)}
:where(${S}) :where(.carton-comment:hover .carton-comment-mine),:where(${S}) :where(.carton-comment-mine:focus-within){opacity:1}
:where(${S}) :where(.carton-comment-mine .carton-btn){height:22px;width:22px}
:where(${S}) :where(.carton-comment-body){margin:4px 0 0 24px;font-size:13px;line-height:19px;color:var(--cb-fg);white-space:pre-wrap;overflow-wrap:anywhere}
:where(${S}) :where(.carton-thread-replies .carton-comment-body){margin-left:24px}
:where(${S}) :where(.carton-comment[data-pending] .carton-comment-body){color:var(--cb-fg-2)}
:where(${S}) :where(.carton-comment-gone){font-style:italic;color:var(--cb-fg-4)}
:where(${S}) :where(.carton-comment-edited){color:var(--cb-fg-4);font-size:11.5px}
/* "That moment changed since. See it as it was" (PLAN 9.1) */
:where(${S}) :where(.carton-comment-changed){display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;margin:6px 0 0 24px;font-size:12px;line-height:17px;color:var(--cb-fg-3)}
:where(${S}) :where(.carton-comment-changed > .carton-icon){flex:none}
:where(${S}) :where(.carton-comment-changed .carton-link){font-size:12px}
:where(${S}) :where(.carton-comment-changed .carton-error){flex-basis:100%;margin:0}

/* markers over the ruler: a pin, or a bar for a range; "may be outdated" hollow and dashed */
:where(${S}) :where(.carton-comment-markers){min-height:16px}
:where(${S}) :where(.carton-comment-marker){height:14px;min-width:10px;width:max(10px, var(--carton-marker-w, 0px));margin-left:-5px;padding:0;border:0;border-radius:7px;
  background:var(--cb-warn);box-shadow:0 0 0 1.5px var(--cb-panel);cursor:pointer;color:#1a1a1a;font:inherit;font-size:9.5px;font-weight:600;line-height:14px;
  transition:box-shadow var(--cb-fast),opacity var(--cb-fast)}
:where(${S}) :where(.carton-comment-marker[data-range]){margin-left:0;border-radius:4px;background:color-mix(in srgb, var(--cb-warn) 55%, transparent);box-shadow:inset 0 0 0 1.5px var(--cb-warn)}
:where(${S}) :where(.carton-comment-marker[data-status=moved]){background:var(--cb-info)}
:where(${S}) :where(.carton-comment-marker[data-status=moved][data-range]){background:color-mix(in srgb, var(--cb-info) 55%, transparent);box-shadow:inset 0 0 0 1.5px var(--cb-info)}
:where(${S}) :where(.carton-comment-marker[data-status=outdated]){background:transparent;box-shadow:inset 0 0 0 1.5px var(--cb-warn);color:var(--cb-warn);
  background-image:repeating-linear-gradient(135deg, color-mix(in srgb, var(--cb-warn) 35%, transparent) 0 3px, transparent 3px 6px)}
:where(${S}) :where(.carton-comment-marker[data-resolved]){opacity:.45}
:where(${S}) :where(.carton-comment-marker[data-selected]){box-shadow:0 0 0 1.5px var(--cb-panel),0 0 0 3px var(--cb-fg-1)}
:where(${S}) :where(.carton-comment-marker:focus-visible){outline:none;box-shadow:0 0 0 1.5px var(--cb-panel),0 0 0 3px var(--cb-ring)}
:where(${S}) :where(.carton-comment-marker-count){display:block;padding:0 4px;text-align:center}
`;

/** Add the Cardboard skin and the comments' look. Put `data-carton-skin="cardboard"` on the root you mount into. */
export function injectCommentsSkin(doc: Document = document): void {
  injectCardboardSkin(doc);
  injectStyles(doc, commentsBaseCss, "carton-comments-base-css");
  injectStyles(doc, commentsSkin, "carton-comments-skin");
}
