# Carton UX redesign (design only)

This is a redesign of Carton's version history and collaboration UI inside Cardboard's editor. It is design only: no
product code changes here.

- **`AUDIT.md`:** every region and flow as it is today, with screenshots, problems by severity, and a score out of 10.
- **`DESIGN.md`:** the redesign. It covers:
  - the mental model and the information architecture;
  - every region and state;
  - knowing your cut and your edit;
  - looking at changes;
  - previews without banners;
  - keyboard, every word, and edge cases;
  - before/after pairs.
- **`CRITIQUE.md`:** an independent critique of the first draft, by a second designer. `DESIGN.md` §12 lists what
  was taken from it and what wasn't, and why.
- **`PLAN.md`:** the implementation plan:
  - workstreams that can run in parallel, with files and acceptance criteria;
  - the real-app checks;
  - target scores.
- **`after/`:** the mockups, rendered to PNG at 384 and 300 px, and the full editor at 1522 × 810. Their HTML/CSS
  sources are in `mockups/`. To re-render them:
  `CARTON_PLAYWRIGHT=<dir with playwright> CARTON_CHROMIUM=<chrome> node mockups/render.mjs`. They load Geist from the
  local inspect copy of Cardboard, and fall back to the system font elsewhere.
- **`before/real/`:** Windows-laptop screenshots from the 2026-11-02 audits (older builds, marked in `AUDIT.md`), and the
  user's two screenshots.
- **`before/gallery/`:** today's components and composition, rendered with Cardboard's CSS on mock data. The rig is
  `capture-rig.patch` (for `carton/packages/react/gallery/`); `before/README-capture.md` says how to run it.

PNGs are reduced to a 256-colour palette to keep this folder small.
