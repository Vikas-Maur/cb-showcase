# Carton UI audit — 2026-11-02

**Build:** `out\carton-fix\Cardboard-win` (commit `26aaf6e`: `merge/prod-1` plus the bug 6 and bug 8 fixes), with `CARDBOARD_CARTON=1`,
on Windows 11 at 125 % scaling. Each instance had its own profile, library and DevTools port (9360/9361). A local Carton
host ran on 8790. Two instances ran at once, A (owner "Vikas") and B (teammate "Leo"), for Share, Join and presence.
Footage: only `clip.mp4` (colour bars), added with `cb media add`.

**How the authors were made:** "You" came from mouse drags in the editor. "Claude Code" came from `cb` with `CLAUDECODE=1`.
"Director" and "Codex" came from `cb` with `CARDBOARD_ACTOR=director/…` / `codex/…`, the variable main gives the app's own
agents. No real in-app agent turns ran, because the account was at its usage limit. A `cb` run with no actor shows as
"You" in the panel and "Terminal" in `cb history`. "Leo" came from instance B over live sync.

Source references are to `26aaf6e`. I checked that they still match on `origin/feature/carton` (`755ff50`).
Screenshots are in `docs/ui-audit/shots/` and are DevTools captures of the page, so they are at 1.25× CSS pixels.

## Summary

Day to day, Carton already looks a lot like Cardboard. It uses the same Geist type scale (12/13/14 px), the same
`--desktop-panel` background, 6–12 px corner radii, and white primary / dark secondary buttons. The Fold dialog uses
Cardboard's own dialog metrics (12 px radius, rgb(31,31,31), 15 px title). The History panel sits beside the chat in the
chat's look, and its pressed title-bar icon works.

What isn't production-ready:

- **Live sync crashes the editor.** With the Share tab open, the whole project tab fails ("This tab hit a snag") as soon
  as a teammate is present. I reproduced it 3 times, on both sides.
- **History shows things that didn't happen.** It shows a content hash in a version name. A partial Fold in shows a change
  nobody made. Restores and folds are labelled with only their first change. "You can fold in the rest later" turns out to
  be false.
- **Share and Join use engineer words and dead ends.** You see "Carton host", "admin token" and a raw "fetch failed". A
  teammate who joins lands on a destructive "Remove and Open" missing-media dialog.
- **Keyboard and Esc are unreliable.** Focus is usually lost to `<body>` after a menu or form closes. Esc closes some
  layers and not others.

**Counts: P1 = 10, P2 = 20, P3 = 13** (not counting the 5 already-known issues listed at the end).

### Top 5

1. P1-1 — The Share tab crashes the whole editor tab as soon as a teammate is present (`scripts/carton/sync/ui.js:27`).
2. P1-2 — Sharing footage writes a version named `Set 'clip.mp4' content to "8291f1d9926b57ac70…"` (a hash), on both
   sides.
3. P1-3 / P1-4 — A partial Fold in records a change nobody made ("Changed 'W4' font size 60 → 100" by You). The changes
   left out can never be folded in later ("Nothing to fold in. The cuts are the same.").
4. P1-8 / P1-9 — Share fails as a raw "fetch failed". A teammate who joins lands on Cardboard's "Missing Media Files"
   dialog, whose only primary action is red "Remove and Open".
5. P1-6 — A conflict card's "Preview" of Claude Code's side shows *your* side.

---

## P1 — broken or misleading

### P1-1. The Share tab crashes the editor tab when a teammate is present
- **Steps:** Share a project from A and Join it from B, with the project open in both. Open History → **Share** in one of
  them. As soon as the other person is present (both open, or the host comes back after a drop), that whole editor tab is
  replaced by Cardboard's "This tab hit a snag / Reload tab". I reproduced it 3 times: twice on A, once on B. After
  "Reload tab" the panel is closed. Opening Share again crashes again.
