import { downloadDecisionPdf, downloadVerdictPdf } from "./pdf.js";
import { buildDecisionReport, buildSeatEvidence, escapeHtml as esc, evidenceReferences, renderSeatSources } from "./decision-report.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const SAMPLES = [
  ["Raise my prices?", "I run a coaching business doing $30k a month with 15 active clients at $2,000 each. I want to raise the price to $3,500. Options: raise for everyone now, raise for new clients only, or keep $2,000. Close rate is about 50% on sales calls. I'm leaning toward raising for everyone because I'm underpaid."],
  ["First salesperson?", "I'm a solo founder of a B2B SaaS at $25k MRR growing 5% a month. I do every sales call myself (about 20 hours a week) and I'm burning out. Should I hire a full-time account executive at $120k base, hire a part-time commission-only closer, or keep selling myself for six more months? I have $150k in the bank."],
  ["Second product?", "My agency makes $80k a month building AI automations for dentists. A few clients asked for an AI receptionist product. Should I build the receptionist as a separate SaaS, offer it as an add-on to existing clients only, or stay focused on the agency? Team of 6, about $200k cash."],
  ["Quit my job?", "I make $180k a year at a tech company. My side business (a paid newsletter) makes $6k a month and grew 8% a month this year. I have 9 months of expenses saved. Should I quit now, quit in 6 months, or keep both and hire a writer?"],
];

const EXAMPLE = "I run a coaching business at $30k a month with 15 clients at $2,000 each. Should I raise to $3,500 for everyone, raise for new clients only, or keep $2,000? Close rate is about 50% and I have $40k in the bank. Success is $45k a month by March. I'm leaning toward raising for everyone because I'm underpaid.";

// The how-to, shown in the side panel while the room is empty and in "How it works".
const GUIDE = `
  <div class="guide">
    <div class="guide-sec">
      <h4>How to use the Roast Room</h4>
      <ol>
        <li><span>Submit a decision in the room or type <code>$roast-room</code> in Codex from this folder.</span></li>
        <li><span>Let the Chair pick the advisors, or choose a board. Answer any questions that come up before the opening round.</span></li>
        <li><span>Watch the rounds and download the verdict as Markdown or PDF.</span></li>
      </ol>
    </div>
    <div class="guide-sec">
      <h4>What to put in your question</h4>
      <ul>
        <li><span><b>The decision</b> in one line.</span></li>
        <li><span><b>Your options.</b> Two or three. "Keep doing what I do now" counts.</span></li>
        <li><span><b>Your numbers.</b> Revenue, cash, and team size.</span></li>
        <li><span><b>Your limits.</b> Deadline, hours, and budget.</span></li>
        <li><span><b>What success looks like</b>, and by when.</span></li>
        <li><span><b>Which way you're leaning</b>, and why. The council tests it.</span></li>
      </ul>
      <p class="note" style="margin-top:8px">Left something out? The Chair asks before the council starts.</p>
    </div>
    <div class="guide-sec">
      <h4>Example</h4>
      <div class="example">
        <p><code>$roast-room</code> ${esc(EXAMPLE)}</p>
        <button class="ghost" type="button" data-copy-example>Copy this example</button>
      </div>
    </div>
    <div class="guide-sec">
      <h4>Good to know</h4>
      <ul>
        <li><span><b>Full council:</b> The Chair selects five to seven advisors by default. They go through openings, debate and a vote.</span></li>
        <li><span><b>Quick:</b> Four advisors hold openings and debate. Close agreement can skip the vote.</span></li>
        <li><span><b>Every council is saved.</b> Open Past sessions to replay one or download its PDF.</span></li>
        <li><span><b>Read the sources:</b> Advisor cards show transcript passages, speaker checks, source gaps and stored frameworks.</span></li>
      </ul>
    </div>
  </div>`;

const SHAPES = ["base", "open", "mid", "blink"];
// A seat's cartoon frames live in /portraits/<key>-<shape>.webp (or .png, .jpg). A seat added with /newroaster
// may have only a base frame, or none: missing frames fall back to the base frame, then to a
// drawn bust in the seat's color whose mouth and eyes still move.
const portrait = (key, shape = "base") => {
  const have = state.byKey[key]?.portraits || {};
  return have[shape] || have.base || drawnBust(key, shape);
};
const bustCache = new Map();
function drawnBust(key, shape) {
  const id = `${key}-${shape}`;
  if (bustCache.has(id)) return bustCache.get(id);
  const s = state.byKey[key] || {};
  const c = /^#[0-9a-f]{6}$/i.test(s.color || "") ? s.color : "#37bdf8";
  const initials = esc((s.initials || s.short || key).slice(0, 3).toUpperCase());
  const eyes = shape === "blink"
    ? `<path d="M226 250h30M304 250h30" stroke="#1d2733" stroke-width="7" stroke-linecap="round"/>`
    : `<circle cx="241" cy="250" r="11" fill="#1d2733"/><circle cx="319" cy="250" r="11" fill="#1d2733"/><circle cx="245" cy="246" r="3.5" fill="#fff"/><circle cx="323" cy="246" r="3.5" fill="#fff"/>`;
  const mouth = shape === "open" ? `<ellipse cx="280" cy="318" rx="24" ry="17" fill="#5a2430"/>`
    : shape === "mid" ? `<ellipse cx="280" cy="316" rx="20" ry="8" fill="#5a2430"/>`
    : `<path d="M256 312q24 16 48 0" fill="none" stroke="#5a2430" stroke-width="7" stroke-linecap="round"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 560"><g transform="translate(-14 -64) scale(1.05)">
    <path d="M70 640c0-160 86-250 210-250s210 90 210 250z" fill="${c}"/>
    <path d="M232 384h96l-48 58z" fill="#e9eef3"/>
    <rect x="248" y="330" width="64" height="70" rx="22" fill="#d9b49a"/>
    <ellipse cx="280" cy="250" rx="112" ry="128" fill="#e8c4a8"/>
    <path d="M168 236c0-90 50-122 112-122s112 32 112 122c-20-46-60-64-112-64s-92 18-112 64z" fill="#3a4654"/>
    ${eyes}${mouth}
    <text x="280" y="540" text-anchor="middle" font-family="Montserrat, Arial, sans-serif" font-weight="800" font-size="54" fill="rgba(255,255,255,.92)">${initials}</text>
  </g></svg>`;
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  bustCache.set(id, url);
  return url;
}
const ROUND_NAME = ["", "Opening", "Debate", "Vote"];

const state = {
  seats: [], byKey: {}, board: [], table: [], session: null, options: [], weights: {}, active: [], round: 0,
  cards: { 1: {}, 2: {}, 3: {} }, replaying: false, verdict: null, links: [], geo: {}, setup: null, wait: null,
  runner: null, decision: null, terminal: false, control: false, submitting: false,
};

// ------------------------------------------------------------- boot
async function boot() {
  renderSamples();
  bindUI();
  new ResizeObserver(() => { layoutStage(); drawLinks(); }).observe($("#stage"));
  typeIn($("#waiting h2"));
  await connectRoom();
  setInterval(watchForLive, 2500);
  setInterval(tickWait, 1000);
}

async function requestJson(url, value) {
  const response = await fetch(url, value === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!response.ok) {
    const issue = await response.json().catch(() => ({}));
    throw new Error(issue.error || "The room couldn’t complete this request.");
  }
  return response.json();
}

function connectionNotice(message = "", retry = false) {
  $("#connectionMessage").textContent = message;
  $("#reconnectBtn").hidden = !retry;
  $("#connectionNotice").hidden = !message;
}

async function connectRoom() {
  connectionNotice("Connecting to the room…");
  const requested = new URL(location.href).searchParams.get("session");
  try {
    const [roster, listing] = await Promise.all([refreshSeats(), requestJson("/api/sessions")]);
    state.runner = roster.runner;
    renderSeatChoices();
    reset();
    connectionNotice();
    const entry = listing.sessions.find((session) => session.id === requested);
    if (requested && entry?.status !== "running" && requested !== listing.running && requested !== listing.live) await replay(requested);
    else if (requested || listing.running || listing.live) {
      attach(requested || listing.running || listing.live, { control: Boolean(requested ? requested === listing.running : listing.running) });
    }
  } catch {
    connectionNotice("The room couldn’t connect. Check that the local server is running.", true);
  }
}

