import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCodexRunner } from "./codex-runner.mjs";
import { APP_ROOT, BRAINS_DIR, REPO_ROOT, env } from "./env.mjs";
import { createEvidenceStore } from "./evidence.mjs";
import { createApiAnythingMetadata } from "./evidence-metadata.mjs";
import { normalizeSubmission, runCouncil } from "./protocol.mjs";
import { loadRoster } from "./seats.mjs";
import { atomicJson, readJson, RoomError, createSessionStore } from "./session-store.mjs";
import { renderDecisionMarkdown } from "../public/decision-report.js";

const UPSTREAM = "e40f40652d5690c4d9f928c4794c673a99f2cd0e";
const profileDigest = (profile) => createHash("sha256").update(JSON.stringify(profile)).digest("hex");
const repoText = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim() : "";

export function advisorFor(label, roster = loadRoster()) {
  const alias = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const advisor = typeof label === "string" && roster.find((seat) =>
    [seat.key, seat.name, seat.short].some((value) => value && alias(value) === alias(label)));
  if (!advisor) throw new RoomError(400, "Choose an advisor from the room roster.");
  return advisor;
}

function dataPath(directory) {
  const candidate = path.resolve(REPO_ROOT, directory || env("COUNCIL_DATA_DIR") || ".roast-room");
  const publicDir = fs.realpathSync(path.join(APP_ROOT, "public"));
  // Resolve the nearest existing ancestor too, so a configured symlink cannot place private data under the static root.
  let ancestor = candidate;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actual = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, candidate));
  const relative = path.relative(publicDir, actual);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new RoomError(400, "Choose a private data directory outside the browser assets.");
  }
  const checkout = path.relative(fs.realpathSync(REPO_ROOT), actual);
  const inside = !checkout.startsWith(`..${path.sep}`) && checkout !== ".." && !path.isAbsolute(checkout);
  if (inside && checkout.split(path.sep)[0] !== ".roast-room") {
    throw new RoomError(400, "Store council data under .roast-room or outside the Git checkout.");
  }
  return actual;
}

function profileStore(directory, evidence) {
  function get(key) {
    const seat = advisorFor(key);
    const local = path.join(directory, key);
    const current = readJson(path.join(local, "current.json"));
    const roleFile = repoText(path.join(REPO_ROOT, ".codex", "agents", `council-${key}.toml`));
    const role = roleFile.match(/developer_instructions\s*=\s*'''([\s\S]+?)'''/)?.[1].trim() || seat.question;
    const baseline = path.join(BRAINS_DIR, seat.slug);
    const custom = current && /^[a-f\d]{64}$/.test(current.version) && readJson(path.join(local, `${current.version}.json`));
    const withdrawals = custom?.sourceIds?.length ? evidence.getWithdrawals() : {};
    const eligible = custom && !(custom.sourceIds ?? []).some((id) => Object.hasOwn(withdrawals, id));
    const snapshot = { name: seat.name, dimension: seat.dimension, lens: role,
      profile: eligible && custom.profile || repoText(path.join(baseline, "_hot.md")).slice(0, 5200),
      frameworks: eligible ? custom.frameworks : repoText(path.join(baseline, "frameworks.md")).slice(0, 9200),
      sourceIds: eligible ? custom.sourceIds : [],
      baseline: UPSTREAM,
    };
    return { ...snapshot, version: profileDigest(snapshot), localVersion: eligible ? current.version : null };
  }

  function refresh(key, value) {
    const { frameworks, profile = "", note = "", sourceIds = [] } = value ?? {};
    if (typeof frameworks !== "string" || !frameworks.trim() || frameworks.length > 9200 ||
        typeof profile !== "string" || profile.length > 5200 || typeof note !== "string" || note.length > 1000 ||
        !Array.isArray(sourceIds) || sourceIds.length > 20 || sourceIds.some((id) => typeof id !== "string")) {
      throw new RoomError(400, "Provide reviewed frameworks and optional profile, note, and imported source IDs.");
    }
    const eligible = new Set(evidence.listSources(key).filter((source) => !source.withdrawnAt).map((source) => source.sourceId));
    if (sourceIds.some((id) => !eligible.has(id))) throw new RoomError(400, "Use current imported sources assigned to that advisor.");
    const local = path.join(directory, key);
    fs.mkdirSync(local, { recursive: true, mode: 0o700 });
    const update = { frameworks: frameworks.trim(), profile: profile.trim(), note: note.trim(), sourceIds: [...new Set(sourceIds)] };
    const version = profileDigest(update);
    const file = path.join(local, `${version}.json`);
    if (!fs.existsSync(file)) atomicJson(file, { ...update, version, refreshedAt: new Date().toISOString() });
    atomicJson(path.join(local, "current.json"), { version });
    return { advisor: key, version };
  }
  return { get, refresh };
}