- **Why:** `Peers` calls `actorColor(p.actor, () => undefined)` (`scripts/carton/sync/ui.js:27`). A peer's actor has `id`,
  not `key`, so `hash(undefined)` reads `.length` of undefined (`carton/packages/react/src/actors.ts:22`). The console
  shows `TypeError: Cannot read properties of undefined (reading 'length') at Qt … at ce … at An (carton-ui.js)`.
- **What Cardboard does:** a panel's failure never takes the timeline down.
- **Fix:**
  - Pass `{ ...p.actor, key: p.actor.id }`, or make `actorColor` fall back to `a.id ?? a.name ?? ""`.
  - Also wrap every Carton surface (sidebar, stage stack, banner) in its own React error boundary, so a Carton bug shows an
    inline "Something went wrong in History" instead of killing the editor.
- **Shots:** `37-B-tab-crash-peer.png` (the crash), `36-A-share-peer.png` (A's Share tab just before the crash).

### P1-2. A hash in History: `Set 'clip.mp4' content to "8291f1d9926b57ac70…"`
- **Steps:** Share a project. A version appears at the top of History on the owner's side (by You) and on the teammate's
  side (by Vikas). `cb compare` describes the same thing as "Cleared content on 'clip.mp4', cleared shared media".
- **What's wrong:** It shows an id/hash, and the words are a tool's ("content", "shared media"). The rule is no ids or hashes.
- **Fix:**
  - In `carton/packages/core/src/engine/describe.ts:109` / `:169`, describe the media content-address field in words:
    "Shared 'clip.mp4' with the team" or "Made 'clip.mp4' available to teammates".
  - Or mark it as a system version and don't list it at all.
- **Shots:** `30-B-history.png` (teammate), `38-A-teammate-edit-in-history.png` (owner, second row).

### P1-3. A partial Fold in records a change nobody made, and doesn't say it was a fold
- **Steps:**
  1. Make a cut "Client review" from Main.
  2. On it, make three changes: move the clip (You), W2's text (Director), W4's font size 100 → 60 (Claude Code).
  3. Choose cut menu → Fold into Main cut, untick the W4 change, and press Fold in.
  4. Switch to Main cut.
- **What's wrong:** Main's History now starts with two fold-icon rows:
  - "Changed 'W4' font size 60 → 100 · You". Main's W4 was never 60, and nobody changed it.
  - "Moved 'clip.mp4' 0.0 s → 2.0 s · You". This is the fold itself. It doesn't name the cut, doesn't say it was a fold,
    and hides that Director's W2 change came in with it.

  `cb history` shows these as `merge` + `partial-revert` by "Terminal" (Terminal is the known credit issue). The editor's
  content is right; the history is wrong.
- **Fix:**
  - Record a partial fold as one version: "Folded in 'Client review' (2 of 3 changes)", credited to the person.
  - Never list the internal revert of the left-out changes as its own row. If it has to exist, hide it as a system step.
- **Shots:** `11-fold-dialog.png`, `12-fold-some.png`, `14-main-after-fold.png`.

### P1-4. "You can fold in the rest later" is false
- **Steps:** After P1-3, switch to Client review, then cut menu → Fold into Main cut.
- **What's wrong:** The dialog says "Nothing to fold in. The cuts are the same." Yet W4 is still 60 on Client review and
  100 on Main (`cb compare main@15 6a139f92@3` lists "Changed 'W4' font size 100 → 60"). The change left out can never be
  brought in. The promise comes from `foldRestLater` (`carton/packages/react/src/words.ts:65`), shown on the earlier
  dialog (`12b-fold-none.png`).
- **Fix:** Record left-out changes as "not yet folded", so the next Fold offers them. Until then, drop the sentence.
- **Shot:** `52-fold-again.png`.

### P1-5. Versions with several changes show only the first one
- **Steps:**
  - Restore an older version (row ⋯ → Restore). The new row reads only "Moved 'clip.mp4' 2.0 s → 0.0 s", but `cb compare`
    shows 3 changes (clip, W1 text, W2 text).
  - The project set-up apply, which added 2 tracks, a clip and 6 titles, reads only "Added track 'Mine'".
- **What's wrong:** A restore should say it's a restore ("Restored the version from 12:41 · Claude Code"). A version with
  N changes should say "…and 2 more". Core's `describe` already writes "and N more changes" for one item, but the panel
  takes only the first line of the summary (`carton/packages/react/src/from-carton.ts:519-527`).
- **Fix:**
  - Name restore and fold versions by what they did.
  - For other versions, show the first change plus "and N more", with the full list in a tooltip or an expandable row.
- **Shots:** `18-restore-confirm.png`, `02-history-authors.png`.

### P1-6. A conflict card's "Preview" of the agent's side shows your side
- **Setup:** The person drags W6 from 5 s to 7 s. At the same time, Claude Code's view save moves W6 from 5 s to 9 s.
  This makes the card "'W6' timing".
- **Steps:** Press **Preview** on the Claude Code side.
- **What's wrong:** The banner says "Previewing Claude Code's edit · Read-only", but the editor's state and timeline show
  W6 at 7 s (yours), with the playhead at 7 s. Claude Code's 9 s isn't on screen. Cardboard's text toolbar and the resize
  handles also appear on W6 in this read-only view.
- **Caveat:** In this run the person's drag also moved W6 onto a new track ("Text 1"). That may be why the previewed side
  is resolved wrongly. It needs a repro on the same track.
- **Fix:**
  - Show the other side's document, with the playhead on *their* position (`scripts/carton/ui.js:176`).
  - Hide edit affordances while read-only.
- **Shots:** `40-agent-card.png`, `41-card-preview.png`.

### P1-7. Watch the changes: the After toggle is outside the panel
- **Steps:** History → row ⋯ → Compare with current → Watch the changes, at the default panel width (384 px).
- **What's wrong:** The Before/After toggle (`carton-segmented carton-ab`) ends at x = 1201, past the panel's right edge at
  1138. "After" is cut off and "Before" is half hidden. The controls row (◀ Play changes ▶ Change 1 of 1 0:00.0 Before After)
  doesn't fit and doesn't wrap.
- **Fix:** Wrap the row, or move the A/B toggle above the player. Test at the panel's minimum width (300 px,
  `scripts/carton/ui.js:56`).