// The roster (every seat, plus the default board) comes from the skill's roster.json.
async function refreshSeats() {
  const r = await requestJson("/api/seats");
  state.seats = r.seats;
  state.byKey = Object.fromEntries(r.seats.map((s) => [s.key, s]));
  state.board = (r.board?.default || []).filter((k) => state.byKey[k]);
  if (!state.board.length) state.board = r.seats.slice(0, 7).map((s) => s.key);
  bustCache.clear();
  return r;
}

// A CLI council opens automatically when the room has no session loaded.
const seenLive = new Set();
async function watchForLive() {
  if (!state.runner || state.session || state.submitting) return;
  const ss = await requestJson("/api/sessions").catch(() => null);
  if (state.session || state.submitting) return;
  const id = ss?.running || ss?.live;
  if (!id || seenLive.has(id)) return;
  attach(id, { control: id === ss.running });
}

// AIS arrival: a heading types in a character at a time, blur to sharp
function typeIn(el) {
  if (!el) return;
  const text = el.textContent;
  el.classList.add("typein");
  // characters sit inside a nowrap span per word, so lines only break between words
  let i = 0;
  el.innerHTML = text.split(" ").map((word) => `<span class="wd">${[...word].map((c) => `<span class="ch" style="animation-delay:${i++ * 22}ms">${esc(c)}</span>`).join("")}</span>`).join(" ");
  el.setAttribute("aria-label", text);
}

function renderSamples() {
  $("#samples").innerHTML = SAMPLES.map(([t], i) => `<button type="button" data-i="${i}">${esc(t)}</button>`).join("");
  $("#samples").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $("#idea").value = SAMPLES[b.dataset.i][1];
    $("#idea").focus();
  });
}

function renderSeatChoices() {
  $("#seatChoices").innerHTML = state.seats.map((seat) =>
    `<label><input type="checkbox" name="seat" value="${esc(seat.key)}"> ${esc(seat.name)}</label>`).join("");
  updateSeatHelp();
}

function updateSeatHelp() {
  const mode = $('input[name="mode"]:checked').value;
  const count = $$('#seatChoices input:checked').length;
  const hint = mode === "quick" ? "Choose any four." : "Choose two to nine advisors.";
  $("#seatHelp").textContent = count ? `${count} selected. ${hint}` : `${hint} Leave them blank for the Chair to pick.`;
}

const MAX_TABLE = 9; // the most busts the table can seat and still read

/** Seat these keys at the table (roster order). Does nothing when they are already seated. */
function renderSeats(keys) {
  const order = state.seats.map((s) => s.key);
  const want = order.filter((k) => keys.includes(k)).slice(0, MAX_TABLE);
  if (want.join() === state.table.join() && $("#seats").children.length) return;
  state.table = want;
  const seats = want.map((k) => state.byKey[k]);
  $("#seats").innerHTML = seats.map((s, i) => `
    <div class="seat" id="seat-${s.key}" data-seat="${s.key}" style="--d:-${(i * 1.7) % 6}s" tabindex="0" role="button" aria-label="${esc(s.name)}, ${esc(s.pillar)}. Open card.">
      <div class="think" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="bust" data-shape="base">${SHAPES.map((sh) => `<img class="${sh}" src="${portrait(s.key, sh)}" alt="" draggable="false">`).join("")}</div>
    </div>`).join("");
  $("#plates").innerHTML = seats.map((s) => `
    <div class="nameplate" id="plate-${s.key}" data-seat="${s.key}">
      <b>${esc(s.short === "Gary V" ? "Gary V" : s.name)}</b>
      <small>${esc(s.pillar)}</small>
      <div class="meta"><span class="pips" title="Weight on this decision"></span><span class="chip" hidden></span><span class="score" hidden></span></div>
    </div>`).join("");
  layoutStage();
  startBlinking();
}

// The table is an ellipse seen from the front. Seats sit along its far edge: the
// middle seat is farthest (higher, smaller), the end seats nearest (lower, bigger).
function layoutStage() {
  const stage = $("#stage");
  const W = stage.clientWidth;
  const narrow = matchMedia("(max-width: 820px)").matches;
  const H = narrow ? Math.round(W * 0.62) : stage.clientHeight;
  const cx = W / 2, cy = H * (narrow ? 0.98 : 0.9), rx = W * 0.48, ry = H * (narrow ? 0.46 : 0.42);
  const t = $("#table");
  Object.assign(t.style, { left: `${cx - rx}px`, top: `${cy - ry}px`, width: `${rx * 2}px`, height: `${ry * 2}px` });
  const edge = (x) => cy - ry * Math.sqrt(Math.max(0, 1 - ((x - cx) / rx) ** 2));
  // seats spread evenly along the far edge; past seven they shrink to fit
  const n = state.table.length;
  const xs = n === 1 ? [0.5] : state.table.map((_, i) => 0.085 + (0.83 * i) / (n - 1));
  const fit = Math.min(1, 6 / Math.max(1, n - 1));
  state.geo = {};
  state.table.forEach((k, i) => {
    const s = state.byKey[k];
    const x = W * xs[i];
    const d = ((x - cx) / rx) ** 2;
    const size = H * (narrow ? 0.5 + 0.08 * d : 0.37 + 0.07 * d) * fit;
    const bottom = edge(x) + size * 0.2;
    const el = $(`#seat-${s.key}`);
    Object.assign(el.style, { left: `${x - size / 2}px`, top: `${bottom - size}px`, width: `${size}px`, height: `${size}px`, zIndex: 10 + Math.round(d * 10) });
    const pl = $(`#plate-${s.key}`);
    pl.style.left = `${x}px`;
    pl.style.top = `${edge(x) + H * 0.01}px`; // straddles the table edge, over the chest
    state.geo[s.key] = { x, head: bottom - size * 0.72, top: bottom - size * 0.9, size };
  });
  const c = $("#center");
  if (narrow) {
    stage.style.paddingTop = `${H}px`; // the scene sits on top; captions flow below it
  } else {
    stage.style.paddingTop = "";
    // the captions start below the lowest nameplate they could collide with
    const inner = (n > 2 ? state.table.slice(1, -1) : state.table).map((k) => $(`#plate-${k}`));
    const top = Math.max(H * .48, ...inner.map((p) => p.offsetTop + p.offsetHeight / 2)) + H * 0.035;
    Object.assign(c.style, { left: `${W * 0.2}px`, width: `${W * 0.6}px`, top: `${top}px`, height: `${H - top - H * 0.09}px` });
  }
  const sp = state.speaking ? state.geo[state.speaking] : null;
  if (sp) moveSpot(state.speaking);
}

function moveSpot(key) {
  const g = state.geo[key]; const spot = $("#spot");
  if (!g) { spot.classList.remove("on"); return; }
  spot.style.left = `${g.x}px`;
  spot.style.top = `${g.head}px`;
  spot.style.width = spot.style.height = `${g.size * 1.9}px`;
  spot.classList.add("on");
}

