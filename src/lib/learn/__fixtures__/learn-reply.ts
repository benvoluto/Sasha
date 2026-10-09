// Test fixtures for src/lib/learn: two short example documents (invented, with
// invented personal details) and a model reply that learns a valid type,
// workflow and inferred requirement set from them. Used only by *.test.ts.

export const EXAMPLE_A = `# Equipment request

## Summary
The lab asks for a replacement centrifuge because the current unit failed its annual safety inspection last spring and cannot be repaired.

## Justification
Requested by Marisol Quintanilla Ortega for the teaching lab, who can be reached at marisol.q@example.org or (512) 555-0147. Without the unit, three practical sessions per week are cancelled.

## Costs
| Item | Amount |
| Centrifuge | 4,200 |
| Installation | 300 |
Total: 4,500.

## Approval
Signed by the department head.`;

export const EXAMPLE_B = `# Equipment request

## Summary
The workshop needs a bench grinder so that students can finish metal projects on site instead of sending parts away.

## Justification
Raised by the workshop lead at Riverbend Community College. Sending parts away adds two weeks to every project and costs more each term.

## Costs
Grinder 650, guards 120, total 770.

## Risks
Noise during exam weeks.

## Approval
Signed by the department head.`;

export const typeDraft = (over: Record<string, unknown> = {}) => ({
  key: "equipment-request",
  version: 1,
  title: "Equipment request",
  family: "business",
  summary: "A short internal request for a piece of equipment. It states what is needed, why, what it costs and who approves it.",
  signals: ["Equipment request", "Justification", "Costs", "Approval", "Total", "Signed by"],
  audience: "A department head deciding whether to fund the purchase.",
  tone: "Plain and factual.",
  preamble: "You write short internal equipment requests for a department head. Keep every section brief and concrete.",
  sections: [
    { key: "summary", heading: "Summary", order: 10, guidance: "Say in two sentences what is needed and what problem it solves.", elements: ["The item", "The problem it solves"] },
    { key: "justification", heading: "Justification", order: 20, guidance: "Explain the cost of not having the item: lost sessions, delays or risks.", elements: ["Who asks", "Impact without it"] },
    { key: "costs", heading: "Costs", order: 30, guidance: "List each cost line and the total; the lines must add up to the total.", elements: ["Cost lines", "Total"] },
    { key: "approval", heading: "Approval", order: 40, guidance: "Name the role that signs.", elements: ["Approver role", "Signature line"] },
  ],
  rubric: [
    {
      key: "costs_add_up",
      criterion: "The cost lines add up to the stated total.",
      appliesTo: ["costs"],
      levels: [
        { score: 2, descriptor: "Lines and total disagree." },
        { score: 8, descriptor: "Lines add up to the total." },
      ],
    },
  ],
  provenance: { source: "model", url: "", license: "Team", retrieved: "2026-10-08" },
  ...over,
});

export const setsDraft = () => [
  {
    key: "approvals",
    version: 1,
    title: "Equipment request approvals",
    authority: "Inferred from the team's examples",
    jurisdiction: "Team",
    appliesTo: ["equipment-request"],
    effective: "",
    checked: "2026-10-08",
    inferred: true,
    provenance: { source: "examples", url: "", license: "Team" },
    items: [{ key: "head_signs", kind: "checklist", title: "Department head signs", text: "The department head signs every request." }],
  },
];

export const workflowDraft = (over: Record<string, unknown> = {}) => ({
  key: "equipment-request-review",
  version: 1,
  title: "Equipment request review",
  summary: "Checks the request is complete and its costs add up, then recommends approve or revise.",
  kind: "type",
  appliesTo: ["equipment-request"],
  outcome: {
    label: "Recommendation",
    values: [
      { key: "approve", label: "Approve" },
      { key: "revise", label: "Revise" },
    ],
  },
  checkpoint: { role: "Department head", required: true },
  requirementSets: ["approvals"],
  provenance: { source: "model", checked: "2026-10-08" },
  steps: [
    { id: "doc", node: "doc.read" },
    { id: "req", node: "requirements.read", config: { sets: ["approvals"] } },
    {
      id: "gate",
      node: "step.gate",
      config: { inputs: [{ key: "costs", label: "A costs section", kind: "section", specKeys: ["costs"], help: "Add the cost lines and total." }] },
      in: { document: "doc.document" },
    },
    {
      id: "chk",
      node: "step.check",
      config: { checklist: [{ key: "signed", label: "Approver named", question: "Does the request name the role that signs?", appliesTo: ["approval"] }] },
      in: { document: "doc.document", requirements: "req.requirements", after: "gate.pass" },
    },
    {
      id: "rev",
      node: "step.review",
      config: {
        reviewers: [
          { key: "budget", label: "Budget holder", brief: "Judge whether the stated need justifies the spend for this department." },
          { key: "user", label: "Equipment user", brief: "Judge whether the request explains the day-to-day impact of going without." },
        ],
        criteria: [{ key: "justified", label: "Justified", scale: { kind: "enum", values: ["strong", "weak"] } }],
      },
      in: { document: "doc.document", after: "gate.pass" },
    },
    { id: "agr", node: "step.agree", in: { reviews: ["rev.reviews"] } },
    {
      id: "dec",
      node: "step.decide",
      config: { values: ["approve", "revise"], guidance: "Approve when the request is complete and justified." },
      in: { findings: ["chk.findings"], agreed: ["agr.agreed"], after: "gate.pass" },
    },
    {
      id: "out",
      node: "outcome.report",
      config: { rules: [], fallback: "revise" },
      in: { blocked: "gate.blocked", value: "dec.value", rationale: "dec.rationale", findings: ["chk.findings", "rev.findings"] },
    },
    { id: "cp", node: "checkpoint", config: { signsOutcome: true }, in: { items: "out.outcome" } },
  ],
  ...over,
});

export const USAGE = { model: "claude-opus-5-5", input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** The model's structured reply, with the drafts as JSON strings. */
export function modelReply(over: Record<string, unknown> = {}) {
  return {
    title: "Equipment request",
    type: JSON.stringify(typeDraft()),
    workflow: JSON.stringify(workflowDraft()),
    requirementSets: JSON.stringify(setsDraft()),
    parts: [
      { path: "type.sections.summary", note: "Both open with a two-sentence summary.", from: [{ example: 0, heading: "Summary", quote: "The lab asks for a replacement centrifuge" }], shared: true },
      { path: "type.sections.costs", note: "Cost lines and a total.", from: [{ example: 1, heading: "Costs", quote: "total 770" }, { example: 9, heading: null, quote: null }], shared: true },
    ],
    differences: [],
    nearestType: { key: "proposal", reason: "Asks for money with a budget." },
    personalDetails: [{ text: "Marisol Quintanilla Ortega", kind: "name" }],
    ...over,
  };
}
