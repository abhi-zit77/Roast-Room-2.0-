# Roast Room 2.0

Roast Room convenes simulated business advisors around a decision. Codex runs the Chair and each advisor. The local room shows the debate as it happens and saves the recommendation, strongest dissent, and cheapest experiment. It can cite permitted YouTube captions with timestamp links.

This adaptation starts from the [pinned Roast Room release](https://github.com/nateherkai/roast-room/tree/e40f40652d5690c4d9f928c4794c673a99f2cd0e). It retains the room, portraits, twelve advisor profiles, example replays, and the original [MIT notice](LICENSE). Advisor responses are simulations inspired by public work.

## Windows setup

Install Node.js 24+ and Codex CLI 0.144.1 or later, then run these commands from the repository in PowerShell.

```powershell
codex login status
npm.cmd ci
npm.cmd start
```

If Codex is signed out, run `codex login`. Open [the local room](http://127.0.0.1:4730), enter an idea and any facts that might change the decision, and select **Convene the council**. Full mode chooses five to seven relevant advisors. Quick mode seats four. Use the advisor picker to name seats explicitly. A full manual board supports two to nine advisors.

For a demo that uses no model calls, run `npm.cmd run demo` in a second terminal and replay **Synthetic demo** under **Past sessions**. Use `npm.cmd run demo -- full` to see a draft vote and dissent.

Optional settings are in [.env.example](.env.example). On Windows, the runner locates a native `codex.exe` on PATH or in the standard npm installation. Set `CODEX_BIN` to a native executable elsewhere. `CODEX_MODEL` defaults to `gpt-6.2-sol` and must be available to the signed-in account. The room uses Codex account access and model usage limits.

## Run from Codex chat

Start the viewer in one PowerShell window.

```powershell
$env:COUNCIL_RUNNER = 'viewer'
npm.cmd start
```

Open the repo in Codex and submit a prompt like this.

```text
$roast-room
Should I sell a manual pilot for the customer portal, build the full product now,
or keep the current workflow? Use quick mode. My cap is $200 and four hours,
and success is one paid pilot in two weeks.
```

The skill uses the same Node protocol as the browser. Codex or the open viewer can receive any clarification question. Both show the same session as it progresses. Reopening the browser or the same session URL resumes playback.

To run directly from PowerShell, pipe a JSON object with `idea`, optional `context`, `mode`, and optional `seats` into `node app/roast-room.mjs run`. It prints a session ID immediately. Run `node app/roast-room.mjs help` for `status`, `answer`, `cancel`, and `show` commands. `answer` takes the reply on stdin.

## Add YouTube evidence

API Anything supplies public metadata and approved-channel discovery. Set `ROAST_API_ANYTHING_CLI` to the absolute path to the installed CLI’s `dist/cli.js` entry point. If you installed it with npm globally, use the path under the directory returned by `npm.cmd root -g`.

```powershell
node app/roast-room.mjs evidence approve musk '@wef'
node app/roast-room.mjs evidence discover musk '@wef'
```

The example channel is the World Economic Forum. Approve individual interview videos and verify the part where the assigned advisor is speaking before importing their words.

Use a local `.vtt` or `.srt` you have permission to retain. To obtain a permitted caption track with `yt-dlp`, install [yt-dlp](https://github.com/yt-dlp/yt-dlp) on PATH or set `ROAST_YT_DLP` to its executable, then pipe `{ "videoUrl": "…", "rightsBasis": "…", "language": "en" }` to `node app/roast-room.mjs evidence fetch`. Include `"automatic": true` to request an automatic track. This saves captions only, under `.roast-room/transcripts/`.

Import the resulting file after checking the speaker range. These example values correspond to the WEF interview used in the acceptance test. Read back the actual `file` and `transcriptKind` from your fetch result.

```powershell
$caption = @{
  file = 'C:\path\to\your-caption.vtt'
  videoUrl = 'https://www.youtube.com/watch?v=IgifEgm1-e0'
  advisor = 'Elon Musk'
  rightsBasis = 'World Economic Forum, Creative Commons Attribution 4.0'
  transcriptKind = 'automatic'
  speakerRanges = @(@{
    startSeconds = 1015.8
    endSeconds = 1020.47
    speaker = 'Elon Musk'
    verifiedAgainst = 'https://www.weforum.org/podcasts/meet-the-leader/conversation-with-elon-musk-davos-2026'
  })
}
$caption | ConvertTo-Json -Depth 5 -Compress | node app/roast-room.mjs evidence import
```

SQLite searches the imported passages before openings and freezes the selected evidence. Only exact text in a verified speaker range can be attributed as an advisor quote. The room displays transcript and metadata gaps and identifies use of stored frameworks. [YouTube caption access requirements](https://developers.google.com/youtube/data/reference/rest/v3/captions/download) · [WEF interview license record](https://commons.wikimedia.org/wiki/File:Conversation_with_Elon_Musk_-_World_Economic_Forum_Annual_Meeting_2026.webm)

Pipe a reason into `node app/roast-room.mjs evidence withdraw <source-id>` to exclude that video from future retrieval and flag past citations. `evidence list` shows source IDs. `advisor-refresh <advisor>` takes reviewed framework text and optional source IDs on stdin and saves a new profile version. `outcome <session-id>` takes an experiment observation on stdin and pins it to the original decision hash.

## What is saved

The server listens only on `127.0.0.1`, checks the submitting origin, and allows one active council across the browser and CLI. Each Codex job receives its own stdin brief and structured schema. It runs with a read-only permission setting and no execution environment, shell, MCP, search, or plugins. The installed CLI exposes an internal checklist. The runner rejects jobs that emit a tool event.

The local `.roast-room/` directory holds private sessions, advisor revisions, caption files, and the SQLite index. Leave that directory out of Git. A round appears after all seated advisors’ cards validate. Cancellation or interruption keeps completed rounds. A finished session’s `decision.json` drives the room, Markdown and PDF. Draft hashes identify what was voted on, and withdrawal annotations apply when a historical report is opened.

## Validation

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run smoke
npm.cmd run smoke -- --live
```

Browser smoke uses installed Chrome and a local server. Set `CHROME_PATH` for a different Chromium executable. The regular smoke run uses synthetic cards and checks the browser, reconnect, report parity, withdrawal, cancellation, and mobile replay. `--live` uses production Codex CLI settings with a fictional decision.
