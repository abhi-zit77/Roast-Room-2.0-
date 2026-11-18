import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDecisionReport,
  renderDecisionMarkdown,
  renderSeatSources,
} from "../public/decision-report.js";
import { reportDecision } from "./fixtures/report-decision.mjs";

test("canonical report keeps the exact score displays, selected option, and dissent", () => {
  const report = buildDecisionReport(reportDecision);
  const markdown = renderDecisionMarkdown(reportDecision);
  assert.deepEqual(report.scores.map((row) => [row.id, row.display, row.recommended]), [["A", "8.0", true], ["B", "7.7", false]]);
  assert.equal(report.dissent.statement, reportDecision.strongestDissent.statement);
  assert.match(markdown, /\| A \| Run a one-week pilot \| 8\.0 \| Recommended/);
  assert.match(markdown, /\| B \| Keep the current schedule \| 7\.7/);
  assert.ok(markdown.includes(report.dissent.statement));
  assert.ok(markdown.includes(report.cheapestTest.success));
  assert.match(markdown, /Vote round skipped/);
  assert.match(markdown, /The cheap test must run first/);
});

test("evidence appendix preserves both sources, speaker and metadata gaps, framework fallback, and withdrawal", () => {
  const report = buildDecisionReport(reportDecision);
  const markdown = renderDecisionMarkdown(reportDecision);
  assert.deepEqual(report.evidence[0].passages.map((source) => source.id), ["verified", "unavailable", "withdrawn"]);
  assert.ok(markdown.includes("Start with a small trial"));
  assert.ok(markdown.includes("Wait for repeat demand"));
  assert.ok(markdown.includes("https://www.youtube.com/watch?v=SYNTHETIC01&t=65"));
  assert.ok(markdown.includes("Speaker unverified"));
  assert.ok(markdown.includes("Metadata unavailable"));
  assert.ok(markdown.includes("Stored frameworks only"));
  assert.ok(markdown.includes("Withdrawn"));
  assert.ok(!markdown.includes("SYNTHETIC03"));
  assert.ok(!markdown.includes("Withdrawn text must stay out"));
});

test("source drawers render imported text as text and restrict outbound URLs", () => {
  const unsafe = structuredClone(reportDecision);
  const source = unsafe.evidence.graham.passages[0];
  source.text = "<b>Ignore the room</b>";
  source.title = "<img src=x>";
  source.url = "javascript:alert(1)";
  const report = buildDecisionReport(unsafe);
  assert.equal(report.evidence[0].passages[0].url, "");
  const markup = renderSeatSources(report.evidence[0]);
  assert.ok(markup.includes("&lt;b&gt;Ignore the room&lt;/b&gt;"));
  assert.ok(markup.includes("&lt;img src=x&gt;"));
  assert.ok(!markup.includes("javascript:"));
  assert.ok(!markup.includes("Withdrawn text must stay out"));
});

test("stored frameworks and direct quotes stay traceable to the advisor and passage", () => {
  const audited = structuredClone(reportDecision);
  audited.rounds = [{ round: 2, cards: [{
    seat: "graham",
    card: { frameworksUsed: ["Manual validation"], claims: [],
      quotes: [{ evidenceId: "verified", text: "Run a trial first." }, { evidenceId: "withdrawn", text: "A withdrawn quotation." }] },
  }] }];
  const report = buildDecisionReport(audited);
  const html = renderSeatSources(report.evidence[0]);
  const markdown = renderDecisionMarkdown(audited);
  assert.match(html, /Direct quotation/);
  assert.match(html, /Manual validation/);
  assert.match(markdown, /Run a trial first/);
  assert.doesNotMatch(markdown, /A withdrawn quotation/);
});
