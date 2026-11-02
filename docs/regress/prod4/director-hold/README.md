# A real in-app agent turn doesn't hold the person's edits back from timeline.tsx during a long foreground tool call

> **Update:** the same-recipe A/B at the end shows 0cc587f1 does the same, so this is a gap in both builds, not a
> regression. The "held on 0cc587f1" pass below came from a different recipe (a backgrounded `sleep 30`).

Build: `out/carton-prod4` = merge/prod-2 @ `3b2407c3`, Windows, Carton on. Reproduced 2/2 by the laptop manager on fresh
projects (clip + W1–W6); the same steps passed on `0cc587f1` (Update 3, `carton-final-0cc587f1-hold-PASS.log`).

Steps (`agent-path.js 9347 carton-prod4 <profile> "Opus 5.5" 300`, `MUTE_AFTER_MS=15000`, `WATCH_MS=40000`):
1. In-app Claude Code (Opus 5.5), prompt: "First run `cb source print` for this project. Then run `ping -n 31 127.0.0.1` in
   the shell and wait for it to finish (run it in the foreground, not in the background). Then set W2's font size to 321
   with `cb source apply`, then immediately read `timeline.tsx` and tell me W2's font size there and whether the clip on the
   Mine track is muted there." (`ping` instead of `sleep`: the agent backgrounds or refuses a 30 s sleep.)
2. 15 s into the turn, while the agent's foreground ping runs (after its first `cb source print`, per the chat log), the
   person selects the Mine clip and presses M.

| | 0cc587f1 (Update 3) | 3b2407c3 (now), run 1 | run 2 |
|---|---|---|---|
| mute pressed | 20.8 s | 20.5 s | 20.6 s |
| mute in timeline.tsx | 65.0 s, after the turn | **20.9 s, during the turn** | **20.9 s, during the turn** |
| person's version | after the turn's | main@4, mid-turn | main@4, mid-turn |
| the agent's read after its apply | "321, not muted (held)" | "321, muted"; it says the file should have kept the change out | same |

The `timeline.tsx` poll (rev line, W2's font size, muted) is in `director-hold*.log`; the agents' full chats (tool calls,
the first print without the mute, the ping, the apply) are in `agent-chat-run*.jsonl`.

Not affected, per the N-1 re-check subagent on the same build: a hook-less agent's `cb` write (a shell with CLAUDECODE=1)
still holds the person's edit back and releases it after.

## A/B with the same recipe (follow-up): not a regression, a gap in both builds
`holdab.sh`: one base profile (project "Hold AB", made by 0cc587f1's own cb with no app running, onboarded once), a fresh
copy per run, the exact ping recipe above, alternating builds.

| Build | mute pressed | mute in timeline.tsx | agent's read after its apply |
|---|---|---|---|
| 0cc587f1 (`ab-carton-old-0cc587f1.log`) | 20.5 s | **20.9 s, mid-turn** | "321 … muted"; someone muted it during the wait |
| 3b2407c3 (`ab-carton-prod4-3b2407c3.log`) | 20.5 s | **20.8 s, mid-turn** | "321 … muted"; "the file is supposed to hold back other people's edits until my turn ends" |

Both builds let the person's edit into timeline.tsx during a long foreground non-`cb` tool call (the ping). The Update 3
pass on 0cc587f1 used `sleep 30`, which Claude Code ran in the background, so it didn't exercise this path.