- **Shot:** `16-watch.png`. Source: `carton/packages/react/src/components/WatchTheChanges.ts:277`.

### P1-8. Share fails as a raw "fetch failed", and an unreachable host makes the token look like the problem
- **Steps:** Share tab → host `http://127.0.0.1:8799` (nothing listening) → name → Share.
- **What's wrong:**
  - The host check fails, so the token field becomes required. Its label drops "(if the host asks)", and Chromium's native
    bubble says "Please fill out this field.", pointing the user at the token.
  - Fill in any token and you get **"fetch failed"** in red under the button (`errText` passes the raw message through,
    `scripts/carton/sync/ui.js:12`, `:59`, `:75`).
  - Cardboard's own errors are sentences ("Your project files are safe. Reload this tab…").
- **Fix:**
  - When the host can't be reached, say so at the host field: "Can't reach this address. Check it, or that the host is
    running." Keep the token optional.
  - Map network errors to words.
  - Replace native validation with inline messages in Cardboard's style.
- **Shots:** `24-share-token-required.png`, `25-share-fetch-failed.png`.

### P1-9. A teammate who joins lands on "Missing Media Files" with a destructive primary button
- **Steps:**
  1. In B, open any project → Share → paste the invite link → name → Join.
  2. You get '"Audit project" is in your library now.' Open it.
- **What's wrong:**
  - Cardboard's "Missing Media Files" dialog appears ("1 file could not be found. They may have been moved or the storage
    device was disconnected."). Its only primary action is red **Remove and Open**. On a shared project that would likely
    remove the clip from everyone's timeline. I didn't try it.
  - The Share panel says "footage stays on this computer until you share it", but nothing in the app shares footage.
  - The dialog's wording (moved files, disconnected drive) is wrong for a teammate.

  I got past it only with `cb media relink`.
