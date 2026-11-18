import { createHash } from "node:crypto";

export const SCORE_VERSION = 1;
const BANDS = ["DON'T DO IT", "RESHAPE", "GO WITH CONDITIONS", "GO"];

export const pointsValid = (value) => typeof value === "number" && value >= 0 && value <= 10 && Number.isInteger(value * 10);
export const assessmentOf = (card, option) => card.assessments.find((assessment) => assessment.option === option);

// Integer tenths keep weighted ties and rounding boundaries independent of floating-point division.
const nearestTenth = (numerator, denominator) => Math.floor((2 * numerator + denominator) / (2 * denominator)) / 10;
const tenths = (value) => Math.round(value * 10);

export function scoreRound({ options, weights, cards }) {
  const board = Object.entries(weights);
  const bySeat = new Map(cards.map((card) => [card.seat, card]));
  const validWeight = (weight) => Number.isInteger(weight) && weight >= 1 && weight <= 3;
  if (!board.length || !options.length || cards.length !== board.length ||
      board.some(([seat, { weight }]) => !bySeat.has(seat) || !validWeight(weight))) {
    throw new Error("Scoring requires complete cards and fixed board weights.");
  }
  const denominator = board.reduce((sum, [, { weight }]) => sum + weight, 0);
  const scores = Object.fromEntries(options.map(({ id }) => {
    const values = board.map(([seat, { weight }]) => [weight, assessmentOf(bySeat.get(seat), id)?.score]);
    if (values.some(([, value]) => !pointsValid(value))) throw new Error("Scoring requires complete option assessments.");
    const numerator = values.reduce((sum, [weight, value]) => sum + weight * tenths(value), 0);
    const score = nearestTenth(numerator, denominator);
    const display = score.toFixed(1);
    const math = `(${values.map(([weight, value]) => `${weight}×${value}`).join(" + ")}) / ${denominator} = ${display}`;
    return [id, { score, raw: numerator / (10 * denominator), display, math }];
  }));
  const ranked = [...options].sort((a, b) => scores[b.id].raw - scores[a.id].raw || Number(b.statusQuo) - Number(a.statusQuo));
  return { scores, recommended: ranked[0].id, denominator };
}

