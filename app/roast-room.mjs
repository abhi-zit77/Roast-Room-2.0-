import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { advisorFor, createCodexRoom } from "./lib/codex-room.mjs";
import { createSyntheticGenerator } from "./lib/council-synthetic.mjs";
import { fetchYouTubeCaptions } from "./lib/evidence-download.mjs";
import { env } from "./lib/env.mjs";
import { RoomError } from "./lib/session-store.mjs";

const output = (value) => console.log(JSON.stringify(value));
const usage = `Roast Room local commands
  run                         Read {idea, context, mode, seats} from stdin and run a Codex council.
  status [session-id]         Show recent sessions or the status of a single council.
  answer <session-id>         Read a clarification answer from stdin.
  cancel <session-id>         Stop the active council.
  show <session-id>           Print the completed Markdown report.
  demo [quick|full]           Save a synthetic session for the room to replay.
  outcome <session-id>       Read and save an experiment observation from stdin.
  advisor-refresh <advisor>   Read reviewed {frameworks, profile?, sourceIds?, note?} from stdin.
  evidence import             Read {file, videoUrl, advisor, rightsBasis, speakerRanges, language?, transcriptKind?} from stdin.
  evidence fetch              Read {videoUrl, rightsBasis, language?, automatic?} from stdin and save captions with yt-dlp.
  evidence approve <advisor> <handle>
  evidence discover <advisor> <handle>
  evidence list [advisor]
  evidence withdraw <source-id>    Read the withdrawal reason from stdin.`;

async function stdin(asJson = false) {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 65_536) throw new RoomError(413, "Input exceeds the local command limit.");
  }
  value = value.replace(/^\uFEFF/, "").trim();
  if (!asJson) return value;
  try {
    const data = JSON.parse(value);
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error("expected object");
    return data;
  } catch { throw new RoomError(400, "Pipe a JSON object into this command."); }
}

async function run(room, input, source) {
  const { id, completion } = room.start(input, { source, onEvent(type, data) {
    if (["phase", "round_progress", "clarification", "clarification_answered"].includes(type)) output({ type, ...data });
  } });
  output({ type: "session", id });
  const cancel = () => { try { room.store.cancel(id); } catch { /* The verdict or cancellation can race with Ctrl+C. */ } };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const record = await completion;
    output({ type: "status", id, status: record.status, message: record.events.findLast((event) => event.type === "status")?.message });
    if (record.status !== "done") process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

async function maintain(room, action, args) {
  const evidence = room.evidence;
  switch (action) {
    case "list": return output(evidence.listSources(args[0] ? advisorFor(args[0]).key : undefined));
    case "approve": return output(evidence.approveChannel({ advisorId: advisorFor(args[0]).key, handle: args[1] }));
    case "discover": return output(await evidence.discoverChannel({ advisorId: advisorFor(args[0]).key, handle: args[1] }));
    case "fetch": {
      const request = await stdin(true);
      return output(await fetchYouTubeCaptions({ videoUrl: request.videoUrl, rightsBasis: request.rightsBasis,
        language: request.language, automatic: request.automatic, executable: env("ROAST_YT_DLP") || undefined,
        directory: path.join(room.directory, "transcripts") }));
    }
    case "import": {
      const request = await stdin(true);
      const advisor = advisorFor(request.advisor);
      return output(await evidence.importTranscript({ ...request, advisorId: advisor.key, advisorName: advisor.name }));
    }
    case "withdraw": {
      const withdrawal = evidence.withdrawSource(args[0], await stdin());
      for (const sourceId of Object.keys(evidence.getWithdrawals())) room.store.refreshReports(sourceId);
      return output(withdrawal);
    }
    default: throw new RoomError(400, usage);
  }
}

async function main([command, ...args]) {
  if (!command || command === "--help" || command === "help") return console.log(usage);
  const demo = command === "demo";
  const room = createCodexRoom(demo ? { generate: createSyntheticGenerator(), evidenceEnabled: false } : {});
  try {
    switch (command) {
      case "run": return await run(room, await stdin(true), "codex");
      case "demo": return await run(room, { idea: "Synthetic demo: should a fictional studio sell a pilot before building a client portal?",
        context: "Fictional founder, two hours available and no validated buyer demand.", mode: args[0] ?? "quick" }, "demo");
      case "status": {
        if (!args[0]) return output({ running: room.store.activeId(), sessions: room.store.list() });
        const record = room.store.get(args[0]);
        if (!record) throw new RoomError(404, "Session not found.");
        return output({ id: record.id, title: record.title, status: record.status, awaiting: record.awaiting,
          phase: record.events.findLast((event) => event.type === "phase")?.phase,
          questions: record.awaiting ? record.events.findLast((event) => event.type === "clarification")?.questions : undefined,
          message: record.events.findLast((event) => event.type === "status")?.message });
      }
      case "answer": room.store.answer(args[0], await stdin()); return output({ id: args[0], accepted: true });
      case "cancel": room.store.cancel(args[0]); return output({ id: args[0], cancelled: true });
      case "show": {
        const report = room.store.report(args[0]);
        if (!report) throw new RoomError(404, "No completed report is available for that session.");
        return process.stdout.write(report);
      }
      case "outcome": {
        const { id, version, decisionHash } = room.store.recordOutcome(args[0], await stdin());
        return output({ id, version, decisionHash });
      }
      case "advisor-refresh": return output(room.profiles.refresh(advisorFor(args[0]).key, await stdin(true)));
      case "evidence": return await maintain(room, args[0], args.slice(1));
      default: throw new RoomError(400, usage);
    }
  } finally { await room.close(); }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.code === "ENOENT" ? "The requested local file was not found." : error.message);
    process.exitCode = 1;
  });
}
