# Capture states, one pair of files per feature

`npm run screens` (in `packages/react`) builds the capture page and shoots every state on React and on preact/compat.
A feature adds its states here, in two files of its own, and edits no shared list, so features made side by side
merge cleanly.

## Add a state

1. **The scenario**, in `states/<feature>.js`: what the page shows when opened with `?s=<name>`.

   ```js
   export function addStates(S, { ux, people, at }) {
     // History's story (ux), plus one version of yours
     S["find-history"] = () => {
       const r = ux()();
       r.ui.addVersion({ at: at(0, 12, 50), author: people.alice, kind: "edit" });
       return r; // { ui, panel: "history" | "share" | null, live?, comments?, media?, clip? }
     };
   }
   ```

   `build.mjs` bundles every `states/*.js` into the page. A scenario name that already exists is an error.

2. **The shot**, in `states/<feature>.shots.mjs`: how a person gets there, and what is captured.

   ```js
   export function shots({ P, T, W, B, D, foldOlder, menuItem }) {
     return [
       P("find-results", "find-history", "History → Find, “interview” typed: the matches.", async (p) => {
         await foldOlder(p);
         await p.getByRole("button", { name: "Find" }).click();
         await p.keyboard.type("interview");
       }),
     ];
   }
   ```

   `shoot.mjs` picks up every `states/*.shots.mjs`. A shot name used twice is an error that names both files.

3. **Run it:** `npm run screens -- --only '^find-'`, or one runtime: `node gallery/capture/shoot.mjs --only '^find-'`.
   `--list` prints every shot with its scenario and file. The shots, `shots.json` and `INDEX.md` go to
   `gallery/dist/capture/shots/` (Preact's in `preact/`).

   The environment: `CARTON_CARDBOARD_ASSETS` (Cardboard 1.4.0's `dist/renderer/assets`), `CARTON_PLAYWRIGHT` (a folder
   with `node_modules/playwright`) and `CARTON_CHROMIUM` (the browser).

## What a scenario gets (`ctx`)

- **Builders:**
  - `ux(extra?)`: the redesign's History story (the mockups' data), with `extra(ui)` run on its view model;
  - `hist(o?)`: the older 12-version history;
  - `stage(setup)`: the stage with the panel closed;
  - `ws6(setup?)`: History with the cuts of Workstream 6;
  - `mock(opts)`: a bare mock view model.
- **Data:**
  - people: `people` (`alice` is you), `leo`, `leosDirector`, `codex`, `SYSTEM`;
  - cuts: `cut(o)`, `CUTS(head)`, `WS6_CUTS(head, current?)`, `setCuts(ui, list)`, `newest(ui)`;
  - conflict cards: `card(o)`, `CARDS`;
  - Share's live status: `shared(o)`, `peer(actor, activity, idle?)`, `PEERS`;
  - comments: `createMockComments`;
  - the Fold dialog's plan: `planWith(ui, make)`;
  - change rows: `chg(item, kind, change, text, start, end)`;
  - time: `at(day, hour, min)` (a moment relative to today), `MIN`, `now0`.
- **`S`:** the table itself, to start from another scenario (`S["ws1-other-cut"]()`).

## What a shot is

Each helper takes `(name, scenario, how, steps, options)`. `how` says in words what the shot shows and how it was made,
for `INDEX.md`. `steps(page)` drives the page with Playwright: clicks, hovers, typing.

| Helper | Captures |
|---|---|
| `P` | the side panel, at each panel width (384 and 300): `<name>-384.png`, `<name>-300.png` |
| `T` | the stage, the panel closed (a 700 px stage) |
| `W` | the whole window |
| `B` | the title bar: its rightmost `crop` px (900; `crop: 0` for all of it). `q: "&win=1"` adds Windows' caption buttons |
| `D` | the open dialog (waits for it, then runs the steps) |

**Options:**
- `viewport`: the window's size. `ED` is the mockups' editor size, 1522 × 810.
- `perWidth`: `P` shoots at each width; set it `false` for one shot.
- `keepHover`: the mouse stays where the steps left it.
- `anim`: animations run (tooltips fading in).
- `q`: more of the page's query.

Steps have `helpers` for the common moves: `foldOlder`, `openCard`, `uxMenu`, `menuItem`, `cutsMenu`, `changes`,
`playAll`, `playDirector`, `holdBefore(p, scope)`, `tab`, `row`, `vrow`, `rowMenu`, `scrollList`.

Each step waits at most `--timeout` ms (10 s by default) for what it expects: a state whose page changed fails fast,
and says which step.
