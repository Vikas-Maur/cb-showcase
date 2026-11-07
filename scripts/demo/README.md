# A remote teammate from the Linux box (demo rig)

Tooling for a screen-recorded demo: a participant on this box joins a project shared from the Windows app through our
sharing server and "talks" by editing the timeline (titles, spoken lines), while Cardboard's own agent on the laptop
finds it, answers, and hides the conversation from the person with Carton's cuts. What it can and can't do, with real
output: [FINDINGS.md](FINDINGS.md).

A participant is one headless Cardboard: Cardboard 1.4.0's real library worker, patched with every Windows and Carton
patch as `build-windows.js` patches it (staged by `scripts/carton/test/stage.js`), under Node through the worker harness
the sync tests use, with its own app data. Nothing of Cardboard's is in git: `peer setup` stages it from
`CARDBOARD_PRISTINE` into `$DEMO_DIR` (default `~/gfv-scratch/carton/demo`, never `/tmp`). Nothing in Carton or Cardboard
is changed by the rig.

## Needs

- `carton/node_modules` (`cd carton && npm ci`), `CARDBOARD_PRISTINE` (Cardboard 1.4.0's unpacked app and cli; default
  `~/.t3/projects/cardboard-showcase/_inspect/cardboard-1.4.0`), ffmpeg and ffprobe, python3 with PyYAML (cue sheets).
- For speech: Piper and its voices in `$DEMO_TTS` (default `$DEMO_DIR/tts`): FINDINGS.md §5 says what and from where.
- For shots: Playwright (`PLAYWRIGHT`, default `/home/ubuntu/job-finder/node_modules/playwright`) and its Chromium
  (`CHROME`). On the shared dev box, run them through `gfv-scratch/carton/slot.sh`.

## The live session

```sh
scripts/demo/peer setup                                    # once
scripts/demo/peer join "<invite link from the laptop>" --name "Sam" [--agent Director] [--machine sams-laptop]
scripts/demo/peer watch                                    # in a second terminal: what the laptop's side does, live
scripts/demo/peer say "Psst. Is anyone else in here?" --at 3.5 --for 3 --style chat
scripts/demo/peer speak "Can we talk here?" --at 7 --voice ryan
scripts/demo/peer edit "Psst" --text "Hello?"   |   scripts/demo/peer clear "Psst"
scripts/demo/peer presence "Editing captions"   |   --idle   |   --gone
scripts/demo/peer status
scripts/demo/peer run scripts/demo/sample-cues.yaml        # a cue sheet instead of typing; --from <n>, --dry
scripts/demo/peer restart                                  # after a crash: the same participant, its project kept
scripts/demo/peer leave
```

Every command answers in a line, with how long it took. `peer` with no command lists them all. Which participant:
`--peer <name>`, else `$PEER`, else the last one joined here.

A cue sheet is a list of steps, each acting on this side or waiting for the other (`sample-cues.yaml` documents every
step): `say`, `speak`, `edit`, `clear`, `presence`, `wait` (an edit by someone else with some words, a title, someone
arriving or leaving, a new cut; with a timeout), `pause`, `prompt` (waits for Enter: a cue given by hand), `note`.
Spoken lines are made before the first step. Each run's log goes to `$DEMO_DIR/runs/`.

## Rehearsing on this box

```sh
scripts/demo/rehearse.sh                    # local server on 127.0.0.1:8791, Vikas plays the app, Sam joins, then rehearsal-cues.yaml
scripts/demo/rehearse.sh --host https://cardboard-showcase.vikasmaur10.workers.dev   # the live server (a new project there: 10 per address per day)
node scripts/demo/shots.js --app Vikas --out <dir> --state "Main cut@7.5" --state "Vikas's cut@7.5"   # the app's side, in Chromium
node scripts/demo/bench-latency.js --remote Sam --app Vikas --rounds 10 --sound-every 2   # how soon edits arrive
node scripts/demo/race-hide.js --runs 5      # the hide while Sam keeps talking; --old-flow: the first rehearsal's order
scripts/demo/rehearse.sh --stop
```

In a rehearsal sheet, steps marked `as: Vikas` play the laptop: `cb` (Cardboard's own `cb` on that participant's library,
as the app's Director: `CARDBOARD_ACTOR=director/…`), `agent_say` (its own view, a `<text>` added, `cb source apply`),
`agent_hide` (FINDINGS.md §4.1: a cut from the version before the chat, the shared cut's printed version folded in with
the chat kept out, a check, and the editor switched to it last), `agent_clear`.

## Files

| File | What |
|---|---|
| `peer` | the command line |
| `daemon.js` | one participant, kept running: the worker, its control socket, presence, the live stream |
| `lib.js` | paths, the staged build, a participant's environment, `cb`, the socket client, `watch`'s lines |
| `cues.js` | `peer run`: the cue runner, and the rehearsal's agent steps |
| `tts.js` | Piper: text → WAV or MP3 |
| `host.mjs` | a local sharing server (server-node, open creation, as the live one) |
| `machine.cjs` | `--machine`: the computer name Carton records with a participant's edits |
| `shots.js` | real-browser shots of the app's side, driven by its participant's worker |
| `bench-latency.js` | how soon a remote edit shows on the app's side |
| `repro-import-race.js` | FINDINGS.md §6.1: a teammate's change deleted after an import |
| `race-hide.js` | FINDINGS.md §4.1: the hide while the remote keeps talking (a line between the agent's reading and its fold), checked on its own |
| `rehearse.sh`, `rehearsal-cues.yaml`, `sample-cues.yaml` | the rehearsal, and a sheet for the real session |