/** @param {{dataDir?: string, generate?: ReturnType<typeof createCodexRunner>["generate"], clarificationMs?: number, evidenceEnabled?: boolean}} [settings] */
export function createCodexRoom({ dataDir, generate, clarificationMs = 600_000, evidenceEnabled = true } = {}) {
  const directory = dataPath(dataDir);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const evidence = createEvidenceStore(path.join(directory, "evidence.sqlite"), {
    metadata: createApiAnythingMetadata({ cli: env("ROAST_API_ANYTHING_CLI") }),
  });
  const store = createSessionStore(directory, { renderMarkdown: renderDecisionMarkdown, getWithdrawals: evidence.getWithdrawals });
  const profiles = profileStore(path.join(directory, "advisors"), evidence);
  const codex = createCodexRunner({ executable: env("CODEX_BIN"), model: env("CODEX_MODEL") || undefined });
  let pending = null;

  function start(submission, { source = "browser", onEvent = () => {} } = {}) {
    const roster = loadRoster().map((seat) => ({ ...seat }));
    const input = normalizeSubmission(submission, roster);
    const { id } = store.create(input, source);
    const controller = new AbortController();
    const { signal } = controller;
    const aborted = () => { if (store.controls(id).cancelled) controller.abort(); };
    const publish = (type, data) => { store.append(id, type, data); onEvent(type, data); };
    const ask = async ({ questions }) => {
      publish("clarification", { questions });
      const expires = Date.now() + clarificationMs;
      let answer = null;
      while (Date.now() < expires && answer === null) {
        await delay(200, undefined, { signal });
        answer = store.controls(id).answer;
      }
      publish("clarification_answered", { timedOut: answer === null });
      return answer ?? "";
    };

    const completion = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      const controls = setInterval(aborted, 200);
      try {
        aborted();
        signal.throwIfAborted();
        const runtime = generate ? { provider: "synthetic" } : codex.runtime();
        const decision = await runCouncil({ input, roster, publish, ask, signal, getProfile: profiles.get,
          getEvidence: evidenceEnabled ? evidence.getEvidence : () => ({ status: "framework_only", gaps: ["Synthetic demo uses stored frameworks."], passages: [] }),
          generate: generate ?? codex.generate,
        });
        store.finish(id, { ...decision, runtime, upstreamRevision: UPSTREAM });
      } catch (error) {
        const cancelled = signal.aborted;
        const message = cancelled ? "Council cancelled. Completed rounds are available." :
          (error.safe ? error.message : "The council could not complete. Completed rounds are available.");
        store.stop(id, cancelled ? "cancelled" : "incomplete", message);
      } finally {
        clearInterval(controls);
        pending = null;
      }
      return store.get(id);
    })();
    pending = { controller, completion };
    return { id, completion };
  }

  async function close() {
    const unfinished = pending;
    if (unfinished) {
      unfinished.controller.abort();
      await unfinished.completion;
    }
    store.close();
    evidence.close();
  }

  return { store, evidence, profiles, directory, start, close };
}
