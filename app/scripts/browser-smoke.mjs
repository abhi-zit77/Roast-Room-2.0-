/* global window, document, innerWidth */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createSyntheticGenerator } from "../lib/council-synthetic.mjs";
import { createEvidenceStore } from "../lib/evidence.mjs";
import { createRoomServer } from "../server.mjs";

const live = process.argv.includes("--live");
const namedSeats = ["bezos", "graham", "hormozi", "buffett"];
const title = "Should the synthetic business sell a manual portal pilot?";
const contextText = "Synthetic example: two fictional prospects, zero fixed spend, and two hours for a paid pilot. Continue the current service as the baseline.";
const sourceVideo = "SYNTHETIC01";
const at = "1:05";
const caption = "A paid portal pilot would test demand from two prospects within the delivery time cap.";
const legacyReplay = "2026-10-09-example-take-the-seed";

async function openServer(options) {
  const server = createRoomServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    dropConnections: () => server.closeAllConnections(),
    async close() {
      const closing = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closing;
    },
  };
}

async function seedEvidence(directory) {
  const file = path.join(directory, "synthetic.vtt");
  await writeFile(file, `WEBVTT\n\n00:01:05.000 --> 00:01:09.000\n${caption}\n`);
  const index = evidenceIndex(directory);
  try {
    const result = await index.importTranscript({
      file, videoUrl: `https://www.youtube.com/watch?v=${sourceVideo}`,
      advisorId: "graham", advisorName: "Paul Graham", rightsBasis: "Synthetic test fixture written for this repository",
      speakerRanges: [{ startSeconds: 65, endSeconds: 70, speaker: "Paul Graham" }],
    });
    return result.sourceId;
  } finally {
    index.close();
  }
}

function evidenceIndex(directory) {
  return createEvidenceStore(path.join(directory, "evidence.sqlite"), {
    metadata: { getVideo: async () => ({ status: "not_available" }) },
  });
}

async function preparePdfCapture(page) {
  await page.addScriptTag({ url: "/vendor/jspdf.umd.min.js" });
  await page.evaluate(() => {
    const Pdf = window.jspdf.jsPDF;
    window.writtenPdfLines = [];
    window.jspdf.jsPDF = function (...options) {
      const doc = new Pdf(...options);
      const original = doc.text;
      doc.text = function (value, ...args) {
        window.writtenPdfLines.push(...(Array.isArray(value) ? value : [value]));
        return original.call(this, value, ...args);
      };
      return doc;
    };
  });
}

async function downloadFrom(page, label, file) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: label, exact: true }).or(page.getByRole("link", { name: label, exact: true })).click();
  await (await download).saveAs(file);
  return readFile(file);
}

function terminalFailure(page) {
  return page.locator("#runStatus:not([hidden])").filter({ hasText: /^Council (incomplete|cancelled)\./ });
}

async function waitForCouncil(page, expected, timeout) {
  const failed = terminalFailure(page);
  await expected.or(failed).first().waitFor({ timeout });
  if (await failed.isVisible()) throw new Error(await failed.textContent());
}

async function submitCouncil(page, url, timeout) {
  await page.goto(url);
  await page.getByLabel("Decision", { exact: true }).fill(title);
  await page.getByLabel("Context Optional", { exact: true }).fill(contextText);
  await page.getByRole("radio", { name: /Quick/ }).check();
  await page.locator(".seat-picker summary").click();
  await page.locator(`#seatChoices input[value="${namedSeats[0]}"]`).check();
  await page.getByRole("button", { name: "Convene the council" }).click();
  await page.getByText("Choose exactly four advisors for quick mode.").waitFor();
  for (const key of namedSeats.slice(1)) await page.locator(`#seatChoices input[value="${key}"]`).check();
  const started = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/council", { timeout });
  await page.getByRole("button", { name: "Convene the council" }).click();
  const response = await started;
  assert.equal(response.status(), 202);
  assert.deepEqual(response.request().postDataJSON(), { idea: title, context: contextText, mode: "quick", seats: namedSeats });
  return (await response.json()).id;
}