- **Fix:**
  - For a joined project, replace this dialog (or its wording) with "Footage from Vikas hasn't arrived yet", and offer
    "Open without it", which shows placeholders and never removes anything.
  - Give the owner a "Share footage" action.
- **Shots:** `29-joined.png`, `29b-B-missing-media.png`.

### P1-10. The "Director turns" filter is empty while the list shows Director versions; Claude Code turns have no filter
- **Steps:** A project with two versions credited to "Director" → filter "Director turns".
- **What's wrong:** "No Director turns yet."
- **Caveat:** These Director versions were made with `CARDBOARD_ACTOR=director/…` and no turn hook, so a real in-app turn
  may show. Still, a version the list credits to "Director" should never be missing from a filter called "Director turns".
  Claude Code's and Codex's turns, which the README says are named like the Director's, have no filter.
- **Fix:** Call it "Agent turns" and include every agent's turns. Or filter by author, and fall back to listing the agent's
  versions when no turn is recorded.
- **Shot:** `05-filter-director.png`. Source: `carton/packages/react/src/words.ts:22`, `:25`.

---

## P2 — inconsistent or unpolished

### P2-1. Keyboard focus and Esc
Cardboard's dialogs (Export) put focus on the dialog and close on Esc. Carton's layers mostly drop focus to `<body>`:

| Surface | Esc | Focus after |
| --- | --- | --- |
| Row ⋯ menu | closes | `<body>`, not the ⋯ button |
| Cut menu → New cut form | reopens the cut menu, which has no focus, so a second Esc does nothing (the menu stays open) | `<body>` |
| Compare card | doesn't close it | `<body>`; the card never takes focus |
| Watch the changes | doesn't leave it | `<body>` |
| Preview banner | does nothing | — |
| Reply box | silently discards the typed reply | `<body>` |
| Fold dialog | closes | the cut button (good); on open, focus starts on the ✕ |
| History panel | closes the whole panel, even from inside the list | — |
| Filter (role=radiogroup) | — | arrow keys don't move between All / Named / Director turns |

**Fix:** Return focus to the element that opened each layer. Make Esc close the innermost layer only: menu → form →
compare/watch → preview → panel. Move focus into the Compare card and Watch view when they open. On first open, put focus
on the dialog itself, as Cardboard does. Ask before discarding a typed reply.

**Shots:** `07b-newcut-form-long.png`, `07c-after-esc.png`, `15b-compare-esc.png`, `22-reply.png`, `49-kbd-focus.png`.

### P2-2. The row highlight stays after the row menu closes
- **What's wrong:** After a row's ⋯ menu closes, the row keeps its highlight and ⋯ button. Two rows can look selected at
  once.
- **Fix:** Clear the hover/active state when the menu closes. Only the row that's actually focused or previewed should be
  highlighted.
- **Shots:** `13-after-fold.png`, `17-preview.png`.

### P2-3. Row menus near the bottom open off-screen
- **What's wrong:** On the last rows the ⋯ menu opens downward. Only "Preview" is visible, and the rest is cut off by the
  window. While it's open the whole panel shifts: the cut switcher slides under the tabs and a second scrollbar appears.
- **Fix:** Flip the menu upward when there's no room (collision detection), and don't scroll the panel's ancestors.
- **Shots:** `54-oldest-row-menu.png`, `55-panel-scrolled-header.png` (a row menu with room: `03-row-menu.png`).

### P2-4. No confirmation after Fold in, Restore or "Keep Claude Code's"
- **What's wrong:**
  - Nothing says it worked.
  - After Fold in, the panel stays on the source cut, so the result isn't visible either.
  - Restore runs straight from the menu without a toast.
- **Fix:**
  - Show a short toast: "Folded 2 changes into Main cut · Undo", "Restored the version from 12:41 · Undo", "Kept Claude
    Code's timing · Undo".
  - After Fold in, switch to the target cut, or offer to.
- **Shots:** `13-after-fold.png`, `43-after-keep.png`.

