---
name: roast-room
description: Convene Roast Room's local Codex council for an explicit business decision. Open the shared browser replay and summarize the recommendation, dissent, and cheapest experiment.
---

# Roast Room

1. Use the founder’s decision and facts to form `{ "idea": "…", "context": "…", "mode": "full", "seats": [] }`. Set `mode` to `quick` or supply advisor names only when requested. Run `node app/roast-room.mjs run` from this repository with the JSON on stdin. On Windows, pipe a PowerShell single-quoted here-string or `Get-Content -Raw` of a private local brief into Node as UTF-8. The room can run in `COUNCIL_RUNNER=viewer` while the command is active.
2. Capture the first JSON event’s `id`. Follow the same process through completion. When it emits `clarification`, ask the user those questions unless their existing context already supplies the answers. Pipe the answer into `node app/roast-room.mjs answer <id>` from a second command. `node app/roast-room.mjs status <id>` also shows open questions. Use `node app/roast-room.mjs cancel <id>` if the user asks to stop.
3. Read `node app/roast-room.mjs show <id>` after `done`. Lead with the recommendation, strongest dissent, and cheapest experiment. Give the vote status, source gaps, and session ID. If the local command fails to start, report the launch error. If the status is `incomplete` or `cancelled`, report that status and the available rounds. The viewer can replay the saved session without starting a second council.

The Node runner selects and freezes the roles, runs independent Codex jobs, validates cards, scores the complete board and writes `decision.json`. Report the recorded decision and citations verbatim where precision matters. Local transcript evidence is already scoped to each advisor by the runner.
