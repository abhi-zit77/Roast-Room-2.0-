import { assessmentOf, pointsValid } from "./council-rules.mjs";

const string = { type: "string" };
const number = { type: "number" };
const boolean = { type: "boolean" };
const enumeration = (...values) => ({ type: "string", enum: values });
const list = (items) => ({ type: "array", items });
const record = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

const assessment = record({
  option: string, score: number, pillarScore: number, confidence: { type: "integer" },
  ruinRisk: enumeration("none", "possible", "likely"), door: enumeration("one-way", "two-way"), risk: string, repair: string,
});
const claim = record({
  option: string, kind: enumeration("inference", "source_summary", "business_fact", "assumption", "unknown", "framework_application"),
  statement: string, evidenceIds: list(string), counterevidenceIds: list(string), whatWouldChange: string,
});
const card = {
  seat: string, preferredOption: string, headline: string, frameworksUsed: list(string),
  assessments: list(assessment), claims: list(claim), quotes: list(record({ evidenceId: string, text: string })),
};
const plan = record({
  option: string, recommendation: string, reasons: list(record({ seat: string, point: string })), conditions: list(string),
  mitigations: list(record({ id: string, option: string, description: string })), actions: list(record({ when: string, action: string })),
  cheapestTest: record({ action: string, cost: string, success: string }), stopConditions: list(string), reviewDate: string,
  prerequisite: { anyOf: [record({ trigger: string, deadline: string, failure: string }), { type: "null" }] },
});

export const SCHEMAS = {
  intake: record({
    title: string, decision: string, options: list(record({ label: string, statusQuo: boolean })),
    assumptions: list(string), questions: list(string), board: list(record({ seat: string, weight: { type: "integer" }, reason: string })),
  }),
  opening: record(card),
  cruxes: record({ cruxes: list(record({
    question: string, sides: list(record({ position: string, seats: list(string) })), claimIds: list(string),
  })) }),
  rebuttal: record({ ...card, rebuttal: record({
    targetClaimId: string, restatement: string, response: string, concession: string, changed: string, alternativeCase: string,
  }) }),
  draft: plan,
  vote: record({
    ...card, draftHash: string, vote: enumeration("endorse", "amend", "dissent"), support: number, comment: string,
    acceptedMitigations: list(record({ option: string, mitigationId: string })),
  }),
  final_plan: plan,
};

export class InvalidCouncilOutput extends Error {}
const check = (condition, reason) => { if (!condition) throw new InvalidCouncilOutput(reason); };

function conforms(value, schema) {
  if (schema.anyOf) return schema.anyOf.some((branch) => conforms(value, branch));
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === "null") return value === null;
  if (schema.type === "integer") return Number.isInteger(value);
  if (schema.type === "number") return Number.isFinite(value);
  if (schema.type === "array") return Array.isArray(value) && value.length <= 64 && value.every((item) => conforms(item, schema.items));
  if (schema.type === "object") return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === schema.required.length && schema.required.every((key) => Object.hasOwn(value, key) && conforms(value[key], schema.properties[key]));
  return typeof value === schema.type && (schema.type !== "string" || value.length <= 2000);
}

export function assertShape(value, stage) {
  check(conforms(value, SCHEMAS[stage]), "The result does not match all required schema fields and their types.");
}