### P2-5. The Compare card doesn't say what changed
- **What's wrong:**
  - The card shows When/Who/Clips/Length for each side and "7 shots / 6.0 s of 6.0 s differ". `cb compare` already has the
    plain-word list ("Moved 'clip.mp4' …", "Changed 'W1' text …").
  - "Shots" is jargon here.
  - "Clips: 7 clips" counts titles.
  - The card squeezes the version list to about 4 rows, and the compared row isn't highlighted.
- **Fix:** List the changes (as the Fold dialog does), show "Everything after 0:00 differs" style words instead of shot
  counts, and highlight the compared row.
- **Shot:** `15-compare.png`. Source: `CompareCard.ts:58`, `words.ts:111`.

### P2-6. Watch the changes shows a stand-in instead of frames
- **What's wrong:**
  - The player is a green gradient card with "W1" on it, an old item name. The current text is "Hello world". There is no
    `<img>`, `<canvas>` or `<video>`.
  - The strips are small coloured blocks.
  - The timecode is in Geist Mono ("0:00.0"); Cardboard's timecode is "0:00 / 0:06" in Geist.
- **Fix:** Use real frames (Cardboard's thumbnailer or `cb look`), or label it "Preview not available". Use Cardboard's
  timecode style.
- **Shot:** `16-watch.png`.

### P2-7. The Preview banner's wording and layout
- **Wording:** "Previewing Changed 'W5' font size 100 → 80" reads as broken English. Use "Previewing the version from
  12:41 (Claude Code)".
- **Layout:** At the default width the banner wraps to two lines and covers the top of the preview.
- **Read-only isn't enforced in the toolbar:** Undo stays enabled. Ctrl+Z correctly does nothing.
- **Shots:** `17-preview.png`. Source: `words.ts:171`.

### P2-8. The Share panel's words are an engineer's
- **What's wrong:**
  - "Carton host", "Owner invite or admin token (if the host asks)", "Shared through http://127.0.0.1:8790 as Vikas" all
    name the tool and the system.
  - The placeholder "Alice" isn't the user.
  - "Your name" is asked twice (Share and Join).
  - "Join a shared project" also shows on projects that are already shared, or were joined.
- **Fix:** "Sharing server" or a hidden default, "Invite code (if you were given one)", "Shared as Vikas". Hide the token
  until a host asks for one. Ask for the name once, as an app setting. Move Join to the Dashboard (see P2-9).
- **Shots:** `23-share-empty.png`, `26-shared.png`, `26b-shared-full.png`.

### P2-9. Join lives inside a project and ends without an "Open"
- **What's wrong:**
  - To join a project you must first open some other project and go to its History → Share tab.
  - After joining, the panel says '"Audit project" is in your library now.' and keeps the filled-in form, with no Open
    button.
- **Fix:** Put "Join a shared project" on the Dashboard (or in the File menu), and open the project when the join
  completes.
- **Shot:** `29-joined.png`.

### P2-10. The role picker is a native `<select>`
- **What's wrong:** "Can edit / Can comment / Can watch" is an OS-styled `<select>` with a Windows chevron. Cardboard's
  pickers are custom menus (title bar "16:9 ⌄", Opus model picker).
- **Fix:** Use the same Radix menu as the cut switcher.
- **Shot:** `27-invite-link.png`. Source: `scripts/carton/sync/ui.js:39`.

### P2-11. Presence and sync status are only in the Share tab, and presence was wrong
- **What's wrong:**
  - With Leo in the project, A's Share tab said "Nobody else is here right now." (B's did list A, and crashed, P1-1).
  - There are no avatars in the title bar or panel header.
  - Offline/Syncing shows only inside the Share tab, so someone editing with History or nothing open never sees "Offline:
    3 edits waiting".
  - `PresenceAvatars` and `SyncStatusWords` exist in `@carton/react` (`components/Presence.ts:57`, `components/status.ts:13`)
    but aren't mounted in `scripts/carton/ui.js`.
- **Fix:** Put a small avatar stack and a sync dot next to the title-bar Share icon (Offline in amber).
- **Shots:** `36-A-share-peer.png`, `34-A-share-offline.png`, `35-A-tabs-offline.png`.

