# N-1: one Delete of a title saves two versions; one Ctrl+Z undoes only the newer one

Build: `out/carton-prod3` = merge/prod-2 @ `eea781bb`, Windows, 2026-11-02/03. Reproduced by the laptop manager on a fresh,
healthy `mkproj` project (clip + titles W1–W6), Carton on, DevTools keys; and by the recovery re-check subagent 7/7.

Steps: select W6 on the Agents track, press Delete; then press Ctrl+Z once.

| Carton | After Delete | After one Ctrl+Z |
|---|---|---|
| on  | `main@4 person edit` "Deleted title 'W6'", then `main@5 person edit` "Deleted media 'Text: W6'"; editor and disk W1–W5 | `main@6 person undo` "Added media 'Text: W6'" only; W6 stays gone in the editor and on disk (to the user, Ctrl+Z did nothing) |
| off (same build, stock path) | editor and disk W1–W5 | editor and disk W1–W6: undone in one step |

The two saves' order varies. Title first, then media (all 6 recovered-project runs): one Ctrl+Z seems to do nothing. Media
first, then title (the subagent's healthy "P4 Healthy"): one Ctrl+Z brings the title back on screen and leaves the media
entry deleted.

Files:
- `n1-history.json`: `cb history <p> --limit 6 --json` of the laptop manager's repro project.
- `n1-compare.txt`: `cb compare` of main@3→4, 4→5, 5→6.
- `n1-off.log`: the same steps with Carton off.
- `mine-n1-a.txt` (+ 2 shots): the Carton-on run, with head, disk, editor, the history panel and the page console during
  the delete and the undo (only a MaxListenersExceededWarning; no errors).
- `3d-compare-steps.txt`, `3g-history-*`: the subagent's recovered-project runs. `4h-healthy-*`: its healthy-project run.
- `../recover/REPORT.md`: the full recovery re-check on eea781bb (items 2–4 all PASS; N-1, N-2, N-3).
