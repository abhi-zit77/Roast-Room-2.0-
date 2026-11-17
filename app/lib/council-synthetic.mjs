const OPTIONS = [
  { label: "Build a reusable customer portal", statusQuo: false },
  { label: "Sell a small manual pilot", statusQuo: false },
  { label: "Continue the existing service", statusQuo: true },
];

const SAMPLE_PREFERENCE = ["bezos", "graham", "hormozi", "buffett", "martell", "naval"];
const ASSESSORS = {
  A: "A full build creates exposure before there is a paid buyer.",
  B: "A manual pilot still consumes delivery time and may have a thin margin.",
  C: "Continuing the service alone may leave the opportunity untested.",
};

/** Scripted data for the labelled synthetic demo and local integration tests. */
export function createSyntheticGenerator({ clarify = false } = {}) {
  return async ({ stage, prompt, signal }) => {
    signal?.throwIfAborted();
    const data = JSON.parse(prompt.split("\nDATA_JSON\n").at(-1));
    if (stage === "intake") {
      const available = data.roster.map(({ key }) => key);
      const relevant = [...new Set([...SAMPLE_PREFERENCE.filter((key) => available.includes(key)), ...available])];
      const keys = data.seats.length ? data.seats : relevant.slice(0, data.mode === "quick" ? 4 : 6);
      return {
        title: "Synthetic demo: pilot before the portal",
        decision: "Pick a way to test paid demand for a customer portal.",
        options: OPTIONS,
        assumptions: ["The scenario, budget, and customer interest are synthetic."],
        questions: clarify && data.clarifications === null ? ["How many hours can the synthetic founder spend on the test?"] : [],
        board: keys.map((seat, index) => ({ seat, weight: index === 0 ? 3 : index === 1 ? 2 : 1,
          reason: data.roster.find(({ key }) => key === seat).dimension })),
      };
    }
    if (stage === "cruxes") {
      return { cruxes: [{ question: "Is there enough paid demand to justify building a portal?",
        sides: [{ position: "Test a paid pilot before a build.", seats: data.openings.map(({ seat }) => seat) }],
        claimIds: data.openings.slice(0, 2).map(({ claims }) => claims[0].id) }] };
    }
    if (stage === "draft" || stage === "final_plan") {
      const option = data.recommended;
      return {
        option, recommendation: `Choose ${data.brief.options.find(({ id }) => id === option).label.toLowerCase()}. Check paid demand before allocating more founder time.`,
        reasons: data.cards.slice(0, 2).map(({ seat, headline }) => ({ seat, point: headline })),
        conditions: ["Keep the experiment inside a two-hour delivery budget."],
        mitigations: [{ id: "time-cap", option, description: "Stop at two hours and commit no fixed spending." }],
        actions: [{ when: "This week", action: "Send a fixed-scope offer to two qualified prospects." },
          { when: "In one week", action: "Review signed offers and the time required to deliver." }],
        cheapestTest: { action: "Offer two prospects a manually delivered paid pilot.", cost: "Two hours and no fixed spend", success: "At least one signed pilot" },
        stopConditions: ["Stop if neither prospect accepts or the delivery budget would be exceeded."],
        reviewDate: "Seven days after sending the offer", prerequisite: null,
      };
    }
    const key = data.seat.key;
    const skeptical = key === "buffett";
    const scores = skeptical ? { A: 4, B: 6, C: 8 } : { A: 5, B: 9, C: 6 };
    const card = {
      seat: key, preferredOption: skeptical ? "C" : "B",
      headline: skeptical ? "Protect the hours already paying for the existing business." : "Sell the outcome before building a reusable portal.",
      frameworksUsed: [],
      assessments: data.brief.options.map(({ id }) => ({ option: id, score: scores[id], pillarScore: scores[id] >= 5 ? 7 : 5,
        confidence: 4, ruinRisk: skeptical && id === "A" ? "likely" : "possible", door: "two-way", risk: ASSESSORS[id], repair: "" })),
      claims: [{ option: "B", kind: "inference", statement: skeptical ? "A low-margin pilot can displace existing paid work." : "A signed pilot is a direct signal of willingness to pay.",
        evidenceIds: [], counterevidenceIds: [], whatWouldChange: "One paid customer within the stated delivery budget." }],
      quotes: [],
    };
    if (stage === "rebuttal") {
      const target = data.openings.find(({ seat }) => seat !== key);
      card.rebuttal = { targetClaimId: target.claims[0].id, restatement: target.claims[0].statement,
        response: "Require a paid commitment and hold the time cap fixed.", concession: "A manual experiment still consumes founder time.",
        changed: "The deciding fact is whether a paid offer fits that cap.", alternativeCase: "The current workflow protects cash while evidence is sparse." };
    }
    if (stage === "vote") Object.assign(card, { draftHash: data.draftHash, vote: skeptical && data.draft.option === "B" ? "dissent" : "endorse",
      support: skeptical ? 6 : 8, comment: skeptical ? "An accepted quote can still hide a poor delivery margin." : "Use the fixed-scope experiment with a stop condition.", acceptedMitigations: [] });
    return card;
  };
}
