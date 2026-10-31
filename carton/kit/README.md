# Carton: the injection kit

Carton is git for video, plus live editing together, built for Cardboard. It keeps every version of a project, says
who changed each clip (down to the subagent), lets people and agents work on separate cuts and fold them back
together, and never loses an edit when two of them change the same clip. It is one TypeScript module with no runtime
dependencies, and it runs in Electron and Node (Mac, Windows, Linux), in browsers and in Cloudflare Workers.

This kit is for Cardboard's engineers and their coding agents. With it, an agent can wire Carton into Cardboard's
source and prove the wiring with the conformance suite.

| File | What it is for |
|---|---|
| [README.md](README.md) | This page: the words, the architecture, a 5-minute quickstart |
| [INTEGRATION.md](INTEGRATION.md) | Where Carton goes in Cardboard's source, hook by hook, and how to swap backends |
| [INJECT.md](INJECT.md) | A one-page prompt to paste to your coding agent: inject Carton step by step, with checkpoints |
| [SKILL.md](SKILL.md) | A skill for agents that edit through `cb`: history, cuts, folds, conflicts, and how to behave |
| [CONFORMANCE.md](CONFORMANCE.md) | How to run `@carton/conformance` against your integration, and what each suite proves |
| [LIMITS.md](LIMITS.md) | What Carton can't do yet, said plainly |

## The words

Carton uses editors' words in the app, the CLI and these docs. Agents think in git, so each word's git name is beside
it, and `cb` takes the git words as aliases.

| Carton word | git's word | Meaning |
|---|---|---|
| **Version** | commit | A saved point. One is made for every save and every agent edit. It can be named ("Sent to client, Monday") |
| **Cut** | branch | A separate line of the edit: "Main cut", "30s Instagram cut". Only the edit is copied, never the media |
| **Director's cut** | an agent's pull request | The Director works in its own cut, and you take all of it, part of it, or none |
| **Fold in** | merge | "Fold the 30s cut into Main". Taking part of it is "fold in some of it" |
| **Conflict card** | merge conflict | Two edits changed the same thing. Both are kept, and someone picks |
| **Published cut** | release tag | The version the share link shows |
| **Compare** | diff | What changed between two versions, in plain words |
| **Restore** | revert / checkout | Bring back an older version, saved as a new version |
| **Undo turn** | revert by author | Undo everything one agent turn did, as one change |
| **Credits** | blame | Who last changed a clip, down to the subagent |
| **History** | log | The list of versions |
| **Live** | (none) | People and agents editing one cut at once |
| **Syncing · Up to date · Offline: N edits waiting** | push / pull | The sync status, in words |
| **Bring in their changes** | pull from a bundle | Fold a teammate's `.cbproj` into your cut |

## How it fits together

```
 Cardboard app (Electron)            cb CLI, MCP, agents               Browser (web app)
 ─ renderer: History panel,          ─ @carton/cli-mcp: the commands   ─ @carton/core
   conflict cards (@carton/react)    ─ @carton/local: who is acting,   ─ @carton/store-idb
 ─ library worker: the engine          hands writes to the one           (IndexedDB)
   thread (@carton/local),             process that holds the lease
   project.json and timeline.tsx
   writer (@carton/cardboard/node)
              │                                 │
              └──── <project>/.carton/carton.db (SQLite, @carton/store-sqlite) ────┘
                    every version, cut, credit and conflict card of one project
                                    │
                                    │  only when a cut is shared:
                                    │  WebSocket (changes, presence) · HTTPS (media)
                                    ▼
 A host runs the sequencer (@carton/server): it checks and orders each change, and never merges
 ─ @carton/server-node (Node, node:sqlite)   or   @carton/server-cloudflare (one Durable Object per project)
 ─ media and archives in a blob store: @carton/blob-fs, @carton/blob-s3 (S3, R2, GCS, MinIO), or R2 directly
```

- **One project, one history.** Each project has one `carton.db`. The app, every `cb` process and every agent write
  to it. SQLite decides the order, so two writers can't overwrite each other.
- **The edit is small, media is big.** Carton versions the timeline: tracks, clips, and their settings. Media files
  are never copied into history.
- **A conflict is data.** When two edits change the same thing, one lands and the other becomes a conflict card. No
  edit is ever dropped silently.
- **Sharing is optional.** Everything above works offline, with no server. Sharing a cut hands its ordering to a host,
  and every replica keeps a full copy.