### P2-12. The offline message repeats itself
- **What's wrong:** "The host can't be reached. Edits wait here and go out when it can." is followed by "couldn't connect to
  the host: offline, unreachable, or the connection dropped". "Create link" is still offered while offline.
- **Fix:** Keep the first sentence. Move the detail into a tooltip. Disable Create link offline.
- **Shot:** `34-A-share-offline.png`.

### P2-13. The History panel hides the preview in a narrow window
- **What's wrong:** At a 960 px-wide window (CSS px), the 384 px panel plus the chat leave no room. The preview disappears
  entirely and the Library is clipped. Cardboard alone still shows a small preview at that width (`48-narrow-no-panel.png`).
- **Fix:** Let the panel shrink to its 300 px minimum, overlay the chat, or auto-collapse the Library when the stage would
  go under about 320 px.
- **Shot:** `47-narrow-history.png`.

### P2-14. Two identical "history" icons
- **What's wrong:** Carton's title-bar History icon (clock with arrow) is the same glyph as the chat panel's own
  chat-history icon, about 300 px away, with a different meaning.
- **Fix:** Use a different glyph for version history (layers / branching clock), or label the button.
- **Shots:** `00-editor-blank.png`, `00-tabs.png`.

### P2-15. Every agent looks the same
- **What's wrong:** Director, Claude Code and Codex all get the same generic sparkle avatar in similar blue-violet tints.
  You can't tell them apart at a glance in a long list. Cardboard's chat shows Claude's own mark for the model.
- **Fix:** Give each agent its own mark (Director = Cardboard logo, Claude Code = Claude burst, Codex = its mark), or at
  least distinct colours.
- **Shot:** `02-history-authors.png`.

### P2-16. Truncated text has no tooltip
- **What's wrong:** Long version names ("Changed 'W4' text "W4" → "Lower third: Jane S…"") and long cut names ("Client
  review — shorter version …") are truncated with no `title` and no hover reveal. The cut trigger has neither `title` nor
  `aria-label`.
- **Fix:** Add tooltips, or let the row title wrap to two lines.
- **Shots:** `02-history-authors.png`, `09-cut-menu-2cuts.png`, `53-rename.png`.

### P2-17. 150+ versions: a flat wall of rows
- **What's wrong:**
  - 159 rows of identical-looking edits all say "18 min ago". There are no groups by turn, person or day, no search, and no
    "jump to now".
  - Scrolling felt less smooth than Cardboard's own lists. I didn't measure it properly, so I quote no number.
- **Fix:** Group consecutive versions by the same author or turn ("Director · 12 edits ▸"), add day headers, and add a
  search box.
- **Shots:** `44-long-history-top.png`, `45-long-history-scrolled.png`, `46-long-history-bottom.png`.

### P2-18. "Imported the project" on a project that was created, not imported
- **What's wrong:** A blank project from `cb project create` shows "Imported the project · You", then "Started the cut".
- **Fix:** Use "Created the project". Keep "Imported" for real imports.
- **Shot:** `01-history-blank.png`.

### P2-19. Folding from Main isn't possible from Main
- **What's wrong:** Main's cut menu has no "Fold 'Client review' in here". You must switch to the other cut and use "Fold
  into Main cut", and switching cuts changes the editor too.
- **Fix:** Offer "Fold in from…" on the current cut's menu.
- **Shot:** `04-cut-menu.png` vs `09-cut-menu-2cuts.png`.

### P2-20. The Comments composer
- **What's wrong:**
  - There's a "Comments" heading under the "Comments" tab.
  - The textarea shows the native resize grip.
  - The disabled "Comment" button is the white primary at 50 % opacity, a grey slab.
  - The timestamp chip ("0:00.0") is Geist Mono on a box.
  - No comment marker was visible on the timeline for a comment pinned at 0:00.
- **Fix:** Drop the heading, set `resize: none` and grow the box with its text, and use Cardboard's disabled style (as its
  send button). Show time as "0:00".
