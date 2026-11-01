---
name: carton
description: "Work safely in a Cardboard project that other people and agents edit too: read its history, see who changed a clip, work in a cut of your own and fold it in, undo your own turn, and handle conflict cards with the `cb` commands (history, cut, fold, credits, restore, undo --turn, conflicts, resolve, publish). Use when you edit a Cardboard project with `cb` or timeline.tsx and `cb history` shows a BY column, or when a `cb` result says confirmed, pending or conflicts."
---

# Carton: versions, cuts and conflicts in Cardboard

Every edit to a Cardboard project is saved as a **version**, with who made it: the person, the Director's turn, the
subagent, or you. People and agents may be editing the same project right now. Carton makes sure no edit is lost:
when two edits change the same thing, one stays and the other becomes a **conflict card** that someone decides.

The words, with git's in brackets (`cb` accepts both): version (commit), cut (branch), fold in (merge), conflict card
(merge conflict), credits (blame), history (log), restore (revert), compare (diff), published cut (tag).

Every command takes the project's name, id or bundle path first, and `--json`. Without hooks (Codex, Gemini and other
agents), say who you are once, so your edits are credited to you: `export CARTON_AGENT=codex/fix-captions` in your
shell (every `cb` call reads it), or `--as codex/fix-captions` on Carton's own commands (history, cut, fold, credits,
restore, undo, compare, publish, conflicts, resolve).

## Read every write's result

Every `cb` write (`source apply`, `fold`, `restore`, `undo`, `resolve`…) answers with one of these:

| Result | What it means | What you do |
|---|---|---|
| `confirmed` | Saved, in order, for everyone | Go on |
| `pending` | Saved on this machine, but the server hasn't answered yet (or you are offline). It syncs by itself | Go on. If it later clashes, you hear about it on your next `cb` call |
| `conflicts` | On a save, and on `undo --turn` ("Undid turn …: conflicts"): the rest landed, and each card kept the other side's value. When a fold says "Not folded in": nothing was saved (see that section). When a fold says "Folded in, but … came back": it landed except those cards. Either way the cards are yours to resolve like a save's | Read the cards (below). Never write your edit again to get around one |
| `rejected` | Nothing was saved: the edit broke a rule (a clip ending before it starts, a missing track) | Fix the edit and save again |

The exit code is 0 for `confirmed` and `pending`, 1 otherwise. With `--json` the result is
`{status, seq | id, conflicts, ref, notices}`.

**Late conflicts.** A `pending` edit can clash after your call returned. Then the next `cb` call you make starts with a
`Late conflict:` line, and when your turn ends the Stop hook stops you once with the conflict text. Either way, run
`cb conflicts <project>`.

## The loop

1. **Look before you edit.** `cb history <project>` lists versions, newest first, with who made each. `cb cut list
   <project>` shows the cuts; `*` marks the current one. Read the header of what you print: `// cardboard:rev …` names
   the exact version your edit is made on.
2. **Know whose clip it is.** `cb credits <project> <clip>` says who last changed a clip, down to the subagent. If a
   person changed it recently, say so before you change it again.
3. **Edit your own view** when the app is open: `cb source print <project> --view <name>` prints the timeline to a
   file only you edit, and says where it is and where its `.status` file is. Edit it and save it; each save is applied,
   and the `.status` file says how it went (`confirmed`, `pending`, `conflicts`, `rejected` or `error`). If the answer
   is "views need the app open", edit as usual (`timeline.tsx`, `cb source apply`, or MCP `apply_timeline`). Small
   edits, one idea per save. Save from the version you printed: never paste an old file over a newer one.
   While your turn runs, Carton doesn't rewrite `timeline.tsx` with the person's or remote teammates' changes. Local
   agents' saves still go into it. It can still show newer state before your turn ends: after a plain print, a cut
   switch, or a save that repeats an edit it hides. Print again before you rely on what others did.
4. **Read the result** of every save (table above).
5. **After your turn, check your cards.** `cb conflicts <project>` lists the open cards of your edits, numbered:

   ```
   1 open card:
     #1 timelineItems/c2/#time (group) — yours: {"startTime":5,"endTime":18.5} · theirs: {"startTime":5,"endTime":19}
   Resolve with `cb resolve <n> --keep mine|theirs` (or --value <json>).
   ```

   **yours** is your edit; **theirs** is what is in the project now, someone else's edit. Then:
   - `cb resolve <project> 1 --keep theirs`: keep their edit and close the card. This is the default choice.
   - `cb resolve <project> 1 --keep mine`: put your edit back over theirs. Only when the user asked for exactly that
     change, and say so in your reply.
   - `cb resolve <project> 1 --value '<json>'`: a value that keeps both intents, when one exists (for example, your new
     start with their new end).
   - Or leave it. Cards you don't resolve go to the person, who sees them in History.