async function verifyReports(page, directory, base, id, timeout) {
  await waitForCouncil(page, page.locator("#verdictSheet[open]"), timeout);
  const archive = await (await page.request.get(`${base}/api/sessions/${id}`)).json();
  assert.equal(archive.status, "done");
  assert.equal(archive.id, id);
  const { decision } = archive;
  const md = (await downloadFrom(page, "Download Markdown", path.join(directory, "verdict.download.md"))).toString("utf8");
  assert.match(md, /Evidence appendix/);
  await preparePdfCapture(page);
  const bytes = await downloadFrom(page, "Download PDF", path.join(directory, "verdict.download.pdf"));
  assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
  const pdf = (await page.evaluate(() => window.writtenPdfLines)).join(" ").replace(/\s+/g, " ");
  assert.match(pdf, /Evidence appendix/);
  for (const [option, { display }] of Object.entries(decision.scores)) {
    const value = await page.locator(`[data-result-option="${option}"] .val`).textContent();
    assert.equal(value, display);
    const row = md.split("\n").find((line) => line.startsWith(`| ${option} |`));
    assert.equal(row?.split(/(?<!\\)\|/)[3].trim(), display);
    const label = decision.setup.options.find(({ id: key }) => key === option).label.trim().replace(/\s+/g, " ");
    assert.ok(pdf.includes(`${option} · ${label} · ${display}/10`));
  }
  const dissent = decision.strongestDissent.statement;
  assert.equal(await page.locator("[data-dissent]").textContent(), dissent);
  const decodedMarkdown = md.replace(/\\([\\[\]*_`|])/g, "$1")
    .replace(/&(amp|lt|gt);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[entity]);
  assert.ok(decodedMarkdown.replace(/\s+/g, " ").includes(dissent.replace(/\s+/g, " ")));
  assert.ok(pdf.includes(dissent.replace(/\s+/g, " ")));
  assert.equal(await page.locator("[data-experiment]").textContent(), decision.plan.cheapestTest.action);
  assert.ok((await page.locator(".recommended-option").textContent()).includes(decision.optionLabel));
  if (!live) {
    assert.equal(decision.ratificationStatus, "not_run");
    const timestamp = `https://www.youtube.com/watch?v=${sourceVideo}&t=65`;
    assert.ok(md.includes(timestamp));
    assert.ok(bytes.toString("latin1").includes(timestamp));
    assert.match(pdf, /Metadata unavailable/);
  }
}

async function run() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "roast-room-smoke-"));
  let browser, host, viewer;
  try {
    const sourceId = live ? null : await seedEvidence(directory);
    host = await openServer({ dataDir: directory, runner: "codex", legacy: false,
      generate: live ? undefined : createSyntheticGenerator({ clarify: true }) });
    browser = await chromium.launch(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", acceptDownloads: true });
    const errors = [];
    desktop.on("pageerror", (error) => errors.push(error.message));
    const timeout = live ? 30 * 60_000 : 20_000;
    const id = await submitCouncil(desktop, host.url, timeout);
    if (!live) {
      await desktop.getByText("The council is waiting for your answer.").waitFor();
      await desktop.reload();
      await desktop.getByText("The council is waiting for your answer.").waitFor();
      assert.equal(new URL(desktop.url()).searchParams.get("session"), id);
      host.dropConnections();
      await desktop.getByText("Connection interrupted. Reconnecting to this session…").waitFor();
      await desktop.locator("#connectionNotice").waitFor({ state: "hidden" });
      await desktop.getByLabel("Your answer").fill("Two hours for the synthetic paid pilot.");
      await desktop.getByRole("button", { name: "Send to the Chair" }).click();
    } else {
      await waitForCouncil(desktop, desktop.locator("#verdictSheet[open]").or(desktop.locator("#clarification:not([hidden])")), timeout);
      if (await desktop.locator("#clarification").isVisible()) {
        await desktop.getByLabel("Your answer").fill(contextText);
        await desktop.getByRole("button", { name: "Send to the Chair" }).click();
      }
    }
    await verifyReports(desktop, directory, host.url, id, timeout);
    const listing = await (await desktop.request.get(`${host.url}/api/sessions`)).json();
    assert.equal(listing.sessions.length, 1);

    if (!live) {
      await desktop.getByText("Evidence appendix", { exact: true }).click();
      const drawer = desktop.locator(".source-drawer").filter({ hasText: caption });
      await drawer.locator("summary").click();
      assert.match(await drawer.getByRole("link", { name: `Watch at ${at}` }).getAttribute("href"), /t=65$/);
      const evidence = evidenceIndex(directory);
      try { evidence.withdrawSource(sourceId, "Synthetic source withdrawal exercised by browser smoke."); }
      finally { evidence.close(); }
      await desktop.reload();
      await desktop.getByText("Evidence appendix", { exact: true }).click();
      const withdrawn = desktop.locator(".source-drawer").filter({ hasText: "Withdrawn" });
      await withdrawn.locator("summary").click();
      assert.equal(await withdrawn.getByRole("link").count(), 0);
      await desktop.getByRole("button", { name: "Back to the table" }).click();
      await desktop.getByRole("button", { name: "New question" }).click();
      await desktop.getByLabel("Decision", { exact: true }).fill(title);
      await desktop.getByRole("button", { name: "Convene the council" }).click();
      await desktop.getByText("The council is waiting for your answer.").waitFor();
      await desktop.getByRole("button", { name: "Cancel council" }).click();
      await desktop.locator("#runStatus").filter({ hasText: "Council cancelled." }).waitFor();
      assert.equal(await desktop.locator("#cancelBtn").isVisible(), false);

      viewer = await openServer({ dataDir: directory, runner: "viewer" });
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
      phone.on("pageerror", (error) => errors.push(error.message));
      await phone.goto(viewer.url);
      await phone.getByText("$roast-room should I ...", { exact: true }).waitFor();
      assert.equal(await phone.locator("#composer").isVisible(), false);
      await phone.getByRole("button", { name: "Past sessions", exact: true }).click();
      await phone.locator(`button[data-id="${legacyReplay}"]`).click();
      await phone.locator("#verdictSheet[open]").waitFor();
      assert.equal(await phone.locator("#verdictSheet").getByRole("button", { name: "Download PDF" }).count(), 1);
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false);
      await phone.close();
    }
    assert.deepEqual(errors, []);
    console.log(live ? "Live Codex browser handoff and report parity passed." :
      "Browser smoke passed: submission, clarification, reconnect, report parity, evidence withdrawal, cancellation, and mobile legacy viewer.");
  } finally {
    await browser?.close();
    await viewer?.close();
    await host?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

await run();