- **Every outside service is a plug-in.** The host, the blob store, the auth, the local store and the editor adapter
  each sit behind a small interface, with a conformance suite. See [INTEGRATION.md](INTEGRATION.md#swapping-backends).

## Quickstart (5 minutes)

You need Node 24 or newer and this repository. Everything runs on one machine, with no account and no server to
deploy. The scripts are short: read them in [`quickstart/`](quickstart/).

Tested on Linux with Node 24.21. Written for Mac and Windows too, but not yet run there. The commands below use a
POSIX shell (on Windows, Git Bash). In PowerShell, set `$env:CARDBOARD_ACTOR="director/chat1/turn1"` on its own line
instead of the `CARDBOARD_ACTOR=… node …` prefix, and clear it afterwards (`Remove-Item Env:CARDBOARD_ACTOR`): while
it is set, it names every later command's actor, `--as` included.

### 1. Install, and give a project a history

```sh
cd carton
npm install
mkdir -p "$HOME/carton-try" && cp -r kit/quickstart/Demo.cardboard "$HOME/carton-try"/
P="$HOME/carton-try/Demo.cardboard"
node kit/quickstart/import.ts "$P"
```
```
Imported as main@1 (head @1, history in /home/you/carton-try/Demo.cardboard/.carton/carton.db)
```

`Demo.cardboard` is a small Cardboard project: three titles, Intro, Middle and Outro. Its current state is now
version `main@1`. Running the import again changes nothing.

### 2. Two agents edit; see who did what

`edit.ts` makes one edit the way `cb` makes it. Who is acting comes from `CARDBOARD_ACTOR`, which Cardboard sets for
the Director, its turn and its subagents.

```sh
CARDBOARD_ACTOR=director/chat1/turn1 node kit/quickstart/edit.ts "$P" Intro endTime=2.5 trimEnd=2.5
CARDBOARD_ACTOR=director/chat1/turn1/sub-general-purpose-a1b2 node kit/quickstart/edit.ts "$P" Outro color=#ffcc00
npx carton --project "$P" history
npx carton --project "$P" credits Outro
```
```
director/chat1/turn1: Saved: confirmed 7b0b265c@2
director/chat1/turn1/sub-general-purpose-a1b2: Saved: confirmed 7b0b265c@3
VERSION  SAVED     BY                                       WHAT
main@3   just now  Director › general-purpose (turn turn1)  edit
main@2   just now  Director (turn turn1)                    edit
main@1   just now  Import                                   import
main@0   just now  unknown                                  root
outro: last changed by Director › general-purpose (turn turn1) (subagent general-purpose a1b2, chat chat1)
```

`npx carton` is the standalone build of the `cb` commands (`@carton/cli-mcp`). It works from inside `carton/`. In
Cardboard, the same commands are part of `cb`. Ids such as `7b0b265c` differ on your machine.

### 3. A second cut, and a fold with a conflict card

```sh
npx carton --project "$P" cut new "30s cut"
npx carton --project "$P" cut switch "30s cut"
node kit/quickstart/edit.ts "$P" Middle startTime=2.5 endTime=5 trimEnd=2.5 --as codex/tighten
npx carton --project "$P" cut switch main
node kit/quickstart/edit.ts "$P" Middle endTime=7 trimEnd=4
npx carton --project "$P" fold "30s cut" --check
```
```
New cut "30s cut" (59d9b345)
Now on "30s cut"
codex/tighten: Saved: confirmed 59d9b345@1
Now on "Main cut"
terminal:you@your-machine: Saved: confirmed 7b0b265c@4
Would fold in with 1 card:
  #1 timelineItems/middle/#time (group: same kind or incompatible) — Main cut: {"startTime":3,"endTime":7,"trimStart":0,"trimEnd":4} · 30s cut: {"startTime":2.5,"endTime":5,"trimStart":0,"trimEnd":2.5}
Decide with `cb fold <project> '30s cut' --keep mine` (keep Main cut's) or `--keep theirs` (keep 30s cut's), or keep a clip out with `--reject timelineItems/middle`.
```

Both cuts retimed Middle. A clip's start, end, trims and speed are decided together, so Carton raises one card for
them and never mixes half of one edit with half of the other. `--check` saved nothing. Decide, then look at the
result:

```sh
npx carton --project "$P" fold "30s cut" --keep theirs
npx carton --project "$P" compare main@4
```
```
Folded in: confirmed 7b0b265c@5
- Retimed 'Middle' 3.0 s–7.0 s → 2.5 s–5.0 s
```

### 4. Undo a whole agent turn

```sh
npx carton --project "$P" undo --turn turn1
npx carton --project "$P" compare main@5 main@6
```
```
Undid turn turn1: confirmed 7b0b265c@6
- Trimmed 'Intro' end 2.5 s → 3.0 s
- Changed 'Outro' color "#ffcc00" → "#f3eee6"
```

The Director's edit and its subagent's edit came back out as one change. Your own edit and the fold stayed.

### 5. Work with a teammate through a `.cbproj` file

No server is needed. Alice exports, Bob opens it, both keep editing, and Alice brings Bob's changes back in.

```sh
mkdir -p "$HOME/carton-try/bob"
node kit/quickstart/cbproj.ts export "$P" "$HOME/carton-try/demo.cbproj"
node kit/quickstart/cbproj.ts open "$HOME/carton-try/demo.cbproj" "$HOME/carton-try/bob/Demo.cardboard"
B="$HOME/carton-try/bob/Demo.cardboard"
node kit/quickstart/edit.ts "$B" Outro color=#ff0000 --as bob
node kit/quickstart/edit.ts "$B" Middle endTime=6 trimEnd=3.5 --as bob
node kit/quickstart/edit.ts "$P" Middle endTime=7 trimEnd=4.5 --as alice
node kit/quickstart/cbproj.ts export "$B" "$HOME/carton-try/bob.cbproj"
node kit/quickstart/cbproj.ts bring-in "$P" "$HOME/carton-try/bob.cbproj" --check
node kit/quickstart/cbproj.ts bring-in "$P" "$HOME/carton-try/bob.cbproj" --keep mine
```
```
Wrote /home/you/carton-try/demo.cbproj: 2 entries (.carton-export/shallow.json)
Opened demo-project with their history; you are on "Main cut"
bob: Saved: confirmed e9b0aa5f@1
bob: Saved: confirmed e9b0aa5f@2
alice: Saved: confirmed 7b0b265c@7
Wrote /home/you/carton-try/bob.cbproj: 2 entries (.carton-export/shallow.json)
Would bring in their changes: conflicts, 1 card(s): timelineItems/middle/#time
Brought in their changes: confirmed
```

Bob's new Outro colour came in. Both retimed Middle, so that became a card, and `--keep mine` kept Alice's timing.
The file is Cardboard's own `.cbproj` zip with one extra entry. It never contains `.carton/` or the agents' view files.

### 6. Live: a host on localhost, two people on one cut

Start a host in a second terminal, from the repository's root. It is the same sequencer that runs in a Cloudflare
Durable Object, here on `node:sqlite`:

```sh
cd carton && node kit/quickstart/host.ts "$HOME/carton-try/host"
```
```
Carton host on http://127.0.0.1:8787 (projects connect to ws://127.0.0.1:8787/api/projects/<project id>/ws)
```

Back in the first terminal:

```sh
node kit/quickstart/live.ts "$P" "$HOME/carton-try/host"
```
```
Alice shared "Main cut": Up to date
Bob joined: Up to date
Alice's edit: confirmed, Bob's edit: confirmed
Alice sees Bob's outro: "Bye"; Bob sees Alice's intro: "Hello"
Bob offline: pending (Offline: 1 edit waiting)
Bob back online: Up to date; Alice sees his edit
History on Alice's side: @… Bob, @… Bob, @… Alice
```

Alice shares her cut, so the host orders its changes from now on. Bob joins with an editor invite and a copy of the
history (what a `.cbproj` saved with "Include history" carries). They edit at once, each sees the other's edit, and
Bob's offline edit waits and then syncs. Stop the host with Ctrl+C. Sharing moved Main cut to the host, so start
again from step 1 in a fresh folder to try the earlier steps once more.

### Check that it all still works

From `carton/`:

```sh
node --test kit/test/quickstart.test.ts     # runs steps 1–6 as separate processes in a scratch folder
npx tsc -p kit                              # type-checks the quickstart scripts
```

Next: [INTEGRATION.md](INTEGRATION.md) to wire Carton into Cardboard, or [INJECT.md](INJECT.md) to have your agent do
it.