- **Shots:** `19-comments-empty.png`, `21-comment-posted.png`, `21b-comment-markers.png`.

---

## P3 — nits

1. **Mixed quotes.** Rows use `'W1'` and `"Hello"`. The Fold title uses curly quotes (“Client review” into “Main cut”).
   Pick one style (curly). Shot: `11-fold-dialog.png`.
2. **Conflict card wording.** "Both edits kept; you pick." contradicts "Showing now" on one side; try "Two different
   timings — pick one" (`words.ts:79`). The pill reads "1 conflict card waiting", then "1 conflict", then "SET ASIDE (1)" for
   the same thing. "Keep yours" and "Keep Claude Code's" are both secondary, with no default. Shots: `40b-agent-card-crop.png`,
   `42-card-notnow.png`, `42b-card-reopen.png`.
3. **The "You" avatar changes letter and colour.** It's "Y" in blue until the project is shared, then "V" in purple (the
   share name), while the label still says "You". Shots: `02-history-authors.png`, `38-A-teammate-edit-in-history.png`.
4. **The same `cb` edit has two names.** A `cb` typed in a terminal is "You" in the panel but "Terminal" in `cb history`.
5. **The Fold dialog's first focus is the ✕.** Cardboard's Export focuses the dialog. The Fold dialog also has a 0.8 px
   white/8 % border that Export doesn't. Shots: `11-fold-dialog.png` vs `50-stock-export-dialog.png`.
6. **The title bar overflows at narrow widths.** The two Carton icons add about 56 px, and tabs then run under History and
   Share. Cardboard's own "+" already overlaps tabs at that width, so this is pre-existing but made worse. Shot:
   `47b-narrow-tabs.png`.
7. **Tooltips have no shortcuts.** History and Share use plain native `title` tooltips without shortcuts, while "Report an
   issue (Ctrl+⇧B)" shows one. Consider a shortcut for History.
8. **The cut switcher has no tooltip** for a truncated name (see P2-16), and no `aria-label`.
9. **The top row is cut off with no divider.** When scrolled, the top row slides under the filter bar with no divider or
   fade. Shot: `45-long-history-scrolled.png`.
10. **The empty Named filter has a long hint.** It's good copy, but it wraps to three lines at the default width. Shot:
    `06-filter-named.png`.
11. **The New cut name field's focus ring** is a 2.4 px light ring. Cardboard's inputs ("Search project media…") use a subtler
    border. Shot: `07b-newcut-form-long.png`.
12. **Undo stays enabled in read-only preview** (see P2-7). It does nothing, but it looks usable.
13. **The "Change 1 of 1" counter** sits beside "7 shots differ" in Watch the changes. The two counts contradict each other.

---

## Already known (listed for completeness, not re-investigated)

- A split reads "Added video / Added video / Deleted video" in History and in the Fold dialog.
- `cb history` shows "unknown root" / "unknown fork". Seen here: `main@0 unknown root`, and `main@1 person import`.
- A redo is labelled "revert".
- A Fold in from the panel is credited to "Terminal". Seen: `cb history` shows `merge` / `partial-revert` by Terminal,
  while the panel shows "You" (P3-4).
- Restore or "New cut from here" on the oldest row ("Started the cut") empties the project. **Both are still offered on that
  row** (`54-oldest-row-menu.png`). I didn't click them. Suggest hiding them on the root row until the fix lands.

## Not reached

- **Real in-app Director / Claude Code turns** (the account's usage limit). They were simulated with `CARDBOARD_ACTOR` and
  `CLAUDECODE=1`, so turn names, turn grouping and "Undo turn" weren't seen.
- **The "too large" and daily-limit messages.** There's no cheap way to trigger them.
- **A person-vs-teammate conflict card.** Only the agent-view card was produced; a two-person clash needs offline edits on
  both sides.
- **A window wider than 1920 physical px.** The monitor limit. "Wide" here is the 1920 × 1020 default (1536 CSS px).
- **Toasts.** None appeared anywhere in the flows above (see P2-4).