function bindUI() {
  $("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.submitting) return;
    const idea = $("#idea").value.trim();
    const context = $("#context").value.trim();
    const mode = $('input[name="mode"]:checked').value;
    const seats = $$('#seatChoices input:checked').map((input) => input.value);
    fieldError("#submitError");
    if (idea.length < 10) {
      fieldError("#submitError", "Enter the decision as a sentence.");
      return $("#idea").focus();
    }
    if (seats.length && (mode === "quick" ? seats.length !== 4 : seats.length < 2 || seats.length > 9)) {
      fieldError("#submitError", mode === "quick" ? "Choose exactly four advisors for quick mode." : "Choose two to nine advisors for full mode.");
      const picker = $(".seat-picker");
      picker.open = true;
      return $("summary", picker).focus();
    }
    const button = $("#convene");
    state.submitting = button.disabled = true;
    button.textContent = "Starting the council…";
    try {
      const session = await requestJson("/api/council", { idea, context, mode, ...(seats.length ? { seats } : {}) });
      attach(session.id, { control: true });
    } catch (error) {
      fieldError("#submitError", error.message);
    } finally {
      state.submitting = button.disabled = false;
      button.textContent = "Convene the council";
    }
  });
  $("#composer").addEventListener("change", updateSeatHelp);
  $("#focusIntake").addEventListener("click", () => $("#idea").focus());
  $("#clarification").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = state.session;
    const button = $("#answerBtn");
    if (!state.control || !id || button.disabled) return;
    fieldError("#clarificationError");
    button.disabled = true;
    try {
      await requestJson(sessionAction(id, "clarification"), { answer: $("#answer").value.trim() });
      if (state.session === id) closeClarification();
    } catch (error) {
      if (state.session === id) fieldError("#clarificationError", error.message);
    } finally {
      button.disabled = false;
    }
  });
  $("#cancelBtn").addEventListener("click", async (e) => {
    const id = state.session;
    const button = e.currentTarget;
    if (!id || !state.control || button.disabled) return;
    button.disabled = true;
    try {
      await requestJson(sessionAction(id, "cancel"), {});
      if (state.session === id && !state.terminal) showRunStatus("Cancelling the council…");
    } catch (error) {
      if (state.session === id) toast(error.message);
    } finally {
      button.disabled = false;
    }
  });
  $("#reconnectBtn").addEventListener("click", () => {
    if (state.session) attach(state.session, { control: state.control, resume: true });
    else connectRoom();
  });
  const openFrom = (e) => { const b = e.target.closest("[data-seat]"); if (b) openCard(b.dataset.seat); };
  $("#seats").addEventListener("click", openFrom);
  $("#plates").addEventListener("click", openFrom);
  $("#seats").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFrom(e); } });
  $("#feed").addEventListener("click", (e) => { const c = e.target.closest(".feed-card"); if (c) openCard(c.dataset.seat, Number(c.dataset.round)); });
  $("#waitHistory").addEventListener("click", openHistory);
  $("#waitGuide").addEventListener("click", openGuide);
  $("#guideBtn").addEventListener("click", openGuide);
  document.addEventListener("click", async (e) => {
    if (e.target.closest("[data-copy-example]")) {
      try { await navigator.clipboard.writeText("$roast-room " + EXAMPLE); toast("Copied. Paste it into Codex."); }
      catch { toast("Copy didn't work here. Select the text and copy it."); }
    }
    if (e.target.closest("[data-pdf]")) savePdf(e.target.closest("[data-pdf]"));
  });
  $("#historyBtn").addEventListener("click", openHistory);
  $("#newBtn").addEventListener("click", () => { reset(); connectionNotice(); });
  $("#verdictSheet").addEventListener("click", (e) => { if (e.target.id === "verdictSheet" || e.target.closest("[data-close]")) $("#verdictSheet").close(); });
  // Clicking the dimmed backdrop around a card, the guide, or past sessions closes it (Escape already does).
  // Both press and release must land outside the box, so a text selection dragged out of it never closes it.
  $$("dialog.card-dialog").forEach((d) => {
    const outside = (e) => {
      const r = d.getBoundingClientRect();
      return e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
    };
    let pressedOutside = false;
    d.addEventListener("pointerdown", (e) => { pressedOutside = outside(e); });
    d.addEventListener("click", (e) => { if (pressedOutside && outside(e)) d.close(); pressedOutside = false; });
  });
  $$(".speed button").forEach((b) => b.addEventListener("click", () => {
    player.speed = Number(b.dataset.speed);
    $$(".speed button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  $("#skipBtn").addEventListener("click", () => player.skip());
}

const sessionPath = (id) => `/api/sessions/${encodeURIComponent(id)}`;
const sessionAction = (id, action) => `/api/council/${encodeURIComponent(id)}/${action}`;

function fieldError(selector, message = "") {
  const notice = $(selector);
  notice.textContent = message;
  notice.hidden = !message;
  if (message) notice.scrollIntoView({ block: "nearest" });
}

function showRunStatus(message = "") {
  $("#runStatus").textContent = message;
  $("#runStatus").hidden = !message;
}

// ------------------------------------------------------------- the player
// Every event goes through one ordered queue. Seats speak one at a time, at a
// readable pace, even though the API answers them in parallel. Skip ahead drains
// whatever is queued instantly; new events after that animate again.
const player = {
  q: [], busy: false, epoch: 0, speed: 1, fast: false, timers: new Set(),
  push(ev) { this.q.push(ev); this.info(); this.pump(); },
  async pump() {
    if (this.busy) return;
    this.busy = true;
    const my = this.epoch;
    while (this.q.length && my === this.epoch) {
      const ev = this.q.shift();
      this.info();
      hideWait();
      try { await handle(ev); } catch (e) { console.error(e); }
    }
    if (my === this.epoch) { this.busy = false; this.fast = false; this.info(); }
  },
  sleep(ms) {
    if (this.fast || ms <= 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
    return new Promise((res) => { const t = setTimeout(() => { this.timers.delete(o); res(); }, ms / this.speed); const o = { t, res }; this.timers.add(o); });
  },
  flushTimers() { for (const o of this.timers) { clearTimeout(o.t); o.res(); } this.timers.clear(); },
  skip() { this.fast = true; this.flushTimers(); },
  reset() { this.epoch++; this.q.length = 0; this.fast = true; this.flushTimers(); this.busy = false; this.fast = false; this.info(); },
  info() {
    const waiting = this.q.filter((e) => e.type === "seat_done").length;
    $("#queueInfo").textContent = waiting ? `${waiting} lines up next` : "";
  },
};

// ------------------------------------------------------------- session wiring
function reset() {
  state.es?.close();
  player.reset();
  Object.assign(state, { session: null, options: [], weights: {}, active: [], round: 0, cards: { 1: {}, 2: {}, 3: {} }, replaying: false, verdict: null, links: [], speaking: null, setup: null, wait: null,
    control: false, terminal: false, es: null, cursor: 0, seenEvents: new Set(), decision: null, progress: {} });
  setSessionUrl();
  hideWait();
  closeClarification();
  showRunStatus();
  $("#stage").classList.remove("live");
  $("#topic").hidden = true;
  $("#composer").hidden = state.runner !== "codex";
  $("#waiting").hidden = state.runner !== "viewer";
  $("#invite").hidden = state.runner !== "codex";
  $("#caption").hidden = true;
  $("#cruxes").hidden = true;
  $("#plate").hidden = true;
  $("#playbar").hidden = true;
  $("#newBtn").hidden = true;
  $("#cancelBtn").hidden = true;
  $("#verdictSheet").close();
  $("#panelHead").textContent = state.runner === "codex" ? "New council" : "Getting started";
  $("#feed").innerHTML = GUIDE;
  $("#feed").hidden = state.runner === "codex";
  $$(".vote").forEach((b) => b.remove());
  renderSeats(state.board);
  $$(".seat").forEach((el) => { el.classList.remove("absent", "speaking", "thinking", "addressed"); $(".bust", el).dataset.shape = "base"; });
  $$(".nameplate").forEach((el) => { el.classList.remove("absent", "speaking"); $(".chip", el).hidden = true; $(".score", el).hidden = true; $(".pips", el).innerHTML = ""; });
  $("#spot").classList.remove("on");
  $$(".stepper li").forEach((li) => {
    li.classList.remove("active", "done", "skipped");
    li.removeAttribute("aria-current");
    li.removeAttribute("aria-label");
  });
  drawLinks();
}

function begin(id) {
  reset();
  state.session = id;
  setSessionUrl(id);
  $("#composer").hidden = true;
  $("#waiting").hidden = true;
  $("#invite").hidden = true;
  $("#playbar").hidden = false;
  $("#feed").hidden = false;
  $("#panelHead").textContent = "Key points";
  $("#feed").innerHTML = '<div class="empty">One line per seat as the council talks. Click a seat to read its full card.</div>';
  $("#stage").classList.add("live");
  chairSays("The council is taking their seats", { dots: true });
}

function setSessionUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("session", id);
  else url.searchParams.delete("session");
  history.replaceState(null, "", url);
}

function attach(id, { control = false, resume = false } = {}) {
  if (state.session !== id || !resume) begin(id);
  else state.es?.close();
  seenLive.add(id);
  state.control = control;
  $("#cancelBtn").hidden = !control;
  connectionNotice();
  const es = new EventSource(`/api/stream/${encodeURIComponent(id)}`);
  state.es = es;
  es.onopen = () => { if (state.es === es) connectionNotice(); };
  es.onmessage = (m) => {
    if (state.es !== es) return;
    const ev = JSON.parse(m.data);
    if (ev.type === "end") {
      es.close();
      connectionNotice();
      player.push(ev);
      return;
    }
    const cursor = Number(m.lastEventId);
    if (cursor > 0) {
      if (cursor <= state.cursor) return;
      state.cursor = cursor;
    } else {
      if (state.seenEvents.has(m.data)) return;
      state.seenEvents.add(m.data);
    }
    if (ev.type === "delta") return; // seats speak from their finished cards
    if (ev.type === "usage") return;
    if (ev.type === "seat_error") return toast(`${state.byKey[ev.seat]?.short || ev.seat} hit an error: ${ev.error}`);
    if (ev.type === "status" && ["cancelled", "incomplete"].includes(ev.status)) player.skip();
    player.push(ev);
  };
  es.onerror = () => {
    if (state.es !== es) return;
    const stopped = es.readyState === EventSource.CLOSED;
    connectionNotice(stopped ? "The stream closed. Reconnect to this session." : "Connection interrupted. Reconnecting to this session…", stopped);
  };
}

// ------------------------------------------------------------- event handling
const STEP_OF = { setup: "setup", round1: "round1", cruxes: "cruxes", round2: "round2", draft: "round3", round3: "round3", skip3: "verdict", verdict: "verdict" };
const ORDER = ["setup", "round1", "cruxes", "round2", "round3", "verdict"];

function setStep(step) {
  const idx = ORDER.indexOf(step);
  $$(".stepper li").forEach((li) => {
    const i = ORDER.indexOf(li.dataset.step);
    li.classList.toggle("done", i < idx && !li.classList.contains("skipped"));
    li.classList.toggle("active", i === idx);
    if (i === idx) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
}

async function handle(ev) {
  switch (ev.type) {
    case "phase": {
      closeClarification();
      state.wait = { phase: ev.phase, at: ev.at || Date.now() };
      if (ev.phase === "skip3") markVoteSkipped();
      setStep(STEP_OF[ev.phase] || "setup");
      feedPhase(ev.label);
      const thinking = ["setup", "cruxes", "draft", "verdict"].includes(ev.phase);
      if (thinking || ev.phase === "skip3") {
        chairSays(ev.label.replace(/^The Chair is /, "").replace(/^./, (c) => c.toUpperCase()), { dots: thinking });
        await player.sleep(1400);
      }
      break;
    }
    case "setup": state.setup = ev; await onSetup(ev); await player.sleep(1800); break;
    case "clarification": if (!state.replaying) openClarification(ev.questions); break;
    case "clarification_answered":
      closeClarification();
      showRunStatus(ev.timedOut ? "The Chair will continue with the available details." : "");
      break;
    case "round_start": onRoundStart(ev.round); break;
    case "round_progress": {
      state.progress[ev.round] = ev.complete;
      showRunStatus(`Round ${ev.round} · ${ev.complete} of ${ev.total} advisor cards ready`);
      break;
    }
    case "seat_start": $(`#seat-${ev.seat}`)?.classList.add("thinking"); break;
    case "seat_done": await onSeatDone(ev); break;
    case "round_done": {
      state.wait = null;
      if (ev.cards) for (const card of ev.cards) await onSeatDone(card);
      updateOptions(ev.scores, ev.recommended);
      showRunStatus();
      break;
    }
    case "cruxes": await onCruxes(ev); break;
    case "draft": await onDraft(ev.draft); break;
    case "verdict":
      state.wait = null;
      if (ev.decision) onCodexVerdict(ev);
      else onVerdict(ev);
      break;
    case "status":
      if (["done", "incomplete", "cancelled", "interrupted", "stopped"].includes(ev.status)) finishView(ev.status, ev.message);
      break;
    case "end": if (!state.terminal) finishView(state.verdict ? "done" : "stopped"); break;
    case "error": finishView("incomplete", ev.error); break;
  }
}

function openClarification(questions) {
  state.wait = null;
  $("#questions").innerHTML = questions.map((question) => `<li>${esc(question)}</li>`).join("");
  showRunStatus(state.control ? "The council is waiting for your answer." : "The Chair is waiting for an answer in Codex.");
  if (state.control && !state.terminal) {
    $("#clarification").hidden = false;
    $("#answer").focus({ preventScroll: true });
  }
  chairSays("The Chair needs more information to seat the council.", { tag: "Clarification" });
}

function closeClarification() {
  $("#clarification").hidden = true;
  $("#answer").value = "";
  fieldError("#clarificationError");
}

function finishView(status, detail = "") {
  state.wait = null;
  state.terminal = true;
  state.control = false;
  closeClarification();
  $("#cancelBtn").hidden = true;
  $("#newBtn").hidden = false;
  $("#playbar").hidden = true;
  if (status === "done") return showRunStatus();
  $("#stage").classList.remove("live");
  setSpeaker(null);
  $$(".seat.thinking").forEach((seat) => seat.classList.remove("thinking"));
  const message = status === "cancelled" ? "Council cancelled." : "Council incomplete.";
  showRunStatus(detail.startsWith(message) ? detail : `${message} ${detail || "Completed rounds are still available."}`);
  chairSays(message, { tag: status === "cancelled" ? "Cancelled" : "Incomplete" });
}

async function onSetup(ev) {
  const epoch = player.epoch;
  if (ev.seats.some((k) => !state.byKey[k])) await refreshSeats().catch(() => null);
  if (epoch !== player.epoch) return;
  // seat the default board plus anyone this council called in; past the table's limit, only this council
  const both = [...new Set([...state.board, ...ev.seats])];
  renderSeats(both.length <= MAX_TABLE ? both : ev.seats);
  state.options = ev.options;
  state.weights = ev.weights;
  state.active = ev.seats;
  $("#topic").hidden = false;
  $("#topicTitle").textContent = ev.title;
  typeIn($("#topicTitle"));
  $("#options").innerHTML = ev.options.map((o) => `
    <div class="opt" data-opt="${esc(o.id)}"><span class="id">${esc(o.id)}</span><span class="label">${esc(o.label)}</span><span class="val">–</span><span class="bar"><i></i></span></div>`).join("");
  for (const s of state.table.map((k) => state.byKey[k])) {
    const absent = !ev.seats.includes(s.key);
    $(`#seat-${s.key}`).classList.toggle("absent", absent);
    const pl = $(`#plate-${s.key}`);
    pl.classList.toggle("absent", absent);
    const w = ev.weights[s.key]?.weight || 1;
    pl.title = `Weight ${w} of 3: ${ev.weights[s.key]?.reason || ""}`;
  }
  chairSays(ev.title, { tag: ev.mode === "quick" ? "Quick council" : "Full council" });
}

function updateOptions(scores, recommended) {
  const best = recommended || Object.entries(scores).sort((a, b) =>
    (b[1].raw ?? b[1].score ?? 0) - (a[1].raw ?? a[1].score ?? 0)
      || Number(state.options.find((option) => option.id === b[0])?.statusQuo || false)
        - Number(state.options.find((option) => option.id === a[0])?.statusQuo || false))[0]?.[0];
  for (const [id, v] of Object.entries(scores)) {
    const el = $(`#options .opt[data-opt="${CSS.escape(id)}"]`); if (!el) continue;
    $(".val", el).textContent = v.display ?? v.score ?? "–";
    $(".bar i", el).style.width = `${(v.score || 0) * 10}%`;
    el.classList.toggle("lead", id === best);
    el.title = v.math;
  }
}

function onRoundStart(round) {
  state.round = round;
  state.links = [];
  drawLinks();
  $("#cruxes").hidden = true;
  chairSays(`${["", "Round 1: opening positions", "Round 2: the debate", "Round 3: the vote"][round]}`, { dots: true, tag: "The floor is open" });
}

// ------------------------------------------------------------- talking
const clean = (t) => String(t || "").replace(/\s*\((?:S\d+|source[^)]*)[^)]*\)/gi, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();

function firstSentences(t, max) {
  const parts = t.match(/[^.!?]+[.!?]+["”)]?\s*|[^.!?]+$/g) || [t];
  let out = "";
  for (const p of parts) { if (out && (out + p).length > max) break; out += p; }
  return shorten(out.trim(), max + 40);
}

/** The line a seat says out loud: the headline of its card, not the whole card. */
function lineFor(round, p, max = 170) {
  if (round === 1) return firstSentences(clean(p.call || p.stance), max);
  if (round === 2) {
    let t = clean(p.disagreeLine || p.stance);
    // "Graham. His argument..." reads as talking to him: "Graham, his argument..."
    t = t.replace(/^([A-Za-z][\w.' ]{0,24})[.:,]\s+(\S+)/, (m, name, next) => !seatKey(name) ? m : `${state.byKey[seatKey(name)].short}, ${/^I('|$)/.test(next) ? next : next[0].toLowerCase() + next.slice(1)}`);
    return firstSentences(t, max);
  }
  return firstSentences(clean(p.oneLine || p.amendment), max);
}

function shapesFor(word) {
  const out = [];
  for (const ch of word.toLowerCase()) {
    const s = "aei".includes(ch) ? "open" : "ouwy".includes(ch) ? "mid" : "mbpf".includes(ch) ? "base" : null;
    if (s && s !== out[out.length - 1]) out.push(s);
  }
  return out.length ? out : ["mid"];
}

function setShape(key, shape) { const b = $(`#seat-${key} .bust`); if (b) b.dataset.shape = shape; }

function setSpeaker(key, target) {
  state.speaking = key;
  $$(".seat").forEach((el) => { el.classList.toggle("speaking", el.dataset.seat === key); el.classList.toggle("addressed", el.dataset.seat === target); });
  $$(".nameplate").forEach((el) => el.classList.toggle("speaking", el.dataset.seat === key));
  const el = key && $(`#seat-${key}`);
  if (el) {
    el.classList.remove("thinking");
    // lean toward whoever they're answering
    const g = state.geo[key], tg = target && state.geo[target];
    el.style.transform = tg ? `translateX(${Math.sign(tg.x - g.x) * g.size * 0.04}px) rotate(${Math.sign(tg.x - g.x) * 2.5}deg) scale(1.05)` : "scale(1.05)";
    moveSpot(key);
  } else $("#spot").classList.remove("on");
  $$(".seat").forEach((s) => { if (s.dataset.seat !== key) s.style.transform = ""; });
}

function captionFor(who) {
  $("#cruxes").hidden = true;
  $("#plate").hidden = true;
  const c = $("#caption");
  c.hidden = false;
  c.style.animation = "none"; void c.offsetWidth; c.style.animation = "";
  const s = state.byKey[who];
  $("#capAv").className = `cap-av${s ? "" : " chair"}`;
  $("#capAv").innerHTML = `<img src="${s ? portrait(who) : "/brand/ais-symbol.png"}" alt="">`;
  $("#capWho").textContent = s ? s.name : "The Chair";
}

function chairSays(text, { dots = false, tag = "" } = {}) {
  setSpeaker(null);
  captionFor(null);
  $("#capTag").textContent = tag;
  const p = $("#capText");
  p.className = "cap-text chair";
  p.innerHTML = esc(text) + (dots ? '<span class="dots"><i></i><i></i><i></i></span>' : "");
  $("#capSub").textContent = "";
}

async function speak(key, text, { tag = "", target = null, sub = "" } = {}) {
  const epoch = player.epoch;
  setSpeaker(key, target);
  captionFor(key);
  $("#capTag").textContent = tag;
  $("#capSub").textContent = "";
  const p = $("#capText");
  p.className = "cap-text";
  const words = text.split(" ").filter(Boolean);
  p.innerHTML = words.map((w) => `<span class="w">${esc(w)}</span> `).join("");
  const spans = $$(".w", p);
  for (let i = 0; i < words.length; i++) {
    if (player.fast || matchMedia("(prefers-reduced-motion: reduce)").matches) break;
    const w = words[i];
    spans[i].classList.add("on");
    const shapes = shapesFor(w.replace(/[^a-z]/gi, ""));
    const dur = Math.max(170, w.length * 52);
    const per = dur / (shapes.length + 1);
    for (const sh of shapes) {
      if (epoch !== player.epoch) return;
      setShape(key, sh);
      await player.sleep(per);
    }
    if (epoch !== player.epoch) return;
    setShape(key, "base");
    await player.sleep(per + (/[.!?]["”)]?$/.test(w) ? 340 : /[,;:]$/.test(w) ? 170 : 25));
  }
  if (epoch !== player.epoch) return;
  spans.forEach((s) => s.classList.add("on"));
  setShape(key, "base");
  $("#capSub").textContent = sub;
  await player.sleep(1300);
}

// idle blinking for everyone, so the room feels alive between lines
const blinking = new Set();
function startBlinking() {
  const blink = (key) => {
    const b = $(`#seat-${key} .bust`);
    if (b && b.dataset.shape === "base") {
      b.dataset.shape = "blink";
      setTimeout(() => { if (b.dataset.shape === "blink") b.dataset.shape = "base"; }, 130);
    }
    setTimeout(() => blink(key), 2400 + Math.random() * 4200);
  };
  state.table.filter((k) => !blinking.has(k)).forEach((k, i) => { blinking.add(k); setTimeout(() => blink(k), 600 + i * 530); });
}

async function onSeatDone(ev) {
  const { round, seat, parsed } = ev;
  const epoch = player.epoch;
  if (!state.cards[round] || !state.byKey[seat]) return;
  state.cards[round][seat] = ev;
  const top = topOption(parsed.optionScores);
  const line = lineFor(round, parsed);
  let tag = ROUND_NAME[round], sub = "", target = null;
  if (round === 1) {
    tag = `${stanceWord(parsed.stance)}${top ? ` · backs ${top.id} (${top.v}/10)` : ""}`;
  } else if (round === 2) {
    const tgt = parsed.disagreeWith ? state.byKey[parsed.disagreeWith] : null;
    if (tgt) {
      target = tgt.key;
      tag = `Pushes back on ${tgt.short}`;
      state.links = state.links.filter((l) => l.from !== seat);
      state.links.push({ from: seat, to: tgt.key });
      drawLinks();
    }
    sub = /^yes/i.test(parsed.moved) ? "Changed position" : "";
  } else {
    tag = parsed.vote ? `Votes ${parsed.vote}` : "Vote missing";
  }
  feedCard(round, seat, parsed);
  await speak(seat, line || "I'll put it in my card.", { tag, target, sub });

  if (epoch !== player.epoch) return;
  const pl = $(`#plate-${seat}`);
  const chip = $(".chip", pl);
  chip.hidden = round === 3; // the vote stamp says it
  chip.className = "chip";
  if (round === 3 && ["endorse", "amend", "dissent"].includes(parsed.vote)) {
    const v = parsed.vote;
    chip.textContent = v;
    chip.classList.add(v);
    $(`#seat-${seat} .vote`)?.remove();
    const stamp = document.createElement("div");
    stamp.className = `vote ${v}`;
    stamp.textContent = v.toUpperCase();
    $(`#seat-${seat}`).appendChild(stamp);
  } else chip.textContent = stanceWord(parsed.stance);
  if (top) { const sc = $(".score", pl); sc.hidden = false; sc.textContent = `${top.id} ${top.v}`; sc.title = `Highest score: option ${top.id}`; }
  setSpeaker(null);
}

function stanceWord(t = "") {
  const m = t.match(/strong yes|conditional yes|strong no|yes|no/i);
  if (!m) return "Spoke";
  const w = m[0].toLowerCase();
  return w === "conditional yes" ? "Yes, if" : w[0].toUpperCase() + w.slice(1);
}

function topOption(scores = {}) {
  const e = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return e ? { id: e[0], v: e[1] } : null;
}
const shorten = (t, n) => (t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : t);
const face = (k) => `<img src="${portrait(k)}" alt="${esc(state.byKey[k]?.short || k)}" title="${esc(state.byKey[k]?.short || k)}">`;

async function onCruxes(ev) {
  setSpeaker(null);
  $("#caption").hidden = true;
  const c = $("#cruxes");
  c.hidden = false;
  c.innerHTML = `<div class="head">${ev.unanimous ? "Too much agreement. The Chair pushes back." : "What they're fighting about"}</div>` +
    ev.cruxes.map((x, i) => `<div class="crux" style="animation-delay:${i * 0.18}s"><b>${esc(x.question)}</b><div class="sides">${x.sides.map((sd) => `<span class="side"><span class="faces">${sd.seats.filter((k) => state.byKey[k]).map(face).join("")}</span>${esc(shorten(sd.position, 48))}</span>`).join("")}</div></div>`).join("");
  const f = document.createElement("div");
  f.className = "feed-note";
  f.innerHTML = `<b>The fight:</b> ${ev.cruxes.map((x) => esc(x.question)).join(" ")}`;
  feedAppend(f);
  await player.sleep(3500 + 1800 * ev.cruxes.length);
}

async function onDraft(d) {
  chairSays(`Proposal: ${d.label} on option ${d.option}. ${firstSentences(clean(d.recommendation), 140)}`, { tag: "Up for a vote" });
  const f = document.createElement("div");
  f.className = "feed-note";
  f.innerHTML = `<b>Up for a vote:</b> ${esc(d.label)} on option ${esc(d.option)}.`;
  feedAppend(f);
  await player.sleep(4200);
}

// ------------------------------------------------------------- rebuttal arcs
function drawLinks() {
  const svg = $("#links");
  const stage = $("#stage");
  const w = stage.clientWidth, h = stage.clientHeight;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const links = state.links || [];
  const col = "#38bdf8";
  svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${col}"/></marker></defs>` +
    links.map(({ from, to }, i) => {
      const a = state.geo[from], b = state.geo[to];
      if (!a || !b) return "";
      const y1 = a.top - 6, y2 = b.top - 6;
      const mx = (a.x + b.x) / 2, my = Math.min(y1, y2) - Math.min(90, Math.abs(a.x - b.x) * 0.22) - 10;
      return `<path class="${i < links.length - 1 ? "old" : ""}" d="M${a.x},${y1} Q${mx},${my} ${b.x},${y2}" stroke="${col}" marker-end="url(#arrow)"/>`;
    }).join("");
}

// ------------------------------------------------------------- feed + cards
function feedAppend(node) {
  const feed = $("#feed");
  $(".empty", feed)?.remove();
  feed.appendChild(node);
  feed.scrollTop = feed.scrollHeight;
}
function feedPhase(label) {
  const d = document.createElement("div");
  d.className = "feed-phase";
  d.textContent = label.replace(/^The Chair is /, "Chair: ");
  feedAppend(d);
}
function feedCard(round, seat, parsed) {
  const s = state.byKey[seat];
  const d = document.createElement("div");
  d.className = "feed-card";
  d.dataset.seat = seat;
  d.dataset.round = round;
  const top = topOption(parsed.optionScores);
  const tgt = parsed.disagreeWith ? state.byKey[parsed.disagreeWith]?.short : "";
  const what = round === 1 ? `${stanceWord(parsed.stance)}${top ? `, backs ${top.id}` : ""}` : round === 2 ? (tgt ? `vs ${tgt}` : "Debate") : parsed.vote ? `Votes ${parsed.vote}` : "Vote missing";
  d.innerHTML = `<img class="av" src="${portrait(seat)}" alt=""><div><div class="h">${esc(s.short)}<span class="r">${esc(what)}</span></div><p>${esc(lineFor(round, parsed, 105))}</p></div>`;
  d.tabIndex = 0;
  d.setAttribute("role", "button");
  d.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openCard(seat, round);
  });
  feedAppend(d);
}

function openCard(seat, round) {
  const s = state.byKey[seat];
  const rounds = [3, 2, 1].filter((r) => state.cards[r][seat]);
  const r = round || rounds[0];
  const c = state.cards[r]?.[seat];
  const packet = state.decision?.evidence?.[seat] || c?.evidence;
  const profile = state.decision?.profiles?.[seat] || { name: s.name, version: state.setup?.profileVersions?.[seat] };
  const sources = buildSeatEvidence(seat, packet, profile, c?.card ? evidenceReferences(c.card) : undefined, c?.card?.frameworksUsed, c?.card?.quotes);
  $("#cardBody").innerHTML = `
    <div class="card-head"><img src="${portrait(seat)}" alt=""><div><div class="label">${esc(s.pillar)}</div><h3 id="seatHeading">${esc(s.name)}</h3><p class="muted" style="margin:0">Owns the question: ${esc(s.question)}</p></div></div>
    ${rounds.length > 1 ? `<p style="margin:0 0 6px">${rounds.slice().reverse().map((x) => `<button class="ghost" data-r="${x}" style="margin-right:6px">${ROUND_NAME[x]}</button>`).join("")}</p>` : ""}
    ${c ? `<pre>${esc(c.text)}</pre>${c.quotes?.length ? `<ul class="qcheck">${c.quotes.map((q) => `<li class="${q.verified ? "" : "bad"}">"${esc(shorten(q.quote, 110))}" (${esc(q.source)}) ${q.verified ? "verified in the brain" : "not found in the brain"}</li>`).join("")}</ul>` : ""}` : `<p class="muted">This seat has not spoken yet.</p>`}
    ${renderSeatSources(sources, c?.card?.claims)}
    <p class="muted" style="font-size:12px">A simulated advisor inspired by ${esc(s.name)}'s public work.</p>`;
  $$("#cardBody [data-r]").forEach((b) => b.addEventListener("click", () => openCard(seat, Number(b.dataset.r))));
  const dlg = $("#cardDialog");
  if (!dlg.open) dlg.showModal();
}

// ------------------------------------------------------------- verdict
// the Chair should write display names; map any raw seat key just in case
const seatKey = (x) => { const k = String(x).toLowerCase().replace(/\s+/g, ""); return state.byKey[k] ? k : state.seats.find((s) => s.short.toLowerCase() === String(x).toLowerCase() || s.name.toLowerCase() === String(x).toLowerCase())?.key; };
const seatName = (x) => state.byKey[seatKey(x)]?.short || x;

function labelClass(l) { return /DON'T/.test(l) ? "dont" : /RESHAPE/.test(l) ? "reshape" : /WAIT/.test(l) ? "wait" : "go"; }

function resetStageForVerdict(ev, scores, recommended) {
  state.verdict = ev;
  setStep("verdict");
  setSpeaker(null);
  $("#caption").hidden = true;
  $("#cruxes").hidden = true;
  state.links = [];
  drawLinks();
  $("#stage").classList.remove("live");
  updateOptions(scores, recommended);
  finishView("done");
}

function showVerdictSheet() {
  const dialog = $("#verdictSheet");
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  $("#verdictHeading").focus({ preventScroll: true });
}

function markVoteSkipped() {
  const step = $(".stepper [data-step=round3]");
  step.classList.add("skipped");
  step.setAttribute("aria-label", "Vote skipped");
}

function onVerdict(ev) {
  const v = ev.verdict;
  resetStageForVerdict(ev, v.scores, v.recommended);
  const seats = ev.seats;
  const mk = seatKey(v.minority.seat);
  const short = (t, n) => esc(shorten(clean(t || ""), n));
  const html = `
    <div class="v-top">
      <div><h2 class="label" id="verdictHeading" tabindex="-1">The council's verdict</h2><span class="v-label ${labelClass(v.label)}">${esc(v.label)}</span></div>
      <div class="actions"><button class="pill" type="button" data-pdf>Download PDF</button><button class="ghost" data-close>Back to the table</button></div>
    </div>
    <p class="v-call">${esc(v.call)}</p>
    <div class="v-grid">
      <div class="v-sec"><h3>Scores</h3><div class="v-opts">${state.options.map((o) => `
        <div class="opt ${o.id === v.recommended ? "lead" : ""}"><span class="id">${o.id}</span><span class="label">${esc(o.label)}</span><span class="val">${v.scores[o.id]?.score ?? "-"}</span><span class="bar"><i style="width:${(v.scores[o.id]?.score || 0) * 10}%"></i></span></div>`).join("")}</div>
        <p class="v-meta">Confidence ${v.confidence ?? "-"}/10${v.votes ? ` · ${v.votes.endorse || 0} endorse, ${v.votes.amend || 0} amend, ${v.votes.dissent || 0} dissent` : ""}</p>
      </div>
      <div class="v-sec"><h3>Why</h3><ul class="v-why">${v.why.slice(0, 3).map((w) => { const k = seatKey(w.seat); return `<li>${k ? `<img class="av" src="${portrait(k)}" alt="">` : ""}<span>${short(w.point, 150)}</span></li>`; }).join("")}</ul></div>
      <div class="v-sec"><h3>Watch out</h3><div class="minority"><div class="who">${mk ? `<img class="av" src="${portrait(mk)}" alt="">` : ""}${esc(seatName(v.minority.seat))}</div><q>${short(v.minority.quote, 170)}</q></div></div>
      <div class="v-sec"><h3>Next steps</h3><ul class="v-steps">${v.next_steps.slice(0, 3).map((n) => `<li><b>${esc(n.when)}</b> ${short(n.action, 120)}</li>`).join("")}</ul>
        <p class="v-meta"><b>Kill it if:</b> ${short(v.kill_criteria, 140)}</p></div>
    </div>
    <details class="v-more"><summary>Full detail</summary>
      <div class="v-grid">
        <div class="v-sec"><h3>Where they fought</h3><ul>${v.fights.map((f) => `<li><b>${esc(f.crux)}</b> ${esc(f.story)}</li>`).join("")}</ul></div>
        <div class="v-sec"><h3>Conditions</h3><ol>${v.conditions.map((c) => `<li>${esc(c)}</li>`).join("")}</ol></div>
        <div class="v-sec v-wide"><h3>Scorecard</h3>
          <table class="scorecard"><thead><tr><th>Seat</th><th>Weight</th>${state.options.map((o) => `<th>${o.id}</th>`).join("")}<th>Their line</th></tr></thead><tbody>
          ${seats.map((x) => { const s = state.byKey[x.key]; return `<tr><td><span class="who"><img class="av" src="${portrait(x.key)}" alt="">${esc(s.short)}</span></td><td class="n">${x.weight}</td>${state.options.map((o) => `<td class="n">${x.optionScores?.[o.id] ?? "-"}</td>`).join("")}<td class="line">${short(x.oneLine, 150)}</td></tr>`; }).join("")}
          </tbody></table>
          <p class="muted" style="font-size:11.5px;margin-top:8px">Weighted by how much each pillar matters here. ${state.options.map((o) => `${o.id}: ${esc(v.scores[o.id]?.math || "")}`).join(" · ")}</p></div>
        <div class="v-sec"><h3>Cheapest test</h3><p>${esc(v.cheapest_test)}</p><h3>Revisit</h3><p>${esc(v.revisit)}</p></div>
        <div class="v-sec"><h3>The strongest objection in full</h3><p>${esc(v.minority.quote)}</p><p class="muted">For this to be right: ${esc(v.minority.would_have_to_be_true)}</p></div>
        ${v.amendments?.length ? `<div class="v-sec v-wide"><h3>Amendments</h3><ul>${v.amendments.map((a) => `<li><b>${esc(seatName(a.seat))}:</b> ${esc(a.amendment)} <span class="tag">${a.adopted ? "Adopted" : "Not adopted"}: ${esc(a.reason)}</span></li>`).join("")}</ul></div>` : ""}
      </div>
    </details>
    <div class="v-foot"><span class="muted">${esc(v.disclaimer)}</span><button class="ghost" data-close>Back to the table</button></div>`;
  $("#verdictBody").innerHTML = html;
  const plate = $("#plate");
  plate.hidden = false;
  plate.innerHTML = `<div class="label">The council's verdict</div><span class="v-label ${labelClass(v.label)}">${esc(v.label)}</span><p>${esc(firstSentences(clean(v.call), 150))}</p><div class="row"><button type="button" id="plateOpen">Read the verdict</button><button type="button" data-pdf>Download PDF</button><button type="button" class="alt" id="plateReplay">Replay this council</button></div>`;
  $("#plateOpen").addEventListener("click", showVerdictSheet);
  $("#plateReplay").addEventListener("click", () => replay(state.session));
  $("#playbar").hidden = true;
  const f = document.createElement("div");
  f.className = "feed-note";
  f.innerHTML = `<b>Verdict: ${esc(v.label)}.</b> ${esc(firstSentences(clean(v.call), 160))}`;
  feedAppend(f);
  setTimeout(() => { if (state.verdict === ev) showVerdictSheet(); }, 1600);
}

function onCodexVerdict(ev) {
  const decision = ev.decision;
  state.decision = decision;
  const report = buildDecisionReport(decision);
  if (decision.ratificationStatus === "not_run") markVoteSkipped();
  resetStageForVerdict(ev, decision.scores, report.recommended);
  const verdict = `<span class="v-label ${labelClass(report.label)}">${esc(report.label)}</span>`;
  const list = (items) => items.map((item) => `<li>${esc(item)}</li>`).join("");
  const sourceDrawers = report.evidence.map((evidence) => `<h4>${esc(evidence.name)}</h4>${renderSeatSources(evidence)}`).join("");
  const scoreRows = report.scores.map((option) => `
    <div class="opt ${option.recommended ? "lead" : ""}" data-result-option="${esc(option.id)}" title="${esc(option.math)}">
      <span class="id">${esc(option.id)}</span><span class="label">${esc(option.label)}${option.recommended ? " · Recommended" : ""}</span>
      <span class="val">${esc(option.display)}</span><span class="bar" aria-hidden="true"><i style="width:${option.score * 10}%"></i></span>
    </div>`).join("");
  const conditions = [
    ...report.overrides.map(({ message }) => message), ...report.conditions,
    ...report.mitigations.map(({ option, description }) => `Option ${option} · ${description}`),
    ...(report.prerequisite ? [`${report.prerequisite.trigger} · Due ${report.prerequisite.deadline} · If unmet, ${report.prerequisite.failure}`] : []),
  ];
  const actions = [
    ...report.actions.map(({ when, action }) => [when, action].filter(Boolean).join(" · ")),
    ...report.pillars.filter(({ repair }) => repair).map(({ name, score, repair }) => `${name} · Pillar ${score}/10 · ${repair}`),
    ...report.stopConditions.map((condition) => `Stop if ${condition}`),
    ...(report.reviewDate ? [`Review · ${report.reviewDate}`] : []),
  ];
  const test = report.cheapestTest;
  const dissent = report.dissent;
  $("#verdictBody").innerHTML = `
    <div class="v-top">
      <div><h2 class="label" id="verdictHeading" tabindex="-1">The council's verdict</h2>${verdict}</div>
      <div class="verdict-actions">
        <button class="ghost" type="button" data-pdf>Download PDF</button>
        <a class="ghost" href="${sessionPath(state.session)}/report.md" download>Download Markdown</a>
        <button class="ghost" type="button" data-close>Back to the table</button>
      </div>
    </div>
    <p class="recommended-option"><small class="label">Recommended option ${esc(report.recommended)}</small>${esc(report.optionLabel)}</p>
    <p class="v-call">${esc(report.recommendation)}</p>
    <div class="v-stats">
      <span data-ratification>${esc(report.ratification)}</span><span>Score band ${esc(report.scoreBand)}</span>
      <span>Confidence ${esc(report.confidence)}/10</span><span>Spread ${esc(report.spread)}</span>
      ${report.support != null ? `<span>Draft support ${esc(report.support)}/10</span>` : ""}
    </div>
    <div class="v-grid priority-grid">
      <section class="v-sec"><h3>${dissent?.caveat ? "Strongest caveat" : "Strongest dissent"}</h3>
        ${dissent ? `<p><b>${esc(dissent.name)}</b></p><p data-dissent>${esc(dissent.statement)}</p><p class="muted">What would change the assessment · ${esc(dissent.whatWouldChange)}</p>`
      : "<p>The council recorded no unresolved dissent.</p>"}
      </section>
      <section class="v-sec"><h3>Cheapest experiment</h3>
        ${test ? `<p data-experiment>${esc(test.action)}</p><p class="muted">Cost · ${esc(test.cost)}</p><p>Success threshold · ${esc(test.success)}</p>` : ""}
        ${report.cheapTestRequired ? "<p><b>Required before proceeding.</b></p>" : ""}
      </section>
    </div>
    <section class="v-sec decision-scores"><h3>Weighted option scores</h3><div class="v-opts">${scoreRows}</div></section>
    ${conditions.length ? `<section class="v-sec decision-conditions"><h3>Verdict conditions</h3><ul>${list(conditions)}</ul></section>` : ""}
    <div class="decision-details">
      ${report.reasons.length || report.cruxes.length ? `<details class="result-detail"><summary>Reasons and disagreements</summary>
        <div class="v-sec"><ul>${list([...report.reasons.map(({ name, point }) => `${name ? `${name} · ` : ""}${point}`), ...report.cruxes.map(({ question }) => question)])}</ul></div></details>` : ""}
      ${actions.length ? `<details class="result-detail"><summary>Actions and review</summary><div class="v-sec"><ul>${list(actions)}</ul></div></details>` : ""}
      <details class="result-detail"><summary>Advisor scorecard</summary>
        <div class="scorecard-scroll"><table class="scorecard"><thead><tr><th>Advisor</th><th>Weight</th>
          ${report.scores.map(({ id }) => `<th>${esc(id)}</th>`).join("")}${report.votes ? "<th>Vote</th>" : ""}
        </tr></thead><tbody>${report.scorecard.map((row) => `<tr><td>${esc(row.name)}</td><td title="${esc(row.reason)}">${esc(row.weight)}</td>
          ${row.scores.map((score) => `<td>${esc(score ?? "–")}</td>`).join("")}${report.votes ? `<td>${esc(row.vote)}</td>` : ""}</tr>`).join("")}</tbody></table>
        <ul class="source-gaps">${list(report.scores.map(({ id, math }) => `${id} · ${math}`))}</ul></div>
      </details>
      <details class="result-detail"><summary>Evidence appendix</summary><div>${sourceDrawers}</div></details>
      <details class="result-detail"><summary>Session record</summary><div class="v-sec">
        ${report.brief ? `<p>${esc(report.brief)}</p>` : ""}
        ${report.context ? `<p>${esc(report.context)}</p>` : ""}
        ${report.clarifications?.answer ? `<p><b>Clarification</b> · ${esc(report.clarifications.answer)}</p>` : ""}
        <ul>${list([...report.assumptions, ...report.versions.map(([key, value]) => `${key} · ${value}`),
        ...(report.draftHash ? [`Draft · ${report.draftHash}`] : []),
        ...(report.votedHash ? [`Voted draft · ${report.votedHash}`] : [])])}</ul>
      </div></details>
    </div>`;
  const plate = $("#plate");
  plate.hidden = false;
  plate.innerHTML = `<div class="label">Recommended option ${esc(report.recommended)}</div>${verdict}
    <p>${esc(report.optionLabel)}</p><div class="row">
      <button type="button" id="plateOpen">Read the verdict</button>
      <button type="button" class="alt" id="plateReplay">Replay this council</button>
    </div>`;
  $("#plateOpen").addEventListener("click", showVerdictSheet);
  $("#plateReplay").addEventListener("click", () => replay(state.session));
  const note = document.createElement("div");
  note.className = "feed-note";
  note.textContent = `${report.label} · ${report.optionLabel}`;
  feedAppend(note);
  showVerdictSheet();
}

// ------------------------------------------------------------- history + replay
async function openHistory() {
  const dialog = $("#historyDialog");
  const list = $("#historyList");
  list.innerHTML = '<li class="muted" role="status">Loading sessions…</li>';
  if (!dialog.open) dialog.showModal();
  try {
    const { sessions } = await requestJson("/api/sessions");
    list.innerHTML = sessions.length
      ? sessions.map((s) => `<li><button type="button" data-id="${esc(s.id)}"><b>${esc(s.title)}</b><small>${esc(s.id.slice(0, 10))} · ${esc(s.mode)} · ${esc(s.status)}</small></button>${s.status === "done" ? `<button class="pdf" type="button" data-pdf="${esc(s.id)}" aria-label="Download PDF for ${esc(s.title)}">PDF</button>` : ""}</li>`).join("")
      : '<li class="muted">No sessions yet. Start a council in the room or in Codex.</li>';
    $("button[data-id]", list)?.focus({ preventScroll: true });
    $$("button[data-id]", list).forEach((b) => b.addEventListener("click", () => { dialog.close(); replay(b.dataset.id); }));
  } catch {
    list.innerHTML = '<li class="muted">The room couldn’t load past sessions. <button type="button" data-retry-history>Try again</button></li>';
    $("[data-retry-history]", list).addEventListener("click", openHistory);
  }
}

async function replay(id) {
  let session;
  try { session = await requestJson(sessionPath(id)); }
  catch (error) { return toast(error.message); }
  if (["running", "clarifying"].includes(session.status)) {
    attach(id, { control: ["browser", "codex", "demo"].includes(session.source) });
    return;
  }
  begin(id);
  state.replaying = true;
  const events = session.events.filter((event) => !["delta", "usage", "seat_error", "end"].includes(event.type));
  const verdict = events.findLastIndex((event) => event.type === "verdict");
  if (session.decision) {
    const final = { type: "verdict", decision: session.decision };
    if (verdict === -1) events.push(final);
    else events[verdict] = final;
  }
  if (!events.some((event) => event.type === "status" && event.status === session.status)) {
    events.push({ type: "status", status: session.status });
  }
  for (const event of events) player.push(event);
  player.push({ type: "end" });
}

// ------------------------------------------------------------- waiting on Codex
// A live council goes quiet for minutes while the seats write in parallel. Instead of a
// frozen table, say what is happening, how long it has been, and what each seat is weighing.
const SAME_TIME = "Cards appear together when every advisor has finished the round.";
function waitCopy(phase) {
  return {
    setup: ["Setting the table", "The Chair is seating the council.", ""],
    round1: ["Round 1 · Openings", "The advisors are writing their opening positions.", SAME_TIME],
    round2: ["Round 2 · Debate", "The advisors are reading each other's openings and firing back.", SAME_TIME],
    round3: ["Round 3 · Vote", "The advisors are voting on the Chair's proposal.", SAME_TIME],
    cruxes: ["Between rounds", "The Chair is reading the openings and finding where they disagree.", "The fight shows up here next, then the debate starts."],
    draft: ["Between rounds", "The Chair is turning the debate into a proposal for the vote.", "Next, every advisor votes on it."],
    skip3: ["Last step", "The Chair is scoring the room and writing the verdict.", "When it lands, you can download it as a PDF."],
    verdict: ["Last step", "The Chair is scoring the room and writing the verdict.", "When it lands, you can download it as a PDF."],
  }[phase] || ["Working", "The council is working.", ""];
}
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

function hideWait() {
  const w = $("#waitcard");
  if (w.hidden) return;
  w.hidden = true;
  $$(".seat.musing").forEach((e) => e.classList.remove("musing"));
  if (state.capWasShown) $("#caption").hidden = false;
  if (state.playbarWasShown) $("#playbar").hidden = false;
}

function tickWait() {
  const w = state.wait;
  const idle = !player.busy && !player.q.length;
  if (!w || !idle || state.replaying || !state.session || state.verdict) return hideWait();
  const card = $("#waitcard");
  if (card.hidden) {
    state.capWasShown = !$("#caption").hidden;
    $("#caption").hidden = true;
    $("#cruxes").hidden = true;
    // speed controls do nothing while the room waits, and they would cover the card
    state.playbarWasShown = !$("#playbar").hidden;
    $("#playbar").hidden = true;
    card.hidden = false;
    state.museAt = 0;
  }
  const [step, head, sub] = waitCopy(w.phase);
  const elapsed = Date.now() - w.at;
  $("#wcStep").textContent = step;
  $("#wcTime").textContent = clock(elapsed);
  $("#wcHead").textContent = head;
  $("#wcSub").textContent = sub;
  $("#wcNudge").hidden = elapsed < 4 * 60 * 1000;
  const round = Number((w.phase.match(/^round(\d)$/) || [])[1]) || 0;
  const bar = $("#wcBar").parentElement;
  const muse = $("#wcMuse");
  if (round) {
    const seats = state.active.length ? state.active : state.table;
    const done = state.progress[round] ?? seats.filter((k) => state.cards[round][k]).length;
    bar.classList.toggle("indeterminate", done === 0);
    $("#wcBar").style.width = done ? Math.round((done / seats.length) * 100) + "%" : "";
    // every few seconds, show what one of the still-thinking seats is weighing
    const pending = seats.filter((k) => !state.cards[round][k]);
    if (pending.length && Date.now() - (state.museAt || 0) > 5200) {
      state.museAt = Date.now();
      state.museIdx = ((state.museIdx ?? -1) + 1) % pending.length;
      const s = state.byKey[pending[state.museIdx]];
      muse.classList.add("fade");
      setTimeout(() => {
        if (state.wait !== w) return;
        muse.innerHTML = "<b>" + esc(s.short) + "</b> is weighing " + esc(s.question.replace(/^./, (c) => c.toLowerCase())) + (done ? " · " + done + " of " + seats.length + " ready" : "");
        muse.classList.remove("fade");
        $$(".seat").forEach((el) => el.classList.toggle("musing", el.dataset.seat === s.key));
      }, 300);
    }
  } else {
    bar.classList.add("indeterminate");
    $("#wcBar").style.width = "";
    muse.textContent = "";
    $$(".seat.musing").forEach((e) => e.classList.remove("musing"));
  }
}

function openGuide() {
  $("#guideBody").innerHTML = GUIDE;
  $("h4", $("#guideBody")).id = "guideHeading";
  const d = $("#guideDialog");
  if (!d.open) d.showModal();
}

// ------------------------------------------------------------- PDF
async function savePdf(btn) {
  const id = btn.dataset.pdf || state.session;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Making PDF...";
  try {
    const session = await requestJson(sessionPath(id));
    if (session.decision) return await downloadDecisionPdf({ decision: session.decision });
    const setup = session.events.find((event) => event.type === "setup");
    const verdict = session.events.findLast((event) => event.type === "verdict");
    if (!setup || !verdict) throw new Error("This council has no verdict yet.");
    await downloadVerdictPdf({ setup, verdict, byKey: state.byKey, id });
  } catch (e) {
    console.error(e);
    toast("Couldn't make the PDF: " + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// ------------------------------------------------------------- misc
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}
boot();
