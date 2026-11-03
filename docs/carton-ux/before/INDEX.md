# Carton UI, before: screenshots

> `before/gallery/` in this branch holds the 81 shots the audit and design cite (reduced to a 256-colour palette); this
> index lists all 143 states the rig makes. Re-run it (`README-capture.md`) for the rest, and for the `preact/` copies.

Made by `carton/packages/react/gallery/capture/run.mjs` (see README.md here). Headless Chromium on Linux, DPR 2, React 19
(preact/compat copies in `preact/`). Every shot runs the app's own code: `scripts/carton/ui.js` (CartonSide,
CartonStage, JoinDialog), `scripts/carton/sync/ui.js` (Share), `scripts/carton/strip-buttons.js` (title-bar icons) and
@carton/react, over Cardboard 1.4.0's own stylesheet and Geist, talking to @carton/react's mock through the real wire
protocol (serveUi / serveComments) via a fake bridge. Interactions are real clicks, hovers and typing.

What every shot shares, unlike the real app: fonts render with Linux's rasterizer, not Windows' (DirectWrite), so text
is a little lighter and spacing differs by a pixel here and there; the window around Carton (title bar tabs, library,
stage video, timeline, chat) is a plain stand-in; data is the mock's (names: You = Alice Moreau, Bob Okafor, Priya
Shah, Leo Park, Director, Claude Code, Codex). Panel shots are the side panel alone at its width (384 or 300 CSS px, so
768 or 600 px wide), full window height (900 CSS px with a 50 px title bar). Stage shots are the stage alone: 700 CSS px
wide with the panel closed (the panel's room goes to the stage), 640 with it open. Window shots are the whole
930+panel+380 px window.

| File | State | Made with (page query, region) | Differs from the real app / page errors |
|---|---|---|---|
| `history-none-384.png` | A cut with no versions at all (mock with 0 versions). | `?s=history-none&w=384`, panel | — |
| `history-none-300.png` | A cut with no versions at all (mock with 0 versions). | `?s=history-none&w=300`, panel | — |
| `history-start-384.png` | Only the system row "Started the cut". | `?s=history-start&w=384`, panel | — |
| `history-start-300.png` | Only the system row "Started the cut". | `?s=history-start&w=300`, panel | — |
| `history-few-384.png` | 12 versions: You, Director, Claude Code, Codex, Leo Park and Leo Park's Director; a named version, checkpoints (agent turns), a restore, a partial fold, a row of 7 changes. | `?s=history-few&w=384`, panel | — |
| `history-few-300.png` | 12 versions: You, Director, Claude Code, Codex, Leo Park and Leo Park's Director; a named version, checkpoints (agent turns), a restore, a partial fold, a row of 7 changes. | `?s=history-few&w=300`, panel | — |
| `history-few-expanded-384.png` | history-few, then a click on "7 changes" (the row's list of changes opens). | `?s=history-few&w=384`, panel | — |
| `history-few-expanded-300.png` | history-few, then a click on "7 changes" (the row's list of changes opens). | `?s=history-few&w=300`, panel | — |
| `history-row-hover-384.png` | history-few, mouse over the Codex checkpoint row (hover look and ⋯ button). | `?s=history-few&w=384`, panel | — |
| `history-row-hover-300.png` | history-few, mouse over the Codex checkpoint row (hover look and ⋯ button). | `?s=history-few&w=300`, panel | — |
| `history-menu-384.png` | history-few, ⋯ on the "Restored 'Rough cut'" row: the row's menu opens below it. | `?s=history-few&w=384`, panel | — |
| `history-menu-300.png` | history-few, ⋯ on the "Restored 'Rough cut'" row: the row's menu opens below it. | `?s=history-few&w=300`, panel | — |
| `history-menu-bottom-384.png` | history-few, ⋯ on the last row "Started the cut": the menu flips up. | `?s=history-few&w=384`, panel | — |
| `history-menu-bottom-300.png` | history-few, ⋯ on the last row "Started the cut": the menu flips up. | `?s=history-few&w=300`, panel | — |
| `history-menu-foldrest-384.png` | history-few, ⋯ on the partial-fold row: offers "Fold in the rest". | `?s=history-few&w=384`, panel | — |
| `history-menu-foldrest-300.png` | history-few, ⋯ on the partial-fold row: offers "Fold in the rest". | `?s=history-few&w=300`, panel | — |
| `history-naming-384.png` | history-few, ⋯ → Name this version on "Trimmed 'Interview A'…", then typed "Final for review". | `?s=history-few&w=384`, panel | — |
| `history-naming-300.png` | history-few, ⋯ → Name this version on "Trimmed 'Interview A'…", then typed "Final for review". | `?s=history-few&w=300`, panel | — |
| `history-naming-cut-384.png` | history-few, ⋯ → New cut from here on the named row: the inline new-cut name field (empty). | `?s=history-few&w=384`, panel | — |
| `history-naming-cut-300.png` | history-few, ⋯ → New cut from here on the named row: the inline new-cut name field (empty). | `?s=history-few&w=300`, panel | — |
| `history-filter-named-384.png` | history-few, filter Named. | `?s=history-few&w=384`, panel | — |
| `history-filter-named-300.png` | history-few, filter Named. | `?s=history-few&w=300`, panel | — |
| `history-filter-turns-384.png` | history-few, filter Agent turns. | `?s=history-few&w=384`, panel | — |
| `history-filter-turns-300.png` | history-few, filter Agent turns. | `?s=history-few&w=300`, panel | — |
| `history-filter-named-empty-384.png` | A History with no named version and no agent turn, filter Named. | `?s=history-no-named-turns&w=384`, panel | — |
| `history-filter-named-empty-300.png` | A History with no named version and no agent turn, filter Named. | `?s=history-no-named-turns&w=300`, panel | — |
| `history-filter-turns-empty-384.png` | The same, filter Agent turns. | `?s=history-no-named-turns&w=384`, panel | — |
| `history-filter-turns-empty-300.png` | The same, filter Agent turns. | `?s=history-no-named-turns&w=300`, panel | — |
| `history-provisional-384.png` | history-few plus two of your edits still waiting for the server ("Waiting to sync"). | `?s=history-provisional&w=384`, panel | — |
| `history-provisional-300.png` | history-few plus two of your edits still waiting for the server ("Waiting to sync"). | `?s=history-provisional&w=300`, panel | — |
| `history-provisional-menu-384.png` | history-provisional, ⋯ on a waiting row: everything but Fold is disabled. | `?s=history-provisional&w=384`, panel | — |
| `history-provisional-menu-300.png` | history-provisional, ⋯ on a waiting row: everything but Fold is disabled. | `?s=history-provisional&w=300`, panel | — |
| `history-many-384.png` | Mock with 3,000 versions over about four days: day headers; older days folded (only named versions and turns stay). | `?s=history-many&w=384`, panel | Times come from the mock's generator: some rows say "just now" below rows from minutes ago (the generator clamps late times), which the real History never shows. |
| `history-many-300.png` | Mock with 3,000 versions over about four days: day headers; older days folded (only named versions and turns stay). | `?s=history-many&w=300`, panel | Times come from the mock's generator: some rows say "just now" below rows from minutes ago (the generator clamps late times), which the real History never shows. |
| `history-many-scrolled-384.png` | history-many, list scrolled down 1500 px (the list's top edge once scrolled). | `?s=history-many&w=384`, panel | Times come from the mock's generator: some rows say "just now" below rows from minutes ago (the generator clamps late times), which the real History never shows. |
| `history-many-scrolled-300.png` | history-many, list scrolled down 1500 px (the list's top edge once scrolled). | `?s=history-many&w=300`, panel | Times come from the mock's generator: some rows say "just now" below rows from minutes ago (the generator clamps late times), which the real History never shows. |
| `history-many-bottom-384.png` | history-many, scrolled to the end: the older days, folded to their named versions and turns. | `?s=history-many&w=384`, panel | Times come from the mock's generator: some rows say "just now" below rows from minutes ago (the generator clamps late times), which the real History never shows. |
| `history-many-bottom-300.png` | history-many, scrolled to the end: the older days, folded to their named versions and turns. | `?s=history-many&w=300`, panel | Times come from the mock's generator: some rows say "just now" below rows from minutes ago (the generator clamps late times), which the real History never shows. |
| `history-many-day-open-384.png` | history-many-bottom, then a click on the last folded day's header: it opens. | `?s=history-many&w=384`, panel | Times come from the mock's generator: some rows say "just now" below rows from minutes ago (the generator clamps late times), which the real History never shows. |
| `history-many-day-open-300.png` | history-many-bottom, then a click on the last folded day's header: it opens. | `?s=history-many&w=300`, panel | Times come from the mock's generator: some rows say "just now" below rows from minutes ago (the generator clamps late times), which the real History never shows. |
| `history-compare-384.png` | history-few, ⋯ → Compare with current on "Rough cut": the Compare card under the list. | `?s=history-few&w=384`, panel | Compare's numbers and side labels come from the mock's shot diff (makeShotDiff), not from the two versions' timelines. |
| `history-compare-300.png` | history-few, ⋯ → Compare with current on "Rough cut": the Compare card under the list. | `?s=history-few&w=300`, panel | Compare's numbers and side labels come from the mock's shot diff (makeShotDiff), not from the two versions' timelines. |
| `watch-initial-384.png` | Compare card → Watch the changes: Watch in place in the panel (After side), before playing. | `?s=history-few&w=384`, panel | The shot strip is the mock's 26-shot diff; the player (Cardboard's own preview) is the stand-in colour bars, which don't change with the side. |
| `watch-initial-300.png` | Compare card → Watch the changes: Watch in place in the panel (After side), before playing. | `?s=history-few&w=300`, panel | The shot strip is the mock's 26-shot diff; the player (Cardboard's own preview) is the stand-in colour bars, which don't change with the side. |
| `watch-playing-384.png` | watch-initial, then Next section and Play changes, shot 900 ms into playback. | `?s=history-few&w=384`, panel | The shot strip is the mock's 26-shot diff; the player (Cardboard's own preview) is the stand-in colour bars, which don't change with the side. |
| `watch-playing-300.png` | watch-initial, then Next section and Play changes, shot 900 ms into playback. | `?s=history-few&w=300`, panel | The shot strip is the mock's 26-shot diff; the player (Cardboard's own preview) is the stand-in colour bars, which don't change with the side. |
| `watch-before-384.png` | watch-initial, then the Before side picked. | `?s=history-few&w=384`, panel | The shot strip is the mock's 26-shot diff; the player (Cardboard's own preview) is the stand-in colour bars, which don't change with the side. |
| `watch-before-300.png` | watch-initial, then the Before side picked. | `?s=history-few&w=300`, panel | The shot strip is the mock's 26-shot diff; the player (Cardboard's own preview) is the stand-in colour bars, which don't change with the side. |
| `cuts-closed-long-384.png` | Current cut with a long name ("Director's cut: punchier open with the drone shot and the new music"): the switcher cuts it off. | `?s=cuts-long&w=384`, panel | — |
| `cuts-closed-long-300.png` | Current cut with a long name ("Director's cut: punchier open with the drone shot and the new music"): the switcher cuts it off. | `?s=cuts-long&w=300`, panel | — |
| `cuts-open-one-384.png` | Only Main cut exists; the cut switcher opened. | `?s=cuts-one&w=384`, panel | — |
| `cuts-open-one-300.png` | Only Main cut exists; the cut switcher opened. | `?s=cuts-one&w=300`, panel | — |
| `cuts-open-several-384.png` | Four cuts (Main cut shared, 30s Instagram cut, Director's cut, Leo's Main cut read-only); the switcher opened. | `?s=history-few&w=384`, panel | — |
| `cuts-open-several-300.png` | Four cuts (Main cut shared, 30s Instagram cut, Director's cut, Leo's Main cut read-only); the switcher opened. | `?s=history-few&w=300`, panel | — |
| `cuts-open-long-384.png` | cuts-long, the switcher opened (long names in the menu). | `?s=cuts-long&w=384`, panel | — |
| `cuts-open-long-300.png` | cuts-long, the switcher opened (long names in the menu). | `?s=cuts-long&w=300`, panel | — |
| `cuts-new-form-384.png` | Switcher → New cut from here: the name form inside the menu, "Rough cut for Priya" typed. | `?s=history-few&w=384`, panel | — |
| `cuts-new-form-300.png` | Switcher → New cut from here: the name form inside the menu, "Rough cut for Priya" typed. | `?s=history-few&w=300`, panel | — |
| `cuts-rename-form-384.png` | Switcher → Rename cut: the rename form inside the menu. | `?s=history-few&w=384`, panel | — |
| `cuts-rename-form-300.png` | Switcher → Rename cut: the rename form inside the menu. | `?s=history-few&w=300`, panel | — |
| `fold-all-384.png` | Switcher → Fold “30s Instagram cut” in here: 3 changes, all ticked. | `?s=fold-all&w=384`, window | The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut. |
| `fold-all-300.png` | Switcher → Fold “30s Instagram cut” in here: 3 changes, all ticked. | `?s=fold-all&w=300`, window | The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut. |
| `fold-some-384.png` | fold-all, then one change unticked: "Fold in 2 of 3". | `?s=fold-all&w=384`, window | The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut. |
| `fold-some-300.png` | fold-all, then one change unticked: "Fold in 2 of 3". | `?s=fold-all&w=300`, window | The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut. |
| `fold-conflict-384.png` | Fold with a conflict to pick (both sides name their cut) and a warning; Fold in disabled until picked. | `?s=fold-conflict&w=384`, window | The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut. |
| `fold-conflict-300.png` | Fold with a conflict to pick (both sides name their cut) and a warning; Fold in disabled until picked. | `?s=fold-conflict&w=300`, window | The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut. |
| `fold-conflict-picked-384.png` | fold-conflict, then "Keep yours (Main cut)" picked. | `?s=fold-conflict&w=384`, window | The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut. |
| `fold-conflict-picked-300.png` | fold-conflict, then "Keep yours (Main cut)" picked. | `?s=fold-conflict&w=300`, window | The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut. |
| `fold-leftout-384.png` | Fold again after a partial fold: two changes tagged "Left out earlier" (they go together). | `?s=fold-leftout&w=384`, window | The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut. |
| `fold-leftout-300.png` | Fold again after a partial fold: two changes tagged "Left out earlier" (they go together). | `?s=fold-leftout&w=300`, window | The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut. |
| `fold-nothing-384.png` | Fold when the other cut has nothing new. | `?s=fold-nothing&w=384`, window | The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut. |
| `fold-nothing-300.png` | Fold when the other cut has nothing new. | `?s=fold-nothing&w=300`, window | The plan is a gallery-made FoldPlan (the mock's planFold, replaced from gallery code) for 30s Instagram cut → Main cut. |
| `comments-empty-384.png` | History open, then the Comments tab; no comments yet. | `?s=comments-empty&w=384`, panel | Comments come from @carton/react's comments mock (its people are Alice Chen, Bob Okafor, Cora Lind; the History mock's you is Alice Moreau). |
| `comments-empty-300.png` | History open, then the Comments tab; no comments yet. | `?s=comments-empty&w=300`, panel | Comments come from @carton/react's comments mock (its people are Alice Chen, Bob Okafor, Cora Lind; the History mock's you is Alice Moreau). |
| `comments-some-384.png` | Comments tab with the comments mock's threads (exact, moved, outdated, general, resolved). | `?s=comments-some&w=384`, panel | Comments come from @carton/react's comments mock (its people are Alice Chen, Bob Okafor, Cora Lind; the History mock's you is Alice Moreau). |
| `comments-some-300.png` | Comments tab with the comments mock's threads (exact, moved, outdated, general, resolved). | `?s=comments-some&w=300`, panel | Comments come from @carton/react's comments mock (its people are Alice Chen, Bob Okafor, Cora Lind; the History mock's you is Alice Moreau). |
| `share-empty-384.png` | Share tab, project not shared, no name known: the empty form, and Join below. | `?s=share-empty&w=384`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-empty-300.png` | Share tab, project not shared, no name known: the empty form, and Join below. | `?s=share-empty&w=300`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-empty-submitted-384.png` | share-empty, then Share clicked with nothing filled in (the field messages). | `?s=share-empty&w=384`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-empty-submitted-300.png` | share-empty, then Share clicked with nothing filled in (the field messages). | `?s=share-empty&w=300`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-invite-code-384.png` | Address typed (https://share.example.com); the server answers that it asks for an invite code: the code field appears. Name already known. | `?s=share-invite-code&w=384`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-invite-code-300.png` | Address typed (https://share.example.com); the server answers that it asks for an invite code: the code field appears. Name already known. | `?s=share-invite-code&w=300`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-unreachable-384.png` | Address typed (https://share.nowhere.test); it can't be reached: the message at the field. | `?s=share-unreachable&w=384`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-unreachable-300.png` | Address typed (https://share.nowhere.test); it can't be reached: the message at the field. | `?s=share-unreachable&w=300`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-join-form-384.png` | share-empty, then "Join a shared project": the Join form in the panel. | `?s=share-empty&w=384`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-join-form-300.png` | share-empty, then "Join a shared project": the Join form in the panel. | `?s=share-empty&w=300`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-owner-384.png` | Shared, you are the owner, nobody else here: Live (Up to date) and Invite to edit. | `?s=share-owner&w=384`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-owner-300.png` | Shared, you are the owner, nobody else here: Live (Up to date) and Invite to edit. | `?s=share-owner&w=300`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-owner-invite-384.png` | share-owner, then Create link: the invite link with Copy. | `?s=share-owner&w=384`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-owner-invite-300.png` | share-owner, then Create link: the invite link with Copy. | `?s=share-owner&w=300`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-owner-role-384.png` | share-owner, the role picker opened (Can edit / Can comment / Can watch). | `?s=share-owner&w=384`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-owner-role-300.png` | share-owner, the role picker opened (Can edit / Can comment / Can watch). | `?s=share-owner&w=300`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-peers-384.png` | Shared as owner with four teammates here (one idle). | `?s=share-peers&w=384`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-peers-300.png` | Shared as owner with four teammates here (one idle). | `?s=share-peers&w=300`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-editor-384.png` | Joined as an editor (not the owner): Live only, no Invite. | `?s=share-editor-peers&w=384`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-editor-300.png` | Joined as an editor (not the owner): Live only, no Invite. | `?s=share-editor-peers&w=300`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-offline-384.png` | Shared, offline with 3 edits waiting and the "can't be reached" problem; Create link disabled. | `?s=share-offline&w=384`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-offline-300.png` | Shared, offline with 3 edits waiting and the "can't be reached" problem; Create link disabled. | `?s=share-offline&w=300`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-update-server-384.png` | Shared, the server needs an update: the problem words plus the server's own message. | `?s=share-update-server&w=384`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `share-update-server-300.png` | Shared, the server needs an update: the problem words plus the server's own message. | `?s=share-update-server&w=300`, panel | The worker's live services are the fake bridge: liveStatus, liveHostInfo and liveInvite answer with the scenario's values at once. |
| `stage-preview-version.png` | A version opened read-only (banner: Previewing the version from 2:14 PM (Codex)). | `?s=stage-preview-version`, stage | — |
| `stage-preview-long.png` | Preview of a named version with a very long name. | `?s=stage-preview-long`, stage | — |
| `stage-preview-blocked.png` | Preview, then an edit tried: the banner's "edits don't apply here" note. | `?s=stage-preview-blocked`, stage | — |
| `stage-conflict-one.png` | One conflict card (with Show on timeline and Not now ✕). | `?s=stage-conflict-one`, stage | — |
| `stage-conflict-several.png` | Three conflict cards stacked (two peek out behind). | `?s=stage-conflict-several`, stage | — |
| `stage-conflict-pill.png` | stage-conflict-several, then the stack hidden (caret): the "3 conflicts" pill. | `?s=stage-conflict-several`, stage | — |
| `stage-conflict-aside.png` | stage-conflict-several, the top card set aside (Not now), then the "Set aside (1)" list opened. | `?s=stage-conflict-several`, stage | — |
| `stage-conflict-self.png` | A card whose both sides are your own edits: told apart as earlier and later. | `?s=stage-conflict-self`, stage | — |
| `stage-conflict-both.png` | A card that offers Keep both (Leo Park's Director vs you). | `?s=stage-conflict-both`, stage | — |
| `stage-conflict-preview.png` | 'W6' timing card (Claude Code's side showing now), Preview clicked on your side: the banner says "Previewing your edit", the card stays. | `?s=stage-conflict-preview`, stage | The card's preview ref comes from a gallery conflictRef on the mock (the mock has none). |
| `stage-conflict-panel-open-384.png` | Two cards while the History panel is open: the stack folds to its pill. | `?s=stage-conflict-panel-open&w=384`, stage | — |
| `stage-conflict-panel-open-300.png` | Two cards while the History panel is open: the stack folds to its pill. | `?s=stage-conflict-panel-open&w=300`, stage | — |
| `stage-toast-confirm.png` | Current cut 30s Instagram cut; Switcher → Fold into Main cut → Fold in: the confirmation toast with its "Switch to Main cut" action. | `?s=toast-fold`, stage | The toast was made by the real action (Restore / Fold in); its 6 s timeout is still running when shot. |
| `stage-toast-restore.png` | Row ⋯ → Restore on "Rough cut": the confirmation toast (no action). | `?s=history-few`, stage | The toast was made by the real action (Restore / Fold in); its 6 s timeout is still running when shot. |
| `stage-toast-warning.png` | The bridge tells a failed save: the warning toast. | `?s=stage-toast-warning`, stage | The toast was made by the real action (Restore / Fold in); its 6 s timeout is still running when shot. |
| `stage-live-offline.png` | Shared project offline with 3 edits waiting: the live chip, bottom-left. | `?s=stage-live-offline`, stage | — |
| `stage-live-syncing.png` | Shared project sending 2 edits: the chip says Syncing (its icon spins). | `?s=stage-live-syncing`, stage | — |
| `stage-media-waiting-one.png` | Joined project, one teammate clip not here yet: the media notice. | `?s=stage-media-waiting-one`, stage | — |
| `stage-media-waiting-many.png` | Four clips not here yet. | `?s=stage-media-waiting-many`, stage | — |
| `stage-media-arrived.png` | The check found the clip: "has arrived" (the page checks every 150 ms instead of 15 s). | `?s=stage-media-arrived`, stage | The notice checks every 15 s in the app; this page checks every 150 ms so the "arrived" answer comes at once. |
| `stage-media-copies.png` | Everything here, playing from preview copies. | `?s=stage-media-copies`, stage | — |
| `stage-media-unchecked.png` | Clips that couldn't be checked. | `?s=stage-media-unchecked`, stage | — |
| `window-history-384.png` | The whole window: History open beside the chat. | `?s=history-few&w=384`, window | — |
| `window-history-300.png` | The whole window: History open beside the chat. | `?s=history-few&w=300`, window | — |
| `window-watch-384.png` | The whole window during Watch the changes (the stage shows the side read-only, with the banner). | `?s=history-few&w=384`, window | The player is the stand-in colour bars (dimmed while a version is previewed); in the app it is Cardboard's own preview showing the side. |
| `window-watch-300.png` | The whole window during Watch the changes (the stage shows the side read-only, with the banner). | `?s=history-few&w=300`, window | The player is the stand-in colour bars (dimmed while a version is previewed); in the app it is Cardboard's own preview showing the side. |
| `window-watch-before-384.png` | window-watch, then the Before side picked: the side opens read-only in the player, with a banner over the stage and one inside Watch. | `?s=history-few&w=384`, window | The player is the stand-in colour bars (dimmed while a version is previewed); in the app it is Cardboard's own preview showing the side. |
| `window-watch-before-300.png` | window-watch, then the Before side picked: the side opens read-only in the player, with a banner over the stage and one inside Watch. | `?s=history-few&w=300`, window | The player is the stand-in colour bars (dimmed while a version is previewed); in the app it is Cardboard's own preview showing the side. |
| `window-preview-384.png` | The whole window after a double-click on the Codex checkpoint (a read-only preview from History). | `?s=history-few&w=384`, window | The stage shows the stand-in bars, dimmed: the app shows the version's own frame. |
| `window-preview-300.png` | The whole window after a double-click on the Codex checkpoint (a read-only preview from History). | `?s=history-few&w=300`, window | The stage shows the stand-in bars, dimmed: the app shows the version's own frame. |
| `window-share-384.png` | The whole window with Share open (four teammates here). | `?s=share-peers&w=384`, window | — |
| `window-share-300.png` | The whole window with Share open (four teammates here). | `?s=share-peers&w=300`, window | — |
| `titlebar-normal.png` | The title bar's History and Share icons, no panel open, project not shared. | `?s=titlebar`, titlebar | Only the History/Share icons are Carton's (strip-buttons.js run with Cardboard's button class). The tabs, 16:9, report-issue, Export and sidebar buttons are stand-ins. |
| `titlebar-hover.png` | The same, mouse over History (tooltip not shown: native title). | `?s=titlebar`, titlebar | Only the History/Share icons are Carton's (strip-buttons.js run with Cardboard's button class). The tabs, 16:9, report-issue, Export and sidebar buttons are stand-ins. |
| `titlebar-history-pressed.png` | History open: its icon pressed. | `?s=titlebar`, titlebar | Only the History/Share icons are Carton's (strip-buttons.js run with Cardboard's button class). The tabs, 16:9, report-issue, Export and sidebar buttons are stand-ins. |
| `titlebar-share-pressed.png` | Share open: its icon pressed. | `?s=titlebar`, titlebar | Only the History/Share icons are Carton's (strip-buttons.js run with Cardboard's button class). The tabs, 16:9, report-issue, Export and sidebar buttons are stand-ins. |
| `titlebar-offline.png` | Shared, offline with 3 edits waiting, two teammates here: amber dot and avatars. | `?s=titlebar`, titlebar | Only the History/Share icons are Carton's (strip-buttons.js run with Cardboard's button class). The tabs, 16:9, report-issue, Export and sidebar buttons are stand-ins. |
| `titlebar-syncing.png` | Shared, sending 2 edits, one teammate here: white dot and an avatar. | `?s=titlebar`, titlebar | Only the History/Share icons are Carton's (strip-buttons.js run with Cardboard's button class). The tabs, 16:9, report-issue, Export and sidebar buttons are stand-ins. |
| `titlebar-peers.png` | Shared, up to date, four teammates here: three avatars and +1. | `?s=titlebar`, titlebar | Only the History/Share icons are Carton's (strip-buttons.js run with Cardboard's button class). The tabs, 16:9, report-issue, Export and sidebar buttons are stand-ins. |
| `titlebar-narrow.png` | Window 1100 px wide (≤ 1180): History only, Share open shows as History pressed, the status on History's icon. | `?s=titlebar`, titlebar | Only the History/Share icons are Carton's (strip-buttons.js run with Cardboard's button class). The tabs, 16:9, report-issue, Export and sidebar buttons are stand-ins. |
| `join-form.png` | The Dashboard's Join dialog: the form (no name known yet). | `?s=join`, window | The Dashboard behind the dialog is a stand-in. |
| `join-errors.png` | Join clicked with nothing filled in. | `?s=join`, window | The Dashboard behind the dialog is a stand-in. |
| `join-joined.png` | Invite link and name typed, Join clicked: the joined result with Open. | `?s=join`, window | The Dashboard behind the dialog is a stand-in. |

## React and Preact

Preact shots: 143 of 143.

No page errors on Preact.

Pixel comparison of every pair (a pixel counts when a channel differs by more than 16): 141 of 143 identical. Differing (where a relative time sits on a minute boundary, Preact's first render can say "just now" where React says "1 min ago": @carton/react's minute clock is read at module load, and preact/compat's useSyncExternalStore apparently doesn't re-read it when it subscribes, as React's does; see notes/preact-first-render-clock.png): `history-many-384.png` (1397 px, 0.11 %), `history-many-300.png` (1397 px, 0.14 %).
