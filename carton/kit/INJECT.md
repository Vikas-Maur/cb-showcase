# Inject Carton: a prompt for your coding agent

Paste the block below to your coding agent (Claude Code, Codex…) in Cardboard's repository. It wires Carton in step by
step, keeps everything behind a switch, and stops at each checkpoint to show you the test results. Replace
`<path to the carton folder>` first.

```text
You are adding Carton to Cardboard. Carton is git for video plus live editing together: versions with who made them
(down to the subagent), cuts that fold back together, conflict cards instead of lost edits. It is a TypeScript
module with no runtime dependencies, in <path to the carton folder> (an npm workspace of @carton/* packages).

Read first, in this order: carton/kit/README.md (the words and the architecture), carton/kit/INTEGRATION.md (every
hook, what it changes, its invariants and its proof), carton/kit/LIMITS.md (what isn't built), and
carton/kit/CONFORMANCE.md. Keep carton/kit/SKILL.md for the agents that will edit projects afterwards.

Rules for the whole job:
- Everything goes behind one switch that main reads once at start and passes to every process it starts (call it
  CARDBOARD_CARTON). With it off, every code path is today's and the bytes written are today's. Prove that at every
  checkpoint.
- Never paste Carton's internals into Cardboard: import @carton/* packages. Never change Carton's packages; if one
  needs a change, write it down for me instead.
- Documents from Carton are values, and frozen (an edit in place throws): replace the record you change.
- No edit may ever be dropped silently. A write Carton didn't make is imported, never overwritten.
- Small commits, one hook per commit, each with its test. Stop at every CHECKPOINT and show me the commands you ran
  and their pass/fail/skip counts, exactly as printed.

Step 0. Bring Carton in.
- Add the @carton/* packages to the pnpm workspace (or vendor carton/ and list carton/packages/* in
  pnpm-workspace.yaml). Set `linkWorkspacePackages: true` there: the packages depend on each other by version.
- Node 24 runs their .ts sources directly; your bundler (esbuild, Vite) compiles them for the app.
- CHECKPOINT 0: in carton/, `npm install`, then `node --test kit/test/quickstart.test.ts` and
  `node --test kit/test/samples.test.ts` pass. Your existing test suite passes unchanged.

Step 1. The adapter: Carton's view of a project.
- Use @carton/cardboard's adapter. Give it the editor's real per-item save projection:
  `createCardboardAdapter({ projection })`. Give the materializer your timeline.tsx printer and parser as
  `{ print(project, rev), parse(text, project) }`.
- If your project.json has fields the adapter doesn't know (see the schema in packages/cardboard/src/schema.ts),
  write them down for me: don't edit the package.
- CHECKPOINT 1: copy carton/kit/conformance/engine.test.ts and cardboard.test.ts next to your tests. Point
  cardboard.test.ts at 20+ real project.json files (SAMPLES=<folder>), and add a test that a GUI save through your
  projection changes only the person's edit (INTEGRATION.md H4, samples.test.ts "H4"). All pass.

Step 2. History in the library worker and the CLI (H1, H1b, H2, H11).
- Open each project with importProject (@carton/store-sqlite): its current document becomes main@1.
- H1: each project-store mutation commits against the exact document it was applied to; writeNow's rename becomes
  displace-then-install. H2: listRevisions/readRevision read Carton's versions first. H11: .cbproj leaves out .carton/
  and .scratch/views/ (on or off).
- CHECKPOINT 2: copy carton/kit/conformance/store.test.ts and local.test.ts and run them. Your integration tests:
  4 concurrent `cb source apply` on different clips keep all 4 edits; a GUI save during an agent's apply keeps both;
  with the switch off, the files written are byte-identical to today's; a .cbproj has no .carton/ entry and none of
  the view files Carton wrote, while a person's own files in .scratch/views/ travel.

Step 3. Apply and print (H3), the library worker (H8), the commands (CLI), and agents (H9).
- Apply commits on the exact version the file's header names; a header nothing can rebuild is an error, never a
  two-way merge. In the library worker, start the engine thread and the materializer (`new Materializer(…)`,
  `mz.start()`, `mz.watch()`): it writes project.json and timeline.tsx, and prints and applies the agents' per-agent
  views live (`cb source print --view`). Pass it to the lease holder's engine, so `cb`'s view prints and hook events
  reach it. register(program, …) and registerMcp(tool, …) from @carton/cli-mcp, with the same data folder as the app.
  CARDBOARD_ACTOR for every agent the app starts; the Director's PreToolUse hook adds the turn and subagent; Stop and
  SubagentStop hooks deliver late conflicts once. Host Claude Code gets `hookSettings(…)` from @carton/local: Bash, and
  Read|Write|Edit|MultiEdit for the freeze of timeline.tsx and the refusal of a write to project.json (add Claude
  Code's `if` conditions per tool and file so other files start no process: INTEGRATION.md H9).
- CHECKPOINT 3: walk the quickstart (carton/kit/README.md steps 2–4) on a real project with `cb`: history with
  authors down to the subagent, credits, a cut, `cb fold --check`, a fold with a card decided by --keep, `cb undo
  --turn`. With the app open, an agent prints its own view, edits it, and its `.status` file says `confirmed`; while
  its turn runs, timeline.tsx doesn't show the person's edit, and does once the turn ends; an Edit of project.json is
  refused. Show me the output.

Step 4. The editor (H4–H7) and the History panel.
- The save carries its base; adopt moves the base atomically with no undo entry; ⌘Z undoes the person's actor
  group; ripples record their intents; @carton/react's panel loads only when it first shows.
- CHECKPOINT 4: your renderer tests for each point in INTEGRATION.md H4–H7, then the app by hand: edit while an agent
  edits the same project, and confirm no edit is lost and ⌘Z undoes the right thing.

Step 5 (optional). Sharing (H12, H13, the host).
- Pick a host (INTEGRATION.md "Swapping backends"): server-node, the Cloudflare host, or createSequencer inside your
  API, with your AuthProvider and BlobStore. Give the engine thread the host's URL and a token file.
- At share and at join, `carton.setIdentity({ id: <the session's account>, name })`, and pass that person as the
  History panel's `me`, so a teammate's GUI edits show under their name (INTEGRATION.md "People and presence").
- Save As with a shared cut: wait until `carton.pendingCount(cut)` is 0, or export the confirmed head.
- CHECKPOINT 5: copy carton/kit/conformance/host.test.ts, system.test.ts and blob.test.ts, swap in your host, storage,
  auth and bucket, and run them. Then two installs on one shared project: each one's GUI edit shows the other's
  name in History, and a teammate who quits drops out of presence. Show me the counts.

Finally: list everything you couldn't do, every place you had to work around Carton, and what needs a run on real
machines (gates G1 and G2 in INTEGRATION.md, "Rolling it out safely").
```

What to expect: steps 0–3 give history, cuts, folds, credits and agent undo with no server. Step 4 makes the editor
safe next to agents. Step 5 is live editing; [LIMITS.md](LIMITS.md) says what it can't do yet.
