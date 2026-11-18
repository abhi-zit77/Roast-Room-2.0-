const asText = (value) => value == null ? "" : String(value);
const asList = (value) => Array.isArray(value) ? value : [];
export const escapeHtml = (value) => asText(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const markdown = (value) => asText(value).replace(/\\/g, "\\\\")
  .replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char])
  .replace(/[[\]*_`|]/g, "\\$&").replace(/\s*\r?\n\s*/g, " ");

function timecode(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = String(Math.floor((whole % 3600) / 60)).padStart(hours ? 2 : 1, "0");
  return `${hours ? `${hours}:` : ""}${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

function videoLink(source) {
  if (typeof source.startSeconds !== "number" || source.startSeconds < 0 || !Number.isFinite(source.startSeconds)) return "";
  let url;
  try { url = new URL(source.url); }
  catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
  const short = url.hostname === "youtu.be";
  if (!short && (!["www.youtube.com", "youtube.com", "m.youtube.com"].includes(url.hostname) || url.pathname !== "/watch")) return "";
  const videoId = short ? url.pathname.slice(1) : url.searchParams.get("v");
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || "")) return "";
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(source.startSeconds)}`;
}

/** The same presentation data feeds the browser, Markdown and PDF. Scores remain canonical. */
export function buildDecisionReport(decision) {
  const { setup = {}, profiles = {}, brief = {}, plan = {} } = decision;
  const name = (seat) => profiles[seat]?.name || seat;
  const seats = asList(setup.seats);
  const scores = asList(setup.options).map((option) => {
    const row = decision.scores[option.id];
    return { id: option.id, label: option.label, recommended: option.id === decision.recommended,
      display: row.display, score: row.score, math: row.math };
  });
  const round = asList(decision.rounds).at(-1);
  const scorecard = seats.map((seat) => {
    const entry = asList(round?.cards).find((item) => item.seat === seat);
    const ballot = asList(decision.votes?.ballots).find((item) => item.seat === seat);
    return { name: name(seat), seat, weight: setup.weights?.[seat]?.weight, reason: setup.weights?.[seat]?.reason,
      scores: scores.map(({ id }) => entry?.parsed?.optionScores?.[id]), vote: ballot?.vote };
  });
  const evidence = seats.map((seat) => {
    const references = new Set();
    const frameworks = new Set();
    const quotes = [];
    for (const round of asList(decision.rounds)) {
      const card = asList(round.cards).find((item) => item.seat === seat)?.card;
      for (const id of evidenceReferences(card)) references.add(id);
      for (const framework of asList(card?.frameworksUsed)) frameworks.add(framework);
      quotes.push(...asList(card?.quotes));
    }
    return buildSeatEvidence(seat, decision.evidence?.[seat], profiles[seat], references, [...frameworks], quotes);
  });
  const dissent = decision.strongestDissent?.statement
    ? { ...decision.strongestDissent, name: name(decision.strongestDissent.seat) } : null;
  const ratification = ({
    ratified: "Draft ratified", unratified: "Plan unratified", not_run: "Vote round skipped",
  })[decision.ratificationStatus] || "";
  const briefDetails = typeof brief === "string" ? { decision: brief, assumptions: asList(setup.assumptions) } : brief;
  const pillars = asList(decision.pillars).map((pillar) => ({ ...pillar, name: name(pillar.seat) }));
  return {
    title: decision.title, mode: decision.mode, roundsCompleted: decision.roundsCompleted,
    brief: briefDetails.decision || setup.decision || "", assumptions: asList(briefDetails.assumptions ?? setup.assumptions),
    context: briefDetails.context, clarifications: briefDetails.clarifications,
    label: decision.label, scoreBand: decision.scoreBand, scores, scorecard, pillars,
    optionLabel: decision.optionLabel, recommended: decision.recommended,
    recommendation: plan.recommendation, planOption: plan.option, dissent,
    cheapestTest: plan.cheapestTest, cheapTestRequired: decision.cheapTestRequired,
    spread: decision.spread, confidence: decision.confidence, support: decision.support, votes: decision.votes,
    ratification, overrides: asList(decision.overrides), draftHash: decision.draftHash, votedHash: decision.votedDraft?.hash,
    reasons: asList(plan.reasons).map((reason) => ({ ...reason, name: name(reason.seat) })),
    conditions: asList(plan.conditions), mitigations: asList(plan.mitigations), actions: asList(plan.actions),
    stopConditions: asList(plan.stopConditions), reviewDate: plan.reviewDate, prerequisite: plan.prerequisite,
    cruxes: asList(decision.cruxes?.cruxes ?? decision.cruxes),
    evidence,
    versions: [
      ["Schema", decision.schemaVersion], ["Protocol", decision.protocolVersion], ["Scoring", decision.scoringVersion],
      ["Prompts", decision.promptVersion], ["Runtime", decision.runtime?.provider], ["Codex CLI", decision.runtime?.cliVersion],
      ["Model", decision.runtime?.model], ["Upstream", decision.upstreamRevision],
    ].filter(([, version]) => version != null),
  };
}

export function buildSeatEvidence(seat, packet, profile, references, frameworks = [], quotes = []) {
  const passages = asList(packet?.passages).map((source) => {
    const withdrawn = Boolean(source.withdrawn || source.withdrawnAt);
    const speaker = source.speakerStatus === "verified"
      ? (source.advisorAttribution ? `Verified · ${source.speaker}` : `Verified other speaker · ${source.speaker}`)
      : "Speaker unverified";
    return {
      id: source.id,
      title: source.title || `YouTube video ${source.videoId || source.sourceId || ""}`.trim(),
      speaker, withdrawn,
      url: withdrawn ? "" : videoLink(source),
      text: withdrawn ? "" : source.text,
      directQuotes: !withdrawn && source.advisorAttribution && source.speakerStatus === "verified"
        ? [...new Set(quotes.filter(({ evidenceId }) => evidenceId === source.id).map(({ text }) => text))] : [],
      publishedAt: source.publishedAt || "",
      metadata: source.metadataStatus === "ok" ? "" : "Metadata unavailable",
      time: timecode(source.startSeconds),
      endTime: timecode(source.endSeconds),
      cited: references?.has(source.id) || false,
    };
  });
  const available = passages.some((source) => !source.withdrawn);
  let status = "Stored frameworks only";
  if (passages.some((source) => source.cited && !source.withdrawn)) status = "Transcript evidence cited";
  else if (passages.some((source) => source.cited && source.withdrawn)) status = "Transcript evidence withdrawn";
  else if (available) status = references ? "Stored frameworks only · transcript evidence available" : "Transcript evidence available";
  return { seat, name: profile?.name || seat, version: profile?.version, status, notProvided: !packet,
    gaps: asList(packet?.gaps), passages, frameworks };
}

export function evidenceReferences(card) {
  const ids = new Set(asList(card?.quotes).map((quote) => quote.evidenceId));
  for (const claim of asList(card?.claims)) {
    for (const id of [...asList(claim.evidenceIds), ...asList(claim.counterevidenceIds)]) ids.add(id);
  }
  return ids;
}

export function sourceDetails(source) {
  return [source.withdrawn ? "Withdrawn" : source.speaker, source.metadata,
    source.publishedAt, source.cited ? "Cited in the council" : ""].filter(Boolean).join(" · ");
}

export function renderSeatSources(evidence, claims = []) {
  if (!evidence || evidence.notProvided) return "";
  const kindLabels = {
    inference: "Advisor inference", source_summary: "Source summary", business_fact: "Business fact",
    assumption: "Assumption", unknown: "Unknown", framework_application: "Framework application",
  };
  const cite = (ids) => asList(ids).map((id) => evidence.passages.find((source) => source.id === id))
    .filter(Boolean).map((source) => source.url
      ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title)} · ${escapeHtml(source.time)}</a>`
      : `${escapeHtml(source.title)}${source.withdrawn ? " · Withdrawn" : ""}`).join(", ");
  const claimMarkup = asList(claims).flatMap((claim) => {
    const sources = cite(claim.evidenceIds);
    const counter = cite(claim.counterevidenceIds);
    if (!sources && !counter) return [];
    const kind = kindLabels[claim.kind];
    return [`<li>${kind ? `<span class="source-meta">${escapeHtml(kind)} · </span>` : ""}<b>${escapeHtml(claim.statement)}</b>${sources ? `<div>Evidence · ${sources}</div>` : ""}${counter ? `<div>Counterevidence · ${counter}</div>` : ""}</li>`];
  }).join("");
  return `<details class="source-drawer">
    <summary>Sources <span>${escapeHtml(evidence.status)}</span></summary>
    <div class="source-detail">
      ${evidence.version ? `<p class="muted">Advisor knowledge <code>${escapeHtml(evidence.version)}</code></p>` : ""}
      ${evidence.frameworks.length ? `<p class="muted">Frameworks applied · ${escapeHtml(evidence.frameworks.join(", "))}</p>` : ""}
      ${evidence.gaps.length ? `<ul class="source-gaps">${evidence.gaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join("")}</ul>` : ""}
      ${evidence.passages.length ? `<ul class="sources">${evidence.passages.map((source) => `
        <li class="source-entry${source.withdrawn ? " withdrawn" : ""}">
          <div class="source-title"><b>${escapeHtml(source.title)}</b>
            ${source.url ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">Watch at ${escapeHtml(source.time)}</a>` : ""}
          </div>
          <p class="source-meta">${escapeHtml(sourceDetails(source))}</p>
          ${source.text ? `<blockquote>${escapeHtml(source.text)}</blockquote>` : ""}
          ${source.directQuotes.map((quote) => `<p class="source-quote"><b>Direct quotation</b> · <q>${escapeHtml(quote)}</q></p>`).join("")}
        </li>`).join("")}</ul>` : ""}
      ${claimMarkup ? `<ul class="source-claims">${claimMarkup}</ul>` : ""}
    </div>
  </details>`;
}

export function renderDecisionMarkdown(decision) {
  const r = buildDecisionReport(decision);
  const out = [`# ${markdown(r.title)}`, "", `**Verdict** ${markdown(r.label)}`,
    `**Recommended option** ${markdown(r.recommended)} · ${markdown(r.optionLabel)}`, "",
    markdown(r.recommendation), "", `**${markdown(r.ratification)}**`];
  const section = (heading, items) => {
    if (items.length) out.push("", `## ${heading}`, "", ...items);
  };
  section(r.dissent?.caveat ? "Strongest caveat" : "Strongest dissent", r.dissent ? [
    `**${markdown(r.dissent.name)}** · ${markdown(r.dissent.statement)}`, "",
    `**What would change the assessment** ${markdown(r.dissent.whatWouldChange)}`,
    ...(r.dissent.claimId ? [`Claim ID \`${markdown(r.dissent.claimId)}\``] : []),
  ] : ["The council recorded no unresolved dissent."]);
  section("Cheapest experiment", r.cheapestTest ? [
    markdown(r.cheapestTest.action), "", `- Cost · ${markdown(r.cheapestTest.cost)}`,
    `- Success threshold · ${markdown(r.cheapestTest.success)}`,
    ...(r.cheapTestRequired ? ["- Required before proceeding."] : []),
  ] : []);
  section("Weighted option scores", [
    "| Option | Description | Score | Outcome | Calculation |",
    "| --- | --- | ---: | --- | --- |",
    ...r.scores.map((row) => `| ${markdown(row.id)} | ${markdown(row.label)} | ${markdown(row.display)} | ${row.recommended ? "Recommended" : ""} | ${markdown(row.math)} |`),
    "", `Score band ${r.scoreBand} · Confidence ${r.confidence}/10 · Spread ${r.spread}`,
  ]);
  section("Verdict conditions", [
    ...r.overrides.map(({ message }) => `- ${markdown(message)}`),
    ...r.conditions.map((condition) => `- ${markdown(condition)}`),
    ...r.mitigations.map((item) => `- Option ${markdown(item.option)} · ${markdown(item.description)}`),
    ...(r.prerequisite ? [`- Prerequisite · ${markdown(r.prerequisite.trigger)} · Due ${markdown(r.prerequisite.deadline)} · If unmet, ${markdown(r.prerequisite.failure)}`] : []),
  ]);
  section("Reasons and disagreements", [
    ...r.reasons.map((reason) => `- ${markdown(reason.name)} · ${markdown(reason.point)}`),
    ...r.cruxes.map((crux) => `- ${markdown(crux.question)}`),
  ]);
  section("Actions and review", [
    ...r.actions.map(({ when, action }) => `- ${[when, action].filter(Boolean).map(markdown).join(" · ")}`),
    ...r.pillars.filter(({ repair }) => repair).map(({ name, score, repair }) => `- ${markdown(name)} · Pillar ${score}/10 · ${markdown(repair)}`),
    ...r.stopConditions.map((condition) => `- Stop if ${markdown(condition)}`),
    ...(r.reviewDate ? [`- Review · ${markdown(r.reviewDate)}`] : []),
  ]);
  section("Brief and assumptions", [
    markdown(r.brief), ...(r.context ? ["", markdown(r.context)] : []), "",
    ...r.assumptions.map((item) => `- ${markdown(item)}`),
    ...(r.clarifications ? ["", "**Clarifications**", "", ...asList(r.clarifications.questions).map((question) => `- ${markdown(question)}`),
      "", markdown(r.clarifications.answer)] : []),
  ]);
  section("Advisor scorecard", [
    `| Advisor | Weight | ${r.scores.map(({ id }) => markdown(id)).join(" | ")} | Vote |`,
    `| --- | ---: | ${r.scores.map(() => "---:").join(" | ")} | --- |`,
    ...r.scorecard.map((item) => `| ${markdown(item.name)} | ${item.weight ?? ""} | ${item.scores.map((score) => score ?? "").join(" | ")} | ${markdown(item.vote)} |`),
    "", ...r.scorecard.filter(({ reason }) => reason).map((item) => `- ${markdown(item.name)} · ${markdown(item.reason)}`),
  ]);
  section("Draft and votes", [
    `- ${r.ratification}`, ...(r.draftHash ? [`- Draft \`${markdown(r.draftHash)}\``] : []),
    ...(r.votedHash ? [`- Voted draft \`${markdown(r.votedHash)}\``] : []),
    ...(r.support == null ? [] : [`- Support for the voted draft ${r.support}/10`]),
    ...asList(r.votes?.ballots).map((ballot) => `- ${markdown(r.scorecard.find(({ seat }) => seat === ballot.seat)?.name || ballot.seat)} · ${markdown(ballot.vote)} · ${markdown(ballot.comment)}`),
  ]);
  section("Evidence appendix", r.evidence.flatMap((evidence) => [
    `### ${markdown(evidence.name)}`, "", markdown(evidence.status), "",
    ...(evidence.version ? [`Advisor knowledge \`${markdown(evidence.version)}\``, ""] : []),
    ...(evidence.frameworks.length ? [`Frameworks applied · ${markdown(evidence.frameworks.join(", "))}`, ""] : []),
    ...evidence.gaps.map((gap) => `- ${markdown(gap)}`),
    ...evidence.passages.flatMap((source) => {
      const link = source.url ? ` · [${source.time}](${source.url})` : "";
      return [`- ${markdown(source.title)}${link} · ${markdown(sourceDetails(source))}`,
        ...source.directQuotes.map((quote) => `  - Direct quotation · “${markdown(quote)}”`)];
    }), "",
  ]));
  section("Versions", r.versions.map(([key, version]) => `- ${key} \`${markdown(version)}\``));
  return out.join("\n").trimEnd() + "\n";
}
