# Carton UX redesign: design QA of the built UI

**What was judged:** the integrated build, `origin/feat/carton-ux` @ `937f750b` (all ten workstreams merged).
**Against:** the design, `origin/design/carton-ux` @ `118d3317` (`docs/carton-ux/`: AUDIT, DESIGN, PLAN, `after/`
mockups), and the user's line: *"The current UI and UX is atmost 4/10 and you need to bring it to 10/10"*.
**By:** a design QA reviewer who neither designed nor built it, plus one independent second-opinion designer who scored
a subset blind (§3).

**Bar:** 10/10 means a video editor finds it obvious, calm and trustworthy, with nothing redundant, confusing or worded
for engineers. PLAN says a target counts only once its acceptance holds **in the real app**. Every score here is from
renders, so it is a ceiling until the Windows checks in §6 pass.

## 1. Verdict

- **Both of the user's complaints are gone from the screen.**
  - *Watch the changes* (blocks, Before/After switch, "Section 1 of 1", "Shown in the player, read-only") is replaced by
    sentences in the panel: clip by name, place in the edit, who. Each has a ▶, and the version has Play all and
    hold-to-see Before (`shots/user-watch-the-changes.png`).
  - The read-only banner is replaced by three quiet marks with one label: the title-bar chip, a thin frame round the
    stage and timeline, and the row's "👁 Viewing ✕". Nothing covers the picture (`shots/user-read-only-banner.png`,
    `shots/editor-viewing.png`).
  - **The cut is always in the title bar**, with a colour dot for every cut but Main, and the optional cut label in
    the timeline's toolbar (`shots/titlebar-*.png`, `shots/editor-other-cut.png`).
- **Fidelity to the mockups is high.** Of the regions with a mockup, the build matches structure, words, order and
  states almost everywhere, at 384 and 300 px.
- **React and preact/compat render the same.** Every pair was compared pixel by pixel. The only differences are
  playback frames caught at a different instant: the progress line, the map's playhead, the edit-attempt pulse. The
  first-run Preact failures, and one panel that didn't open, all passed when re-run alone. They were load timeouts and
  a rig race on a busy box, not Preact.
- **What stops it short of 10/10:**
  1. One trust bug: the viewing marks can claim a version that isn't on screen (G1).
  2. Esc doesn't do what the toast says while a card is open (G2).
  3. Share names a teammate's agent as a bare "Director" (G3).
  4. A risk that the 960 px title bar overflows (G4).
  5. A conflict card that hides what "See it" shows (G5).
  6. A tail of small inconsistencies, listed below.
- **Overall: about 8/10 on renders, up from about 4.** The real-app checks decide the rest.

## 2. Scores

The audit's "Before" scores, PLAN's targets, and this QA's scores. All are out of 10.

