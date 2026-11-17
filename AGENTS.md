# Roast Room workspace

Use the repository’s `$roast-room` skill when the user requests a council or asks to run Roast Room. Ordinary code and research tasks use the usual workflow.

The Node runner owns the council protocol and saves its records under `.roast-room/`. Use the browser and CLI to consume its output. Keep decision sessions, downloaded captions, evidence indexes, and credentials out of Git.

Before contributing a code change, run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run smoke`.
