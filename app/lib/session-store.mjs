// @ts-check
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class RoomError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.safe = true;
  }
}

const SESSION_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f\d]{12}$/;
const versionId = () => `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(6).toString("hex")}`;

export function atomicText(file, text) {
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600, flag: "wx", flush: true });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function atomicJson(file, value) {
  atomicText(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function markWithdrawals(value, withdrawals) {
  if (Array.isArray(value)) return value.map((item) => markWithdrawals(item, withdrawals));
  if (!value || typeof value !== "object") return value;
  const marked = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, markWithdrawals(item, withdrawals)]));
  if (value.sourceId && Object.hasOwn(withdrawals, value.sourceId)) {
    marked.withdrawn = true;
    marked.withdrawal = withdrawals[value.sourceId];
  }
  return marked;
}

export function createSessionStore(dataDir, { renderMarkdown, getWithdrawals = () => ({}) }) {
  const dir = path.join(dataDir, "sessions");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, "coordinator.sqlite"));
  db.exec(`PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS active (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      id TEXT NOT NULL, pid INTEGER NOT NULL, answer TEXT, cancelled INTEGER NOT NULL DEFAULT 0
    )`);

  function sessionFile(id, name) {
    if (!SESSION_ID.test(id)) throw new RoomError(404, "Session not found.");
    return path.join(dir, id, name);
  }
  const state = (id) => SESSION_ID.test(id) ? readJson(sessionFile(id, "state.json")) : null;
  const savedDecision = (id) => readJson(sessionFile(id, "decision.json"));
  const current = () => db.prepare("SELECT id, pid, answer, cancelled FROM active WHERE singleton = 1").get();
  const release = (id) => db.prepare("DELETE FROM active WHERE id = ?").run(id);

  function transact(callback) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function saveEvents(session, type, data) {
    const t = Date.now() - Date.parse(session.startedAt);
    let events;
    if (type === "round_done") {
      const { cards, ...summary } = data;
      events = [...cards.map((card) => ({ ...card, type: "seat_done", t })), { ...summary, type, t }];
    } else {
      events = [{ ...data, type, t }];
    }
    if (type === "setup") session.title = data.title;
    if (type === "clarification") session.awaiting = true;
    if (type === "clarification_answered") session.awaiting = false;
    session.events.push(...events);
    atomicJson(sessionFile(session.id, "state.json"), session);
    return events;
  }

  function end(session, status, message, decision) {
    const t = Date.now() - Date.parse(session.startedAt);
    session.status = status;
    session.awaiting = false;
    if (decision) {
      session.title = decision.title;
      session.events.push({ type: "verdict", t });
    }
    session.events.push({ type: "status", status, message, t }, { type: "end", t });
    atomicJson(sessionFile(session.id, "state.json"), session);
    release(session.id);
  }

  function recover(row) {
    const session = state(row.id);
    if (!session || session.status !== "running") return release(row.id);
    const decision = savedDecision(row.id);
    if (decision) {
      atomicText(sessionFile(row.id, "verdict.md"), renderMarkdown(markWithdrawals(decision, getWithdrawals())));
      end(session, "done", "Decision saved.", decision);
    } else {
      end(session, "incomplete", "The council process exited. Completed rounds are available.");
    }
  }

  function activeId() {
    const row = current();
    if (!row) return null;
    if (processAlive(row.pid)) return row.id;
    return transact(() => {
      const latest = current();
      if (!latest) return null;
      if (processAlive(latest.pid)) return latest.id;
      recover(latest);
      return null;
    });
  }

  function create(input, source) {
    return transact(() => {
      const row = current();
      if (row && processAlive(row.pid)) throw new RoomError(409, "A council is already in session.");
      if (row) recover(row);
      const id = versionId();
      const session = { id, title: input.idea, mode: input.mode, source, startedAt: new Date().toISOString(),
        status: "running", awaiting: false, events: [] };
      fs.mkdirSync(path.join(dir, id), { mode: 0o700 });
      atomicJson(sessionFile(id, "state.json"), session);
      db.prepare("INSERT INTO active(singleton, id, pid) VALUES(1, ?, ?)").run(id, process.pid);
      return session;
    });
  }

  function append(id, type, data) {
    const session = state(id);
    if (session?.status !== "running") throw new RoomError(409, "The council already ended.");
    return saveEvents(session, type, data);
  }

  function answer(id, value) {
    if (typeof value !== "string" || !value.trim() || value.length > 8000) {
      throw new RoomError(400, "Enter a clarification answer of up to 8,000 characters.");
    }
    if (!state(id)?.awaiting) throw new RoomError(409, "There is no open clarification for this council.");
    const updated = db.prepare("UPDATE active SET answer = ? WHERE id = ? AND answer IS NULL AND cancelled = 0").run(value.trim(), id);
    if (updated.changes !== 1) throw new RoomError(409, "The clarification was already answered or closed.");
  }

  function cancel(id) {
    if (!state(id)) throw new RoomError(404, "Session not found.");
    const updated = db.prepare("UPDATE active SET cancelled = 1 WHERE id = ?").run(id);
    if (updated.changes !== 1) throw new RoomError(409, "The council already ended.");
  }

  function controls(id) {
    const row = db.prepare("SELECT answer, cancelled FROM active WHERE id = ?").get(id);
    return { answer: row?.answer ?? null, cancelled: Boolean(row?.cancelled) };
  }

  function finish(id, decision) {
    return transact(() => {
      const session = state(id);
      if (session?.status !== "running") throw new RoomError(409, "The council already ended.");
      if (controls(id).cancelled) return end(session, "cancelled", "Council cancelled. Completed rounds are available.");
      const canonical = { ...decision, id, source: session.source, startedAt: session.startedAt, completedAt: new Date().toISOString() };
      const markdown = renderMarkdown(markWithdrawals(canonical, getWithdrawals()));
      atomicJson(sessionFile(id, "decision.json"), canonical);
      atomicText(sessionFile(id, "verdict.md"), markdown);
      end(session, "done", "Decision saved.", canonical);
    });
  }

  function stop(id, status, message) {
    const session = state(id);
    if (session?.status === "running") end(session, status, message);
  }

  function decision(id) {
    if (state(id)?.status !== "done") return null;
    const value = savedDecision(id);
    return value && markWithdrawals(value, getWithdrawals());
  }

  function get(id, afterEvent = 0) {
    const initial = state(id);
    if (!initial) return null;
    const session = initial.status === "running" && activeId() !== id ? state(id) : initial;
    const { events, ...summary } = session;
    const withdrawals = getWithdrawals();
    const canonical = session.status === "done" ? markWithdrawals(savedDecision(id), withdrawals) : undefined;
    return { ...summary, decision: canonical, eventCount: events.length, events: events.slice(afterEvent).map((event) =>
      event.type === "verdict" ? { ...event, decision: canonical } : markWithdrawals(event, withdrawals)) };
  }

  function list() {
    activeId();
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && SESSION_ID.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name)).map((entry) => state(entry.name)).filter(Boolean)
      .map(({ id, title, mode, source, status }) => ({ id, title, mode, source, status }));
  }

  function report(id) {
    const canonical = decision(id);
    return canonical && renderMarkdown(canonical);
  }

  function refreshReports(sourceId) {
    for (const { id, status } of list()) {
      if (status !== "done") continue;
      const canonical = decision(id);
      if (Object.values(canonical?.evidence ?? {}).some((packet) => packet.passages?.some((passage) => passage.sourceId === sourceId))) {
        atomicText(sessionFile(id, "verdict.md"), renderMarkdown(canonical));
      }
    }
  }

  function recordOutcome(id, observation) {
    if (typeof observation !== "string" || !observation.trim() || observation.length > 12_000) {
      throw new RoomError(400, "Enter the observed outcome in up to 12,000 characters.");
    }
    if (state(id)?.status !== "done") throw new RoomError(404, "The completed decision was not found.");
    const decisionHash = createHash("sha256").update(fs.readFileSync(sessionFile(id, "decision.json"))).digest("hex");
    const outcomes = sessionFile(id, "outcomes");
    fs.mkdirSync(outcomes, { recursive: true, mode: 0o700 });
    const version = versionId();
    const entry = { id, version, decisionHash, recordedAt: new Date().toISOString(), observation: observation.trim() };
    atomicJson(path.join(outcomes, `${version}.json`), entry);
    return entry;
  }

  return { activeId, create, get, list, append, answer, cancel, controls, finish, stop, report, refreshReports, recordOutcome,
    close: () => db.close() };
}
