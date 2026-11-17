import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createRoomServer } from "../server.mjs";
import { createSyntheticGenerator } from "../lib/council-synthetic.mjs";

async function room(t, runner = "codex") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roast-room-http-"));
  const server = createRoomServer({ dataDir, runner, generate: createSyntheticGenerator({ clarify: true }), legacy: false });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, origin = base) => fetch(`${base}${url}`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  });
  const read = (url) => fetch(`${base}${url}`);
  return { base, post, read };
}

const input = { idea: "Should we run a synthetic pilot before building a portal?", mode: "quick" };

async function until(read, id, match) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const record = await (await read(`/api/sessions/${id}`)).json();
    if (match(record)) return record;
    await delay(25);
  }
  assert.fail("the expected session state did not arrive");
}

test("same-origin browser submits, clarifies, and replays the same Codex-format result", async (t) => {
  const { base, post, read } = await room(t);
  const wrongOrigin = await post("/api/council", input, "https://example.com");
  assert.equal(wrongOrigin.status, 403);
  const started = await post("/api/council", input);
  assert.equal(started.status, 202);
  const { id } = await started.json();
  assert.equal((await post("/api/council", input)).status, 409);
  const pending = await until(read, id, (x) => x.awaiting);
  assert.match(pending.events.find((x) => x.type === "clarification").questions[0], /hours/);
  assert.equal((await post(`/api/council/${id}/clarification`, { answer: "Two hours per week." })).status, 202);
  const finished = await until(read, id, (x) => x.status === "done");
  assert.equal(finished.decision.id, id);
  assert.equal(finished.decision.ratificationStatus, "not_run");
  const resumed = await fetch(`${base}/api/stream/${id}`, { headers: { "Last-Event-ID": String(pending.eventCount) } });
  const sse = await resumed.text();
  assert.match(sse, /"type":"verdict"/);
  assert.match(sse, /"type":"end"/);
  assert.doesNotMatch(sse, /"type":"clarification"/);
  const report = await (await read(`/api/sessions/${id}/report.md`)).text();
  assert.ok(report.includes(finished.decision.strongestDissent.statement));
  assert.deepEqual((await (await read("/api/sessions")).json()).sessions.map((session) => session.id), [id]);
});

test("viewer mode forbids new browser submissions", async (t) => {
  const { post } = await room(t, "viewer");
  assert.equal((await post("/api/council", input)).status, 403);
});

test("same-origin cancellation closes a waiting session", async (t) => {
  const { post, read } = await room(t);
  const { id } = await (await post("/api/council", input)).json();
  await until(read, id, (x) => x.awaiting);
  assert.equal((await post(`/api/council/${id}/cancel`, {})).status, 202);
  const stopped = await until(read, id, (x) => x.status === "cancelled");
  assert.equal(stopped.events.at(-1).type, "end");
  assert.equal(stopped.decision, undefined);
});