export function draftHash(plan) {
  const json = JSON.stringify(plan, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

export function ruinFlags(rounds) {
  const flags = new Map();
  for (const { round, cards } of rounds) {
    for (const { card } of cards) {
      for (const assessment of card.assessments) {
        if (assessment.ruinRisk !== "likely") continue;
        const { seat } = card;
        const { option, risk } = assessment;
        const claim = card.claims.find((entry) => entry.option === option) || null;
        const key = `${seat}:${option}`;
        const flag = flags.get(key) ?? { seat, option, risk, claim, warnings: [] };
        if (!flag.warnings.some((warning) => warning.risk === risk)) flag.warnings.push({ round, risk, claimId: claim?.id || null });
        flags.set(key, flag);
      }
    }
  }
  return [...flags.values()];
}

export function optionMetrics(cards, option) {
  const ratings = cards.map((card) => assessmentOf(card, option));
  const scores = ratings.map((rating) => tenths(rating.score));
  const spread = (Math.max(...scores) - Math.min(...scores)) / 10;
  const confidence = Math.max(1, Math.min(10,
    Math.round(2 * ratings.reduce((sum, rating) => sum + rating.confidence, 0) / ratings.length) - Number(spread >= 5)));
  const oneWay = cards.some((card) => card.seat === "bezos" && assessmentOf(card, option).door === "one-way") ||
    ratings.filter((rating) => rating.door === "one-way").length > cards.length / 2;
  return { spread, confidence, oneWay };
}

export function requireExperiment(plan, cards) {
  const { spread, oneWay } = optionMetrics(cards, plan.option);
  return { ...plan, testIsPrecondition: Boolean(plan.testIsPrecondition || (oneWay && spread >= 4)) };
}

function strongestObjection({ cards, option, weights, flags, bound }) {
  const risk = [...flags].sort((a, b) => weights[b.seat].weight - weights[a.seat].weight)[0];
  if (risk) return { seat: risk.seat, statement: risk.risk, whatWouldChange: risk.claim?.whatWouldChange || "A named mitigation accepted by this advisor.", claimId: risk.claim?.id || null, caveat: false };
  const ranked = cards.map((card) => {
    const onOption = assessmentOf(card, option);
    const gap = Math.max(...card.assessments.map((assessment) => tenths(assessment.score))) - tenths(onOption.score);
    return { card, onOption, gap, votedAgainst: bound && card.vote === "dissent" };
  }).sort((a, b) => Number(b.votedAgainst) - Number(a.votedAgainst) || b.gap - a.gap ||
    a.onOption.score - b.onOption.score || weights[b.card.seat].weight - weights[a.card.seat].weight);
  const { card, onOption, gap, votedAgainst } = ranked[0];
  const claim = card.claims.find((entry) => entry.option === option);
  return {
    seat: card.seat,
    statement: (votedAgainst && card.comment) || onOption.risk || claim?.statement || card.headline,
    whatWouldChange: claim?.whatWouldChange || card.claims[0].whatWouldChange,
    claimId: claim?.id || null,
    caveat: !votedAgainst && gap === 0,
  };
}

export function finalizeDecision({ setup, rounds, plan, votedDraft = null, cruxes, brief, evidence, profiles }) {
  const cards = rounds.at(-1).cards.map(({ card }) => card);
  const { scores, recommended, denominator } = scoreRound({ options: setup.options, weights: setup.weights, cards });
  if (plan.option !== recommended) throw new Error("The final plan must match the leading option.");
  const currentPlan = requireExperiment(plan, cards);
  const hash = draftHash(currentPlan);
  const option = setup.options.find(({ id }) => id === recommended);
  const { spread, confidence, oneWay } = optionMetrics(cards, recommended);
  const score = scores[recommended].score;
  const band = score >= 7.5 ? 3 : score >= 6 ? 2 : score >= 4.5 ? 1 : 0;
  if (votedDraft && votedDraft.hash !== draftHash(votedDraft.plan)) throw new Error("The voted draft does not match its recorded hash.");
  const bound = Boolean(votedDraft && votedDraft.hash === hash);
  const votes = votedDraft ? { endorse: 0, amend: 0, dissent: 0, ballots: [] } : null;
  let support = null;
  if (votes) {
    for (const { seat, vote, support: value, comment, draftHash: ballotHash } of cards) {
      if (ballotHash !== votedDraft.hash || !Object.hasOwn(votes, vote) || vote === "ballots" || !pointsValid(value)) {
        throw new Error("Scoring requires a complete ballot on the voted draft.");
      }
      votes[vote] += 1;
      votes.ballots.push({ seat, vote, support: value, comment, draftHash: ballotHash });
    }
    support = nearestTenth(votes.ballots.reduce((sum, ballot) => sum + setup.weights[ballot.seat].weight * tenths(ballot.support), 0), denominator);
  }
  const ratificationStatus = !votes ? "not_run" : bound && votes.endorse > cards.length / 2 ? "ratified" : "unratified";
  const selectedFlags = ruinFlags(rounds).filter((flag) => flag.option === recommended);
  const accepted = [];
  const open = [];
  for (const flag of selectedFlags) {
    const approval = bound && cards.find((card) => card.seat === flag.seat)
      .acceptedMitigations.find(({ option: acceptedOption }) => acceptedOption === flag.option);
    const mitigation = approval && currentPlan.mitigations.find(({ id, option: coveredOption }) =>
      id === approval.mitigationId && coveredOption === flag.option);
    if (mitigation) accepted.push({ ...flag, mitigationId: mitigation.id });
    else open.push(flag);
  }
  const overrides = [];
  let severity = band;
  if (option.statusQuo) {
    severity = 0;
    overrides.push({ kind: "status_quo", message: "Keep the current course. It ranked first." });
  }
  if (open.length) {
    severity = Math.min(severity, 1);
    for (const flag of open) overrides.push({ kind: "ruin", seat: flag.seat, message: flag.risk });
  }
  if (oneWay && spread >= 4) {
    severity = Math.min(severity, 2);
    overrides.push({ kind: "one_way", message: "A one-way decision with this spread requires the experiment before commitment." });
  }
  if (ratificationStatus === "unratified") {
    severity = Math.min(severity, 2);
    overrides.push({ kind: "unratified", message: bound ? "A majority did not endorse this draft as written." : "Earlier votes apply to a different draft." });
  }
  let label = BANDS[severity];
  if (currentPlan.prerequisite && severity >= 2) {
    label = "WAIT";
    overrides.push({ kind: "prerequisite", message: currentPlan.prerequisite.trigger });
  }
  const pillars = cards.map((card) => {
    const { pillarScore, repair } = assessmentOf(card, recommended);
    return { seat: card.seat, score: pillarScore, repair: pillarScore <= 4 ? repair : "" };
  });
  return {
    schemaVersion: 1, protocolVersion: 1, scoringVersion: SCORE_VERSION, promptVersion: 2,
    title: setup.title, mode: setup.mode, setup, brief, rounds, roundsCompleted: rounds.length, cruxes, evidence, profiles,
    plan: currentPlan, draftHash: hash, votedDraft, recommended, optionLabel: option.label, label, scoreBand: BANDS[band], scores,
    denominator, spread, confidence, support, votes, ratificationStatus, overrides, pillars,
    cheapTestRequired: currentPlan.testIsPrecondition,
    strongestDissent: strongestObjection({ cards, option: recommended, weights: setup.weights, flags: open, bound }),
    ruin: { open, accepted },
    disclaimer: "Advisor responses and scores are simulations. Quotation checks verify wording against the stored transcript.",
  };
}