## Big changes go in a Director's cut

For a restructure, many clips at once, or "try another version", don't edit the person's cut. Work in a cut of your
own and let them take all of it, part of it, or none:

```sh
cb cut new <project> "Director's cut: tighter intro"     # starts from the current version; only the edit is copied
cb cut switch <project> "Director's cut: tighter intro"  # the app follows
# … edit as usual …
cb cut switch <project> main
cb fold <project> "Director's cut: tighter intro" --check
```

`--check` saves nothing. It says what folding in would change and lists any cards:

```
Would fold in with 1 card:
  #1 timelineItems/middle/#time (group: same kind or incompatible) — Main cut: {"startTime":3,"endTime":7,"trimStart":0,"trimEnd":4} · Director's cut: tighter intro: {"startTime":2.5,"endTime":5,"trimStart":0,"trimEnd":2.5}
Decide with `cb fold <project> 'Director'\''s cut: tighter intro' --keep mine` (keep Main cut's) or `--keep theirs` (keep Director's cut: tighter intro's), or keep a clip out with `--reject timelineItems/middle`.
```

Tell the user what the fold would do. Fold only when they ask, or let them fold it in the app. A fold with cards
answers "Not folded in" and saves nothing until every card is decided:
- `cb fold <project> <cut> --keep mine` keeps the current cut's value on every card;
- `cb fold <project> <cut> --keep theirs` takes the folded cut's;
- `cb fold <project> <cut> --reject timelineItems/<clip id>` folds in everything except that clip ("fold in some of
  it"). Repeat `--reject` for more clips.
  To take the kept-out clips later, fold the cut again without `--reject` once it has nothing new: that folds in
  the rest ("Folded in the rest"). If the cut changed since, that fold brings in only the new changes ("Folded in");
  fold once more for the rest.

A clip's start, end, trims and speed are decided together, so a card about `#time` keeps one side's timing whole.

On a shared cut the server can find a clash after the fold was sent. Then the answer is "Folded in, but N cards came
back": the fold landed, the other side's value was kept on each card, and the cards are in `cb conflicts`, to resolve
like a save's (step 5 of the loop).

## Undo, restore, compare

- **Undo your own turn:** `cb undo <project> --turn <turn>` takes back every change of that turn, yours and your
  subagents', as one new version. Changes others made since stay. If someone changed one of the same things after
  you, their newer value stays and you get a card for it: the answer is "Undid turn …: conflicts", the rest is undone,
  and the cards are in `cb conflicts`. On such a card **yours** is the value from before your turn: `cb resolve
  <project> <n> --keep mine` finishes the undo there, `--keep theirs` keeps their edit. Tell the user which clips were
  changed since. `cb history` shows `(turn <turn>)` next to each
  version. Plain `cb undo <project>` undoes the newest change of your undo group (the person's edits and the turns they
  started).
- **Restore** brings back an old version as a new version: `cb restore <project> main@12`. It also takes back everyone
  else's edits since then. To undo only your own work, use `undo --turn`.
- **Compare:** `cb compare <project> main@12 [main@15]` says what changed, in plain words ("Trimmed 'Intro' end 5.0 s
  → 2.5 s"). `cb activity <project>` groups recent versions by who made them.
- **Publish** only when the user asks: `cb publish <project> [version] --name "Sent to client"` makes the Published cut
  the share link shows. A Published cut can't be edited: to change it, publish again.

## Over MCP

`timeline_history`, `undo_timeline` (`rev` to restore, `turn` to undo a turn), `check_timeline` (a dry run of a save,
with the cards it would raise), `timeline_cuts` (`action: list | new | switch`), `timeline_fold` (`check`, `keep`,
`reject`), `timeline_credits` and `timeline_publish`. Results carry the same statuses and late conflicts.

## Habits

- Never overwrite someone else's edit to make your save go through. A card is the answer, not an obstacle.
- Never edit `project.json` or anything in `.carton/`. Edit the timeline. (When Carton's hooks are on, a Write or Edit
  of `project.json` is refused, with a pointer to your view.)
- Print again before editing after a long pause: others may have changed the project. An error that the version your
  file was printed from is no longer available (Carton's own words end in `re-print`) means exactly that: print, then
  redo the edit. It never guesses a base.
- Name what you did in your reply: the versions you made, the cards you left, the cut you worked in.
- Say "version", "cut", "fold in" and "conflict card" to the user, not git's words.
