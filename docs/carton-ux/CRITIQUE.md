> An independent critique of the **first draft** of `DESIGN.md`, by a second designer. `DESIGN.md` §12 lists what was
> changed because of it, and what wasn't and why. Mockup names here refer to the first draft's renders.

# Critique of the Carton redesign

The stance is right: you read in the panel, play on purpose, and your edit is home. Words in place of strips is the biggest single gain. The design still fails the user's own test in four places: clock times, too many viewing signals, the edit-attempt card, and "relative to my work".

## 1. Does it fix the three complaints?

**"Viewing diff not intuitive."** Mostly fixed. Change rows in sentences are a real answer. But the card still ends in a transport bar (`◀ Pause ▶ · 1 of 12 · Before`, editor-viewing.png). That is Watch the changes again, smaller: "1 of 12" is "Section 1 of 1" with a new number, and Before is the Before/After switch with one half removed. The change map's ticks have no labels and don't say what they're for. The same user will ask "what do ◀ ▶ do, and before *what*?"
→ Put a ▶ on each row (play this change). Keep one **Play all** button. Drop the counter and the global ◀▶.

**"No unnecessary banners."** Half fixed. The stage at rest is clean. But the banner comes back three ways:
- the panel's viewing bar has a white primary button: the old card, moved;
- the edit-attempt card sits over the picture, at three lines and two buttons (editor-edit-attempt.png), and says "Changes can't be made here", which is "Read-only" in other words;
- a teammate's cut shows a **View only** pill, a viewing bar, and two action buttons (history-teammate-cut-384.png).

**"Always know which cut, and what I'm looking at relative to my work."** The cut chip fixes the first half. The second half is not answered. An old version's card shows what *that version* did, compared with the one before it. It doesn't show how it differs from your edit now. That comparison is behind `⋯ → Compare with your edit` or Shift+click, which nobody will find.

**The viewing state is too much.** One state is announced in six places at once:
- the chip's second part;
- the panel bar;
- the row's "Viewing" badge, with a blue edge;
- the stage frame;
- the stage tag;
- the timeline frame.

Rule 1 says that with the panel closed you always see your edit. So viewing nearly always happens with the panel open, and the row mark plus the chip already say it. There are also three different labels for one state: in editor-before.png the chip says "Before 12:20", the tag says "Before Director's changes · 12:20", and the bar still says "Viewing 12:20 · Director".

## 2. Top 10 problems

1. **P1: Clock times read as timecodes.** ("Viewing 12:20", "Restore 12:20…", "Before 12:20", "Went back to 12:41".) editor-viewing.png, changes-384.png, toasts.png. The same rows put `0:06` (a timecode) next to `12:41` (a clock time). An editor reads 12:20 as twelve minutes twenty. **Fix:** name a version by what it is: "Director's 'Add captions…'", "Sent to client", or "your edit at 12:20 pm". Write clock times with am/pm everywhere, and never a bare H:MM.
2. **P1: Six viewing signals, and the panel bar is a banner.** editor-viewing.png, editor-before.png. **Fix:** keep the chip's part (with its ✕), the 2 px frame and the row mark. Delete the panel bar. Show the stage tag only when the panel isn't open (conflict sides, the drawer), as a label on the frame rather than a pill. Give the state one label, built in one place.
3. **P1: The edit-attempt card is the old banner, over the picture.** It also offers **Restore** in answer to a misclick. editor-edit-attempt.png. **Fix:** a one-line toast where the edit was tried: "You're looking at Director's version. **Back to my edit** (Esc)". Pulse the frame once. No Restore.
4. **P1: Nothing says what you'd lose.** history-expanded-384.png, editor-viewing.png. **Fix:** on any version that isn't the newest, start the card with "Your edit has 7 changes since this · See them". Make Play on an old version open the Changes view (old → your edit), which is the question people are asking.
5. **P2: Before shows no difference in the mockup, and costs a whole timeline swap.** editor-before.png is pixel-identical to editor-viewing.png. **Fix:** hold **B** to peek and release to return, with the other document loaded beforehand. Measure the flip time before promising "flip between before and after" (see §4).
6. **P2: Three counting nouns, and "edit" means two things.** "18 versions", "6 edits", "4 changes", and "the edit shows yours" (conflict-card.png). **Fix:** count in **changes** everywhere. Day headers drop their counts or say "18 changes". "Your edit" only ever means your timeline.
7. **P2: Picking a conflict side swaps the stage.** That is a side effect of a click, which breaks Rule 2. The card also covers about a third of the picture, and the chip shows no viewing part in that state, unlike §4.2. editor-conflict-theirs.png. **Fix:** the radios only pick. Each side gets a small **▶ See it**. Make the card compact (title, two rows, button) and anchor it over the timeline near the clip.
8. **P2: Change sentences disagree across mockups.** That breaks Rule 4. Examples: "Trimmed 'Intro' to 3.0 s" (fold-some.png), "Trimmed 'Product close-up' to 4.0 s" (history-default), "Trimmed 'Interview A' end" (history-many), "Changed caption 'we cut editing time'" (changed to what?), "Font size 80" (conflict-during-turn). **Fix:** one `describe` table, rendered in every mockup from the same data, in the editor's units ("now ends at 0:05").
9. **P2: The cut chip is low-salience, far from the work, and the chat ignores cuts.** In editor-other-cut.png the 30s cut looks identical to Main cut. The grey chip copies the style of `16:9`, sits about 1,300 px from the timeline, and Director's "Done. I trimmed…" from the other cut is still on screen. **Fix:** also put the cut name in the timeline header (the timeline hook is already planned). Give a cut other than Main a colour dot in both places. Label agent turns in the chat with the cut they ran on.
10. **P2: The filter state can't be seen, and the "Only 'Interview B'" filter isn't mocked.** "Back to now" covers a row's text (history-many-384.png). **Fix:** show an active filter as a removable chip under the cut bar ("Agent turns ✕"). Dock "Back to now" at the list's bottom edge.

