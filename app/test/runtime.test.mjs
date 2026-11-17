import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexArguments, codexEnvironment, readCodexResult } from "../lib/codex-runner.mjs";
import { createSessionStore } from "../lib/session-store.mjs";

const input = { idea: "Run a local synthetic decision", context: "", mode: "quick" };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roast-room-test-"));
  const settings = { renderMarkdown: (decision) => `Dissent: ${decision.strongestDissent.statement}\n` };
  const writer = createSessionStore(dir, settings);
  const viewer = createSessionStore(dir, settings);
  t.after(() => {
    writer.close();
    viewer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, writer, viewer };
}

test("Codex gets a fresh no-environment, read-only, stdin-only structured run", () => {
  const cwd = path.resolve(os.tmpdir(), "empty room");
  const args = codexArguments({ cwd, schemaPath: path.join(cwd, "schema.json"), model: "test-model" });
  assert.equal(args.at(-1), "-");
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--output-schema", "read-only", "shell_tool", "plugins"]) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  const env = codexEnvironment(cwd, { Path: "path", OPENAI_BASE_URL: "untrusted", CODEX_EXEC_SERVER_URL: "untrusted" });
  assert.equal(env.CODEX_EXEC_SERVER_URL, "none");
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.CODEX_SQLITE_HOME, cwd);
});

test("rejects tool events even if a structured final answer follows", () => {
  const goal = { type: "item.completed", item: { type: "agent_message", text: '{"ok":true}' } };
  const finished = { type: "turn.completed" };
  assert.deepEqual(readCodexResult([goal, finished]), { ok: true });
  assert.throws(() => readCodexResult([{ type: "item.updated", item: { type: "todo_list" } }, goal, finished]), /tool/i);
  assert.throws(() => readCodexResult([goal]), /complete/i);
});

test("one active council across writer and viewer with single clarification submission", (t) => {
  const { writer, viewer } = fixture(t);
  const { id } = writer.create(input, "codex");
  assert.equal(viewer.activeId(), id);
  assert.throws(() => viewer.create(input, "browser"), /already/i);
  writer.append(id, "clarification", { questions: ["What would success look like?"] });
  viewer.answer(id, "One signed pilot.");
  assert.equal(writer.controls(id).answer, "One signed pilot.");
  assert.throws(() => viewer.answer(id, "A second reply"), /already/i);
  viewer.cancel(id);
  assert.equal(writer.controls(id).cancelled, true);
});

test("complete rounds and reconnectable terminal journal survive interruption", (t) => {
  const { writer, viewer } = fixture(t);
  const { id } = writer.create(input, "browser");
  writer.append(id, "round_done", { round: 1, scores: {}, cards: [{ seat: "graham" }, { seat: "buffett" }] });
  writer.stop(id, "cancelled", "Cancelled locally.");
  assert.equal(viewer.activeId(), null);
  const archive = viewer.get(id);
  assert.equal(archive.status, "cancelled");
  assert.deepEqual(archive.events.map((event) => event.type), ["seat_done", "seat_done", "round_done", "status", "end"]);
  assert.equal(archive.events[0].seat, "graham");
  assert.equal(archive.decision, undefined);
});

test("the verdict event and export are loaded from the persisted canonical decision", (t) => {
  const { dir, writer, viewer } = fixture(t);
  const { id } = writer.create(input, "demo");
  writer.finish(id, { title: "Signed pilot", strongestDissent: { statement: "Measure unpaid setup time." } });
  const archive = viewer.get(id);
  const decision = JSON.parse(fs.readFileSync(path.join(dir, "sessions", id, "decision.json"), "utf8"));
  assert.deepEqual(archive.events.find((event) => event.type === "verdict").decision, decision);
  assert.match(viewer.report(id), /Measure unpaid setup time\./);
});

test("viewer recovers the last complete round if the writer process exits", (t) => {
  const { dir, viewer } = fixture(t);
  const child = spawnSync(process.execPath, ["--input-type=module", "-"], {
    encoding: "utf8",
    input: `import { createSessionStore } from ${JSON.stringify(new URL("../lib/session-store.mjs", import.meta.url).href)};
const writer = createSessionStore(${JSON.stringify(dir)}, { renderMarkdown() { return ""; } });
const { id } = writer.create(${JSON.stringify(input)}, "codex");
writer.append(id, "round_done", { round: 1, scores: {}, cards: [{ seat: "graham" }] });
console.log(id);`,
  });
  assert.equal(child.status, 0, child.stderr);
  const record = viewer.get(child.stdout.trim());
  assert.equal(record.status, "incomplete");
  assert.equal(record.events.find((event) => event.type === "round_done").round, 1);
  assert.equal(viewer.activeId(), null);
});

test("experiment observations keep distinct versions and the original decision hash", (t) => {
  const { dir, writer } = fixture(t);
  const { id } = writer.create(input, "demo");
  writer.finish(id, { title: "Signed pilot", strongestDissent: { statement: "Measure unpaid setup time." } });
  const decision = path.join(dir, "sessions", id, "decision.json");
  const before = fs.readFileSync(decision, "utf8");
  const first = writer.recordOutcome(id, "One invitation sent.");
  const second = writer.recordOutcome(id, "One invitation accepted.");
  assert.notEqual(first.version, second.version);
  assert.equal(first.decisionHash, second.decisionHash);
  assert.equal(fs.readFileSync(decision, "utf8"), before);
});