| Region | Before | Target | **Now** | Second opinion (blind) | What holds it back |
|---|---|---|---|---|---|
| Watch the changes → Play and Before in the change list | 2 | 9 | **8** | see §3 | Marks set before the stage swaps (G1); sentences repeat the row's time (G14) |
| Preview banner → viewing (chip, frame, row) | 2 | 9 | **7.5** | see §3 | A failed or slow load leaves the marks claiming the old version (G1); Esc from the card (G2); the row ✕'s tooltip is clipped (G6) |
| Compare card → Changes view | 3 | 9 | **8.5** | see §3 | Restore wears the Undo icon (G13); sentences repeat the time column (G14) |
| Where am I (cut chip) | 3 | 10 | **8** | see §3 | The chip's menu opens inside History (PLAN 2.2 v1, by plan); 960 px risk (G4); a cut drawn two ways (G12) |
| Agent turn holds | 1 | 8 | **8** | n/a | Working row, its line, "Switch when it finishes" and the card's turn line all as designed. Only the real app can prove the hold |
| History list | 5 | 9 | **8** | see §3 | Group title shown twice (G10); You is drawn three ways (G11); "retimed" (G7); a doubled date on the start row (G16); double highlight in the filter menu (G15) |
| Row menu and actions (restore, new cut, undo turn) | 5 | 9 | **8** | n/a | Undo-turn tooltip spills (G6); inline confirmations aligned and worded two ways (G17); Restore offered while viewing (G18); Play's error at the panel top (G20) |
| Cuts menu | 4 | 9 | **8.5** | n/a | From the chip it opens in History, not under the chip (v1 by plan); dot hues too close (G25) |
| Fold in | 6 | 9 | **9** | n/a | Its From/Into pickers draw a cut as scissors + dot (G12) |
| Conflict cards | 5 | 9 | **8.5** | see §3 | The card covers what See it shows (G5); weak fallback words for cards without structured sides (G30) |
| Toasts | 5 | 9 | **8.5** | n/a | The failed-save toast keeps the old words (G8); "…”." punctuation, and a new-cut line longer than DESIGN (G21) |
| Share | 5 | 8 | **7** | n/a | A teammate's agent is a bare "Director", no teammate roles (G3); raw server detail on screen (G9); placeholder and paragraph (G24) |
| Join | 6 | 9 | **8.5** | n/a | One dialog, **Join and open**. "Opens in its tab" is real-app only |
| Stage status (offline chip, footage notice) | 6 | 8 | **8** | n/a | The footage notice uses the Offline icon (G23) |
| Title bar | 6 | 9 | **8** | see §3 | 960 px with tabs, the viewing label and caption buttons (G4); You's avatar (G11) |
| Comments | 6 | 8 | **8** | n/a | You is "A" here, "Y" in History (G11); screen-reader labels (G22); two treatments of "moment changed" (G26) |
| Credits, ghosts (unmounted) | 0 | 7 | **6** | n/a | Credits reach the app through *Only “clip”* (with "retimed", G7); teammates' drag ghosts (9.3) aren't mounted, as PLAN allowed |
| **Overall** | **≈4** | | **≈8** | | |

## 3. Second opinion

An independent designer (GPT 6.1 Sol, run blind: no access to these scores) is scoring seven regions: Play and
Before, viewing, the Changes view, the cut chip, History, conflict cards and the title bar. Their scores and the
reconciliation follow in the next commit.

<!-- SECOND-OPINION -->

## 4. Gaps, ordered by impact

**Severity:**
- **P1:** misleads, or breaks a rule the redesign stands on.
- **P2:** noticeable friction, or a word rule broken.
- **P3:** polish.

Shots are in `shots/`. A shot named like a mockup pairs the build (left) with the mockup (right).

### G1 · P1 · Viewing: the marks claim a version the stage isn't showing
- **Shot:** `shots/gap-play-fail.png`.
  - Left: Play all on an older version whose swap fails. The panel says "Couldn't load this version. Try again.", but
    the chip still reads `👁 Director's “Add captions…” ✕`, the frame is round the stage and the timeline, and the row
    says "Viewing". The stage shows **your edit**.
  - Right: a 3 s load, shot 1 s in. Same marks, while the stage still shows your edit.
- **Why it matters:** DESIGN §4.4 rests on "a version that isn't theirs must never pass for theirs". The reverse is just
  as bad: here the person's own edit passes for the old version. If they then edit, the refusal path treats it as
  viewing.
- **Cause:** `scripts/carton/ui.js`, `connect()`:
  - `swap(ref)` sets `stageRef`, which the marks follow, **before** `bridge.preview` resolves.
  - `viewAndSwap` never undoes `stageRef` or the worker's `viewing()` when the final `preview(settled)` rejects. The
    error reaches Play, and the marks stay.