Also (P3):
- In fold-some.png, "Comes with the rest" sits on a checkbox that looks clickable: lock it visibly. "Select none" is missing.
- The new-cut toast is cut off at 1,120 px (toasts.png).
- "Undid: going back to 12:41." reads awkwardly.
- **Copy as a new cut**, **New cut from here** and **New cut from your edit** are three names for one act.

## 3. Missing states and flows, and words

**States and flows:**
- **Export, Ctrl+Z, or a Director prompt while viewing:** which version does each act on? Export is the dangerous one.
- **Agent turn running and you switch cut:** the design *warns* that later edits land on the new cut. That is a trap, explained. Pin the turn to its cut, or block the switch until the turn ends.
- **An agent starts or finishes while you're viewing,** and a conflict arrives as a pill you can't open: what tells you?
- **Old versions with missing footage** (deleted media, or a joined project still arriving): what does Play show?
- **Play that can't load** (a big project, a slow disk): no loading or error state is drawn.
- **Undo this turn** hitting a conflict while the panel is open. **Two people restoring at once.** **Restore offline** on a version that hasn't synced.
- **Many cuts and teammates:** 10+ cuts, and three teammates each with a "Main cut", give "Leo's Main cut" next to yours. Nothing shows grouping or scrolling.
- **Partial fold from a teammate who is still editing.** **A fold while an agent turn is running.**
- **"See it as it was" from Comments:** the viewing bar lives on the History tab. What does the Comments tab show?
- **Viewing in a narrow window:** the chip's viewing part at 1,180 px isn't mocked.
- **Screen readers:** Play's "3 of 7" must not repeat in a live region on every step.

**Words that break the rules:**
- "Viewing" and "View only" are read-only by another name.
- "Waiting to sync" ("Not sent yet").
- "Sharing server" with a raw address field, and "Invite code".
- "Restore" on the button but "Went back" in the toast: one act, two verbs.
- **Fold in**: no editor says "fold". "Bring in changes" reads better.
- "Comes with the rest".
- "Vikas (you)" in Share, "You" everywhere else.
- Three different "back"s: "Back to now", "Back to my edit", "Back to Main cut".
- "Show: Everything".
- A bare "Name" next to Restore in changes-384.png: name *which* version?

## 4. Feasibility and performance

- **The title bar is a separate page from the editor.** Main routes `carton-*` commands to the active tab (`patch-carton.js:292`). The cuts menu therefore has to be drawn in the editor's page at the chip's x. Focus, click-outside, Esc, arrow keys and the screen-reader focus would all have to cross two documents. That makes it a prototype item, not "small".
- **Title bar width.** The chip plus its viewing part takes about 340 px in a strip whose tabs already shrink. The chip must never carry anything that changes per frame.
- **Edit-attempt routing.** Refusals today are the `Tm` guard plus `ure`'s message in Cardboard's own toast. Moving them to our card means catching every edit path: drag, trim, Delete, the stage's text editor. Any path missed drops the edit silently.
- **Global Esc.** Cardboard's own Esc clears the selection (noted in `renderer-bridge.js`), and Play *selects the clip*. So the first Esc deselects and nothing visible happens. Either don't select during Play, or take Esc while viewing.
- **Structured changes with an author over a range.** `compare()` returns strings today (`model.ts`). Naming who made each row in "Changes since Oct 28" means diffing every version in between. Name authors only in a version's own card, or attribute them lazily for the rows on screen.
- **"Only 'Interview B'" at 10k versions** needs a per-version index of which clips each version touched, written at save time. Diffing on demand won't scale.
- **Play's per-frame cost.** Each change spot means a seek, which stalls on 4K originals. The progress line must move by CSS transform or rAF, not React state, or the list re-renders at 60 fps beside the player.
- **Before during playback** swaps the editor's whole timeline, which re-renders the editor and can reload media. Measure the flip on the laptop before designing around it.
- **The timeline frame and muted clips** need a new patch on a minified anchor. They need a fallback, because the frame is what makes viewing safe.
- **The virtual list with variable-height cards** is fine: `rowTops` handles it.

## 5. Scores (as drawn)

| Region | Score | What makes it a 10 |
|---|---|---|
| History list | 7 | One counting noun, am/pm clock times, a visible filter chip, consistent sentences |
| Version card / changes | 6 | A ▶ per row instead of a transport bar; "N changes since this" on old versions |
| Viewing state | 5 | Three signals, one label; no panel bar; no card over the picture |
| Cuts | 7 | Cut name on the timeline header too, a colour for other cuts, turns pinned to their cut, chat labeled by cut |
| Conflict cards | 7 | Picking doesn't swap the stage; a compact card anchored near the clip |
| Fold | 7.5 | Rows that can't be left out locked visibly, Select none, a plainer verb |
| Share | 7.5 | Hide the server address behind "Set up"; "You" everywhere |
| Title bar | 6.5 | Prototype the menu across the two pages; mock viewing at 1,180 px |
| Toasts | 7 | Shorter, no bare clock times, "Undid going back…" reworded |
| Comments | 7.5 | "Note" or "Comment", not both; define "See it as it was" from this tab |
