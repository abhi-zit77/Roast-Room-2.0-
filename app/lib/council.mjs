import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "./env.mjs";

// Read-only compatibility for the upstream room's saved example and session formats.
export const DISCLAIMER = "Simulated advisors built from each person's public work. They are not the people and do not speak for them.";

export function subscribe(s, res) {
  for (const ev of s.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (s.status !== "running") { res.write(`data: ${JSON.stringify({ type: "end" })}\n\n`); return; }
  s.subs.add(res);
  res.on("close", () => s.subs.delete(res));
}

export function optionScores(st, round) {
  const out = {};
  for (const o of st.options) {
    let num = 0, den = 0;
    const parts = [];
    for (const k of st.seats) {
      const v = st.cards[round][k]?.parsed.optionScores[o.id];
      const w = st.weights[k].weight;
      if (typeof v === "number") { num += w * v; den += w; parts.push(`${w}x${v}`); }
    }
    out[o.id] = { score: den ? Math.round((num / den) * 10) / 10 : null, math: den ? `(${parts.join(" + ")}) / ${den}` : "" };
  }
  return out;
}

/** The verdict's numbers, computed from the last round's cards (shared with the folder watcher). */
export function finalNumbers(st) {
  const last = st.rounds.at(-1);
  const finalScores = st.scores[last] || optionScores(st, last);
  const recommended = Object.entries(finalScores).sort((a, b) => (b[1].score ?? 0) - (a[1].score ?? 0))[0][0];
  const fv = st.seats.map((k) => st.cards[last][k]?.parsed.optionScores[recommended]).filter((v) => typeof v === "number");
  const confs = st.seats.map((k) => st.cards[2][k]?.parsed.confidence ?? st.cards[1][k]?.parsed.confidence).filter((v) => typeof v === "number");
  const spreadF = fv.length ? Math.max(...fv) - Math.min(...fv) : 0;
  const confidence = confs.length ? Math.max(1, Math.min(10, Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 2) - (spreadF >= 5 ? 1 : 0))) : null;
  const support = last === 3 ? (() => {
    let n = 0, d = 0;
    for (const k of st.seats) { const v = st.cards[3][k]?.parsed.finalScore; if (typeof v === "number") { n += v * st.weights[k].weight; d += st.weights[k].weight; } }
    return d ? Math.round((n / d) * 10) / 10 : null;
  })() : null;
  const votes = last === 3 ? st.seats.reduce((acc, k) => { const v = st.cards[3][k]?.parsed.vote || "endorse"; acc[v] = (acc[v] || 0) + 1; return acc; }, {}) : null;
  return { last, finalScores, recommended, spreadF, confidence, support, votes };
}

export function verdictSeats(st, last) {
  return st.seats.map((k) => ({
    key: k, weight: st.weights[k].weight,
    stance: st.cards[last][k]?.parsed.vote || st.cards[2][k]?.parsed.stance,
    optionScores: st.cards[last][k]?.parsed.optionScores,
    pillar: st.cards[last][k]?.parsed.pillar ?? st.cards[2][k]?.parsed.pillar,
    moved: st.cards[2][k]?.parsed.moved,
    oneLine: st.cards[3][k]?.parsed.oneLine || st.cards[2][k]?.parsed.stance,
  }));
}

export function listSaved() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs.readdirSync(SESSIONS_DIR)
    .map((d) => path.join(SESSIONS_DIR, d, "events.json"))
    .filter((p) => fs.existsSync(p))
    .map((p) => { const j = JSON.parse(fs.readFileSync(p, "utf8")); return { id: j.id, title: j.title || j.prompt.slice(0, 60), prompt: j.prompt, mode: j.mode, status: j.status, file: p }; })
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

export function loadSaved(id) {
  const hit = listSaved().find((x) => x.id === id);
  return hit ? JSON.parse(fs.readFileSync(hit.file, "utf8")) : null;
}