- **Fix:**
  1. In `swap()`, set `stageRef = ref` at once only for `null` (back to your edit). For a version, set it when
     `bridge.preview` resolves.
  2. In `viewAndSwap`, when the last `preview(...)` rejects, `await view(null)` and `swap(null)` before rethrowing.
  3. While a swap is pending past 300 ms, the chip's second part reads `Loading Director's “Add captions…”` with a
     spinner, and the frame isn't drawn.
  4. Add a test with a bridge whose `preview` rejects: `viewing()` and `stageRef()` end null, and there's no
     `data-carton-viewing`.
- **Real app:** how often and how slowly `renderer-bridge`'s preview resolves on a long project. This is the flip time
  PLAN 4.3 asks to measure.

### G2 · P2 · Esc from inside an open card closes the card and leaves you viewing
- **Shot:** `shots/gap-esc-close.png`, left. The card closed; the chip, frame and "Viewing ✕" stay.
- **The problem:** the edit-attempt toast says `[Back to my edit] Esc`, and the chip's ✕ tooltip says "Back to my edit
  (Esc)". From the card, the first Esc does neither.
  - **Cause:** `carton/packages/react/src/components/HistoryPanel.ts:653`, Escape → `closeCard()`, per DESIGN §7's order.
  - DESIGN §4.2 promises "Esc anywhere in the editor brings you back". Closing the panel does bring you back (same
    shot, right).
- **Fix:** in `onKey`'s Escape, if viewing is on (`ui.viewing()` or `ui.stageRef?.()`), call `back()` and keep the card
  open. The next Esc closes the card, and the one after closes the panel. Change DESIGN §7's row to "stop viewing →
  close the card → close the panel".

### G3 · P2 · Share: a teammate's agent is a bare "Director"; teammates have no role
- **Shot:** `shots/share-owner.png`. The build lists "Director · Here now · working on “Add a title card”" at the top
  level, with a letter avatar ("D") instead of the Director's mark. The mockup nests it under Leo as **Leo's
  Director**, and each teammate shows a role ("Can edit", "Can comment").
- **The problem:**
  - It breaks the author rule: a bare "Director" reads as *your* Director.
  - Nothing says who may do what.
- **Cause:** `scripts/carton/sync/ui.js:141` maps `peers` flat, by `p.actor.name`, with no `role`.
- **Fix:**
  - Group peers by `actor.parent`. Render an agent indented under its person, with `actorLabel` ("Leo's Director"), its
    mark (`Avatar` from `components/ui.ts`) and its activity line.
  - Show `words.roles[p.role]` at the right of each teammate when the live status carries a role. Add `role` to each
    peer in the status if it doesn't yet; when it's unknown, show nothing.

### G4 · P2 (pending the real app) · The title bar at 960 px can overflow
- **Shot:** `shots/titlebar-960.png`. The stand-in tabs are Dashboard, Blank and Weekend reel, with Windows' caption
  buttons.
  - Third panel: viewing at 960 px. The caption buttons are pushed out of the window.
  - Fourth panel: a long cut name. The minimise button sits at the edge.
  - WS2+8's own 960 px shot, which passed, had only the Dashboard tab.
- **Cause:** `scripts/carton/strip-buttons.js:93`. The chip is `shrink-0`, and the cut name and the viewing label each
  keep a fixed maximum (`:106`, `:113`). The rig's stand-in tabs don't shrink like Cardboard's, so the real app may
  fare better. That's why this is pending.
- **Fix:**
  - Make the chip `min-w-0 shrink`, and keep `shrink-0` on the icons.
  - Under `(max-width: 1000px)` while viewing, show the cut as its dot or scissors only, with the name in the tooltip,
    and clip the label at 100 px.
- **Real app:** check at 960 px with three project tabs, while viewing a long prompt.

### G5 · P2 · A conflict card hides what "See it" shows
- **Shot:** `shots/editor-conflict-theirs.png` (the mockup has the same flaw). While "Seeing it", the 352 px card
  covers the picture's lower right, where the moved clip may be.
- **Fix:** while a side is seen (`data-seeing`):
  - collapse the card to its title and the two side lines (no lead, no footer);
  - make it 40 % translucent until hovered;
  - or dock it in the stage's letterbox when the picture leaves room.
  Change `ConflictCard.ts` and the skin.

### G6 · P2 · Two tooltips break
- **Shot:** `shots/gap-tooltips.png`.
  - "Undo this turn": "Takes out only these 4 changes. Later changes stay." wraps, and its second line runs outside the
    box over the next row's text.
  - The row's ✕: "Back to my edit (Esc)" is cut off at the panel's right edge.
- **Cause:** `carton/packages/react/src/skin/cardboard.ts:127`. The tip is centred under its element, inside the
  panel's overflow, and its box doesn't grow with a second line inside a `carton-btn`.
- **Fix:**
  - Add `height:auto;min-height:0` to the tip.
  - Add a `data-carton-tip-end` variant (`left:auto;right:0;transform:none`) for controls in the panel's right third:
    the row ✕, ⋯, the filter, Close.
- **Real app:** check with Cardboard's real button heights.

### G7 · P2 · Credits say "retimed"
- **Shot:** `shots/history-clip-384.png`. "Added by You on Oct 30 · retimed by Director yesterday at 4:10 pm ·
  retimed by You at 12:41 pm".
- **The problem:** editors say "retime" for a **speed** change. DESIGN §6.1 has "trimmed by Director · moved by You".
- **Cause:** `carton/packages/react/src/words.ts:283`, `creditVerb.Timing: "retimed"`.
- **Fix:**
  - Take the verb from the change's kind: a trim is "trimmed", a move is "moved", both is "trimmed and moved". Use
    "changed the timing" only when it's unknown.
  - Add the clip's kind chip before the name, as in the mockup.

### G8 · P2 · The failed-save toast keeps the old words
- **Shot:** `shots/toasts-build.png` (`toast-warning`). "Your last change couldn't be saved. It's on screen, but it
  isn't in the project yet." That gives no next step.
- **Cause:** DESIGN §6.7's words are in `words.ts:482` (`saveFailed`) but unused. `scripts/carton/renderer-bridge.js:101`
  still sends its own string.
- **Fix:** `SAVE_FAILED = "Your last change wasn't saved. Do it again, or reopen the project."`.

### G9 · P2 · Share shows a raw server message, and two boxes at once
- **Shot:** `shots/share-more-2.png`, right.
  - The update state shows "This project's history is newer than this server accepts (up to 3): update the server" as
    body text. That's engineer wording, and DESIGN keeps reasons in the tooltip.
  - It sits under the amber offline box: two alerts.
- **Fix:** in `scripts/carton/sync/ui.js` (`Problem`):
  - show `problem.detail` only as the line's `title` (as the unreachable case does);
  - show one amber box: "Can't sync: the sharing server needs an update. Your changes are saved here."

### G10 · P3 · A group's newest change is shown twice when it's open
- **Shot:** `shots/history-group-open-384.png`. "Moved “Interview B” 2 s later" is the group's title and its first
  child.
- **Fix:** while open, the group's title reads "Your 6 changes". Or the children start at the second one, and the
  title row keeps the newest sentence. See `HistoryPanel.ts`, group row.

### G11 · P3 · You are drawn three ways
- **Where:** History shows **Y**, Comments shows **A** (the account's initial), and Share shows **V**. See
  `history-default-384`, `comments-384` and `share-owner`.
- **Fix:** one rule, through `components/ui.ts`'s `Avatar` in `CommentsPanel` and Share's `Person` as well. Keep "Y"
  for You, which the UI audit's P3-3 chose so it doesn't change on sharing.

### G12 · P3 · A cut is drawn two ways
- **The problem:** the chip shows a colour dot for any cut but Main, and scissors only for Main. History's cut bar and
  the Fold pickers show **scissors + dot** (`shots/editor-chip-menu.png`, `shots/fold-some.png`).
- **Fix:** in `CutsMenu.ts` (trigger) and `FoldInDialog.ts` (pickers), the dot replaces the scissors for any cut but
  Main.

### G13 · P3 · Restore wears the Undo icon again
- **The problem:** "Restore this version…" in the Changes view uses the undo arrow, the same as "Undo this turn" and the
  toasts' Undo. The card's "Restore…" uses ↺ (`shots/changes-384.png`). AUDIT H7 flagged this.
- **Fix:** `ChangesView.ts` footer, icon `restore`.

### G14 · P3 · Change sentences repeat the time column
- **The problem:** "0:05 · Moved “Summer launch” 1 s earlier (now starts at 0:05)".
  - The tail makes Changes rows wrap to two lines (`shots/changes-384.png`).
  - History rows get cut off as "…now ends at 0:…" (`shots/history-default-384.png`, Codex row).
- **Fix:** in `ChangeRow.ts`, drop a "(now starts at X)" tail when X equals the row's time. Keep the whole sentence in
  toasts, conflict sides and tooltips. In row titles, cut long sentences before the tail, not inside a timecode.

### G15 · P3 · The filter menu highlights two items
- **Shot:** `shots/history-filter-384.png`. The ticked "All versions" and the hovered "Agent turns" both have the
  highlight.
- **Fix:** paint the ticked item's background only on `:focus-visible`. A mouse-opened menu shows the tick alone.

### G16 · P3 · The start row repeats its date
- **Shot:** `shots/history-offline-384.png`. "Project created · Nov 1" under the header "Sun, Nov 1".
- **Fix:** drop "· Nov 1" when the row is under its own day's header.

### G17 · P3 · Inline confirmations are aligned and worded two ways
- **The problem:** Restore's `[Restore] [Cancel]` are left-aligned; New cut's `[Make cut] [Cancel]` are right-aligned
  (`shots/history-restore-384.png`, `shots/history-newcut-384.png`). The mockups left-align both.
- **And worded two ways:** the cuts menu's new-cut form says **[Create]**, and the card's says **[Make cut]**
  (`shots/cuts-more.png`, third panel). DESIGN §8 has "Make cut".
- **Fix:** in `VersionCard.ts`, left-align the new-cut buttons. In `CutsMenu.ts`, word the button "Make cut".

### G18 · P3 · Restore… is offered while viewing
- **The problem:** while a card's Play runs, its footer is Pause, Before, Restore… and ⋯. The mockup
  (`editor-viewing.png`) has Pause, Before and ⋯.
- **Fix:** hide Restore… while that card's Play runs. It stays in ⋯ and comes back on Pause.

### G19 · P3 · At 300 px the card's ⋯ wraps onto its own line
- **Shots:** `shots/history-expanded-300.png`, `history-viewing-300`.
- **Fix:** below 340 px, drop ⋯ from the card's footer; the row's ⋯ holds the same menu.

### G20 · P3 · Play's error is at the panel's top, not in the card
- **Shot:** `shots/history-errors.png`, right. DESIGN §9 puts it in the card.
- **Cause:** `HistoryPanel.ts:556`, `cardPlay.error` → `setFailed`.
- **Fix:** pass it to `VersionCard`'s error slot. Restore and Undo-turn errors already show in the card (same shot).

### G21 · P3 · Toast wording against DESIGN
- **New cut:** "You're on “30s Instagram cut”, made from Director's “Add captions…”. Main cut is unchanged." It runs
  to two lines. DESIGN §6.7 has "You're on “30s Instagram cut” now. Main cut is unchanged."
- **Ellipsis and full stop:** that toast and the edit-attempt toast end a quoted label as "…”." (an ellipsis, a quote,
  then a full stop).
- **Fix:** in `words.ts`, use DESIGN's form. Leave out the full stop when the label ends in "…”".

### G22 · P3 · Screen-reader labels with broken grammar
- **The labels:** "You's comment at 0:47" and "Bob Okafor's comment at Whole video".
- **Cause:** `comments/words.ts:69`, `threadLabel`.
- **Fix:** "Your comment at 0:47", and "Bob Okafor's comment on the whole video".

### G23 · P3 · The footage notice uses the Offline icon
- **Shot:** `shots/editor-live-media.png`. Two different states share the cloud-off icon. The mockup's notice has an
  hourglass.
- **Fix:** `scripts/carton/ui.js`, `MediaNotice`.

### G24 · P3 · Share's first-time words and the empty invite field
- **The problems:**
  - The paragraph keeps "Audio and still images go as they are." AUDIT S3 asked to shorten it, and DESIGN dropped it.
  - The invite field's placeholder, "Copy link to make one", reads like a disabled field.
  - The title is "Share this project" whenever the project's name isn't known. Check that the app always passes the
    name.
- **Fix:** drop the sentence. Make the link when the dialog opens online, so the field shows it as in the mockup.

### G25 · P3 · Two cuts' dots are hard to tell apart
- **The problem:** Leo's Main cut is yellow and 30s Instagram cut is amber; at 8 px they read as one colour
  (`shots/cuts-menu-384.png`).
- **Fix:** keep the palette's hues far apart (amber, cyan, violet, pink, lime, sky), with no yellow beside amber.

### G26 · P3 · Comments treat "the moment changed" two ways
- **The problem:** a blue "Moved" pill on one comment, and the line "That moment changed since. See it as it was" on
  another (`shots/comments-384.png`).
- **Fix:** keep the line, and make "Moved" its quieter form ("Moved with its clip"), in the same grey line style.

### G27 · P3 · A teammate's name in two possessives
- **The problem:** "Leo Park's Director" in rows, but "Leo's Main cut" in the chip and cuts menu, and "Leo's Director" in
  DESIGN.
- **Fix:** use the first name everywhere, through `actorLabel` in `actors.ts`.

### G28 · P3 · Retired words are still in the word table
- **Where:** `words.ts:111–115`: `hideConflicts`, `setAsideHint`, `setAsideList`, `showAgain`. They're unused, and are
  exactly what PLAN 0.3's grep is meant to find gone.
- **Fix:** delete them.

### G29 · P3 · The committed capture rig is stale
- **The problem:** `gallery/capture/shoot.mjs` still lists the old "before" states:
  - their selectors are gone (`.carton-version-expand`, `.carton-segment`, "Set aside", the conflict's "Preview",
    Join's "Join");
  - each waits out 30 s and then fails.
  - It also lacks WS2+8's and WS7's states (the Share dialog family, the chip at 960 px, the new conflict cards).
    Those lived only in per-workstream patches.
- **Fix:** drop the stale states, and fold in this QA's additions (`rig-qa/` here).

### G30 · P3 · Weak fallbacks
- **Cards without structured sides:** a conflict card arriving without `clip`/`what` reads "'Intro' timing" and
  "Trimmed the end to 0:05.0" (`shots/conflict-old-narrow.png`, left).
- **A row whose author has no name:** it renders "• 1 change" with no avatar.
- Both were seen only with the gallery's old-format data. Check that every real path (fold conflicts, an undo-turn
  clash) gives structured sides. Make the fallbacks use "“Intro”: you and Director both changed it" and timecodes
  without ".0".

### G31 · P3 · A folded day still shows rows under a closed chevron
- **The problem:** DESIGN keeps named versions and turns visible in a folded day, but under "›" they read as if the day
  were open (`shots/history-default-384.png`, Yesterday).
- **Fix:** indent them with a quieter title weight, or add "2 named shown" to the header.

## 5. Inconsistencies at a glance

| Same thing | Drawn or worded as | Gap |
|---|---|---|
| You | "Y" (History), "A" (Comments), "V" (Share) | G11 |
| A cut other than Main | dot (chip), scissors + dot (cut bar, Fold pickers) | G12 |
| Restore | ↺ (card), undo arrow (Changes view) | G13 |
| A teammate's agent | "Leo Park's Director" (rows), "Director" (Share) | G3, G27 |
| Play a version's changes | "Play its changes" (row menu), "Play all" (card). Acceptable: the menu names what, the card how | none |
| Inline confirm buttons | left (Restore), right (Make cut) | G17 |
| Making a cut | "Make cut" (card), "Create" (cuts menu) | G17 |
| "The moment changed" | "Moved" pill, "That moment changed since" line | G26 |
| Offline / footage arriving | the same cloud-off icon | G23 |

## 6. What only the real Windows app can judge

1. **Flip and swap time.** Play on an older version, Before held and released, on a long project (PLAN 4.3). Measure
   them, have a second agent re-check, and only then quote numbers. G1 depends on these.
2. **The timeline's half of the frame, and muted clips.** The rig's stand-in timeline carries `data-carton-viewing`, but
   the muting CSS targets Cardboard's real clip classes. In the renders the clips aren't visibly muted.
3. **Esc** with Cardboard's own Esc handlers: a clip selected, a menu open, focus in the timeline (G2).
4. **The edit-attempt toast** from real drags, Delete, Enter on a title and Ctrl+Z, and never Cardboard's refusal
   (PLAN 1.4). **Export while viewing** exports your edit.
5. **The title bar at 960 px** with real tabs and caption buttons (G4). The chip following `cb cut switch` from a
   terminal.
6. **Tooltips and truncation** with Cardboard's real button heights and Windows' DirectWrite fonts: G6, and where long
   sentences cut off.
7. **Share between two instances:** People with roles and nested agents (G3); Join and open from an empty library.
8. **Narrator:** viewing announced once, the radio group on conflict cards, the labels in G22.
9. **Carton off:** no chip, no frame attribute, and Cardboard's own refusal toast.
10. **Performance:** History at 12k versions, and Play holding the editor's frame rate. Not measured here; PLAN §12
    applies, with a second agent re-checking before any number is quoted.

## 7. Method

- **Checkout:** `origin/feat/carton-ux` @ `937f750b`, detached, with its own `npm ci` (esbuild and workerd installed by
  hand).
- **Browser:** Playwright with Chromium 1248 (arm64) and Cardboard 1.4.0's own stylesheet and Geist fonts. DPR 2,
  panels at 384 and 300 px, editor compositions at 1522 × 810 (the mockups' size), stages at 700 px, title bars at
  1522, 1100 and 960 px.
- **The committed rig** (`npm run screens`), limited to the after-states (the old ones fail, G29). Run on React and
  preact/compat; output in `rig/` and `rig/preact/` in the scratch folder.
- **This QA's extension** (`rig-qa/`: `make.mjs` builds it, `shoot-qa.mjs` shoots it), for the states the merged rig dropped or never had:
  - WS7's conflict cards: picked, See it, both, same person, during a turn, changed again, the pill, keyboard focus,
    a 360 px stage, old-format cards;
  - the Share dialog family and Join;
  - the title bar at 960 px with Windows' caption buttons;
  - the chip's menu, Export while viewing, Play on the newest turn;
  - Play that fails and Play that loads slowly, Esc and closing the panel while viewing;
  - errors in cards, the group opened, the filter on, keyboard focus, tooltips.

  It's untracked gallery code: a copy of the rig's entry with extra scenarios, and its own shot list. No product code
  was changed.
- **A text sweep** of every visible string, tooltip, `aria-label` and placeholder across 37 states (`rig-qa/words.mjs`).
  - No ids, hashes or tool names appear. Two exceptions: the server's raw detail (G9), and a support tooltip that
    DESIGN allows.
  - The straight-quoted and decimal sentences it found come from the gallery's old-format mock data, not from the
    product's sentence table.
- **React against Preact:** every pair, pixel by pixel (§1).

## 8. Shots

`shots/` holds the pairs: the build at left, the mockup at right, at half size. Names follow the mockups:
- `history-*`, `changes-*`, `cuts-menu-*`, `fold-*`, `conflict-*`, `editor-*`, `titlebar-*`, `share-*`, `join*`,
  `comments-*`, `toasts*`;
- `gap-*` for the gaps above;
- `user-*` for the user's two screenshots beside today's build;
- `react-vs-preact-*` for the runtime check.

The full set, every raw shot at DPR 2 on both runtimes, is in `/home/ubuntu/gfv-scratch/carton/ux-qa/` (`rig/`, `qa/`,
`shots/`).