const populated = (value) => Boolean(value.trim());
const short = (value) => populated(value) && value.length <= 300;
const nonemptyList = (items, max) => items.length > 0 && items.length <= max && items.every(populated);
const unique = (items) => new Set(items).size === items.length;
const inlineQuotation = /["“«][^"”»\n]+["”»]|‘[^’\n]+’|(?:^|[\s(])'[^'\n]+'(?=$|[\s,.!?;)])|(?:^|\n)\s*>\s*\S/u;
const noInlineQuote = (text) => !inlineQuotation.test(text);

export function validateIntake(value, { input, roster, answered }) {
  check(short(value.title) && populated(value.decision), "The brief needs a title and decision.");
  check(value.options.length >= 2 && value.options.length <= 4 && value.options.every(({ label }) => short(label)) &&
    unique(value.options.map(({ label }) => label.toLowerCase().replace(/\s+/g, " ").trim())) &&
    value.options.filter(({ statusQuo }) => statusQuo).length === 1,
  "Return two to four distinct options including exactly one explicit status quo.");
  check(value.assumptions.length <= 8 && value.assumptions.every(populated), "Keep assumptions concise and concrete.");
  check(value.questions.length <= 3 && value.questions.every(short) && (!answered || !value.questions.length),
    "After the clarification, state remaining gaps as assumptions and leave questions empty.");
  const keys = value.board.map(({ seat }) => seat);
  const range = input.mode === "quick" ? keys.length === 4 : keys.length >= 5 && keys.length <= 7;
  check(unique(keys) && keys.every((key) => roster.some(({ key: known }) => known === key)), "Use unique seat keys from the roster.");
  if (input.seats.length) {
    check(keys.length === input.seats.length && input.seats.every((seat) => keys.includes(seat)), "Keep every named seat and add no other seats.");
  } else {
    check(range, input.mode === "quick" ? "Quick mode needs four seats." : "A default full board needs five to seven seats.");
  }
  const mostRelevant = value.board.filter(({ weight }) => weight === 3).length;
  check(mostRelevant >= 1 && mostRelevant <= 2 && value.board.every(({ weight, reason }) => weight >= 1 && weight <= 3 && short(reason)),
    "Give every seat a weight of one to three and a relevance reason, with one or two seats at weight three.");
  return value;
}

export async function validateCard(value, { round, seat, options, evidence, priorClaims, alternative, draft, draftHash }) {
  const ids = options.map(({ id }) => id);
  check(value.seat === seat.key && ids.includes(value.preferredOption) && short(value.headline),
    "Use your own seat key, a listed preferred option, and a concrete headline.");
  check(value.frameworksUsed.length <= 3 && value.frameworksUsed.every(short), "Name at most three stored frameworks used.");
  check(value.assessments.length === ids.length && unique(value.assessments.map(({ option }) => option)) &&
    ids.every((id) => assessmentOf(value, id)), "Assess every option exactly once.");
  for (const a of value.assessments) {
    check(pointsValid(a.score) && pointsValid(a.pillarScore) && a.confidence >= 1 && a.confidence <= 5,
      "Give scores zero to ten with at most one decimal and confidence one to five.");
    check(populated(a.risk) && (a.pillarScore > 4 || populated(a.repair)), "Give each option a concrete risk and name a repair for any pillar scored at four or below.");
  }
  check(value.assessments.every(({ score }) => score <= assessmentOf(value, value.preferredOption).score),
    "The preferred option must earn one of your highest scores.");
  const passageIds = new Set(evidence.passages.map(({ id }) => id));
  check(value.claims.length >= 1 && value.claims.length <= 4 && value.claims.every((entry) => ids.includes(entry.option) &&
    populated(entry.statement) && populated(entry.whatWouldChange) &&
    (entry.kind !== "source_summary" || entry.evidenceIds.length > 0) &&
    [...entry.evidenceIds, ...entry.counterevidenceIds].every((id) => passageIds.has(id))),
  "Give one to four claims with a condition that would change each judgment. Cite only passage IDs from the supplied packet.");
  const prose = [value.headline, ...value.frameworksUsed, ...value.claims.flatMap(({ statement, whatWouldChange }) => [statement, whatWouldChange]),
    ...value.assessments.flatMap(({ risk, repair }) => [risk, repair])];
  check(value.quotes.length <= 3, "Use at most three attributed quotes.");
  if (value.quotes.length) {
    const { validateQuote } = await import("./evidence.mjs");
    for (const quote of value.quotes) {
      check(validateQuote(evidence, { evidenceId: quote.evidenceId, advisorId: seat.key, quote: quote.text }),
        "A quote must exactly match the named passage inside this advisor's verified speaker range. Paraphrase without attribution or remove it if the range is uncertain.");
    }
  }
  if (round === 2) {
    const rebuttal = value.rebuttal;
    check(priorClaims.some(({ id, seat: owner }) => id === rebuttal.targetClaimId && owner !== seat.key),
      "Address a real opening claim ID from a different seat.");
    check([rebuttal.restatement, rebuttal.response, rebuttal.concession, rebuttal.changed].every(populated) &&
      (!alternative?.seats.includes(seat.key) || populated(rebuttal.alternativeCase)),
    "Restate and answer the claim, concede what survives, explain whether you moved, and give the strongest case for the assigned alternative.");
    prose.push(rebuttal.restatement, rebuttal.response, rebuttal.concession, rebuttal.changed, rebuttal.alternativeCase);
  }
  if (round === 3) {
    check(value.draftHash === draftHash && pointsValid(value.support) && populated(value.comment),
      "Bind a complete, explicit vote and support score to the exact supplied draft hash.");
    check(unique(value.acceptedMitigations.map(({ option }) => option)) && value.acceptedMitigations.every(({ option, mitigationId }) =>
      draft.mitigations.some((mitigation) => mitigation.id === mitigationId && mitigation.option === option)),
    "Accept a mitigation only by citing its ID and matching option on this exact draft.");
    prose.push(value.comment);
  }
  check(prose.every(noInlineQuote), "Put verbatim quotations only in the quotes field. Paraphrase in all narrative fields.");
  return { ...value, claims: value.claims.map((entry, index) => ({ ...entry, id: `${seat.key}:r${round}:claim-${index + 1}` })) };
}

export function validateCruxes(value, { keys, priorClaims }) {
  check(value.cruxes.length >= 1 && value.cruxes.length <= 3 && value.cruxes.every(({ question, sides, claimIds }) =>
    short(question) && sides.length >= 1 && sides.length <= 3 && sides.every(({ position, seats }) =>
      populated(position) && seats.length > 0 && unique(seats) && seats.every((seat) => keys.includes(seat))) &&
    nonemptyList(claimIds, 8) && claimIds.every((id) => priorClaims.some((claim) => claim.id === id))),
  "Name one to three concrete cruxes, real opening claim IDs, and the seats on each side.");
  return value;
}

export function validatePlan(value, { recommended, keys, options }) {
  check(value.option === recommended && populated(value.recommendation), "Build only the leading option's plan.");
  check(value.reasons.length >= 1 && value.reasons.length <= 3 && value.reasons.every(({ seat, point }) => keys.includes(seat) && populated(point)),
    "Give one to three reasons tied to seated advisors.");
  check(value.conditions.length <= 8 && value.conditions.every(populated) && nonemptyList(value.stopConditions, 6),
    "Write concise conditions and at least one stop condition.");
  check(value.mitigations.length <= 8 && unique(value.mitigations.map(({ id }) => id)) && value.mitigations.every(({ id, option, description }) =>
    /^[a-z0-9][a-z0-9_-]{0,39}$/i.test(id) && options.some(({ id: known }) => known === option) && populated(description)),
  "Use unique mitigation IDs, listed options and concrete mitigation descriptions.");
  check(value.actions.length >= 1 && value.actions.length <= 3 && value.actions.every(({ when, action }) => short(when) && populated(action)) &&
    Object.values(value.cheapestTest).every(populated) && short(value.reviewDate),
  "Provide dated or timed actions, the cheapest test with its cost and success threshold, and a review date or interval.");
  check(!value.prerequisite || Object.values(value.prerequisite).every(populated), "A prerequisite needs its trigger, deadline and action on failure.");
  const prose = [value.recommendation, ...value.reasons.map(({ point }) => point), ...value.conditions,
    ...value.mitigations.map(({ description }) => description), ...value.actions.map(({ action }) => action),
    ...value.stopConditions, ...Object.values(value.cheapestTest), ...Object.values(value.prerequisite ?? {})];
  check(prose.every(noInlineQuote), "Paraphrase in the plan. Verified verbatim quotations belong in the cards.");
  return value;
}
