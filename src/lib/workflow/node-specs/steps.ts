// The document nodes (PLAN §6.7) and the shared review steps from
// docs/workflows-by-document-type.md: gate, extract, trace, independent review,
// agreement, plus check, classify, simulate and decide. (Compute is in
// generic.ts; the checkpoint and outcome are engine nodes in core.ts.)
//
// CONTRACT (Phase 6): owned by the nodes-steps track; implementations live in
// src/lib/workflow/nodes/. Port names and config shapes are shared with the
// workflow definitions (src/catalog/workflows/*.json) and the canvas.

import { z } from "zod";
import { MAX_REVIEWERS, MIN_REVIEWERS, OUTCOME_BLOCKED, SEVERITIES } from "../contract";
import { ConfigKey, optionalJson, spec, type NodeSpec } from "../node-spec";

const severity = z.enum(SEVERITIES);
const keyword = z.string().trim().min(1).max(80);

/** A status a step can give an item; `ok: false` statuses become findings at `severity`. */
export const StatusSpec = z.object({ key: ConfigKey, label: z.string().max(80), ok: z.boolean(), severity: severity.default("major") });
export type StatusSpec = z.infer<typeof StatusSpec>;
const statusList = z
  .array(StatusSpec)
  .min(2)
  .max(8)
  .refine((a) => new Set(a.map((s) => s.key)).size === a.length, "status keys must be unique");

// --- Gate --------------------------------------------------------------------------

/**
 * One required input. Found by keywords first: a linked source's title,
 * filename, role or summary (source); a linked table's name or columns (data);
 * a section with content whose spec key is listed or whose heading matches
 * (section); the notes (notes); any of these or the document text (any). The
 * document having a type (type). With useModel, inputs keywords can't confirm
 * go to one fast-model check over the source summaries and section headings.
 */
export const GateInput = z.object({
  key: ConfigKey,
  label: z.string().trim().min(1).max(200),
  kind: z.enum(["source", "data", "section", "notes", "any", "type"]),
  match: z.array(keyword).max(20).default([]),
  specKeys: z.array(z.string().max(80)).max(20).default([]),
  required: z.boolean().default(true),
  /** Shown with a missing input: what to link and why. */
  help: z.string().max(500).default(""),
});
export type GateInput = z.output<typeof GateInput>;

// --- Extract -------------------------------------------------------------------------

export const FieldSpec = z.object({
  name: ConfigKey,
  label: z.string().max(80),
  type: z.enum(["text", "number", "date", "boolean", "enum", "list"]),
  description: z.string().max(500),
  /** enum: the allowed values. */
  values: z.array(z.string().max(60)).max(20).optional(),
  required: z.boolean().default(false),
});
export type FieldSpec = z.output<typeof FieldSpec>;

// --- Review ----------------------------------------------------------------------------

/**
 * step.decide by category (an FIE's suspected disability categories): each
 * category's result comes in code from the agreement on its criteria (the
 * requirement set's criteria grouped by appliesTo.categories); the model only
 * judges need, and the overall value follows from the categories:
 * - any category met with a shown need → `met`;
 * - else any category disputed, short of evidence, or met with need unclear → `insufficient`;
 * - else any category met with no need → `metNoNeed`;
 * - else (every rated category not met) → `notMet`; nothing rated → `insufficient`.
 */
export const DecideCategories = z.object({
  /** Requirement set whose criteria carry the categories. */
  from: z.string().min(1).max(80),
  met: ConfigKey,
  metNoNeed: ConfigKey,
  notMet: ConfigKey,
  insufficient: ConfigKey,
  /** The criterion verdicts that mean met and not met. */
  metVerdict: z.string().max(60).default("met"),
  notMetVerdict: z.string().max(60).default("not_met"),
});
export type DecideCategories = z.infer<typeof DecideCategories>;

export const ReviewerSpec = z.object({ key: ConfigKey, label: z.string().trim().min(1).max(80), brief: z.string().trim().min(20).max(2000) });
export type ReviewerSpec = z.infer<typeof ReviewerSpec>;

export const Scale = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("enum"), values: z.array(z.string().max(60)).min(2).max(10) }),
  z.object({ kind: z.literal("score"), min: z.number().int(), max: z.number().int(), best: z.enum(["low", "high"]) }),
]);
export type Scale = z.infer<typeof Scale>;

export const CriterionSpec = z.object({ key: ConfigKey, label: z.string().max(200), guidance: z.string().max(2000).default(""), scale: Scale });
export type CriterionSpec = z.output<typeof CriterionSpec>;

const normBrief = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export const ReviewConfig = z
  .object({
    reviewers: z.array(ReviewerSpec).min(MIN_REVIEWERS).max(MAX_REVIEWERS),
    criteria: z.array(CriterionSpec).max(20).default([]),
    /** Add one criterion per requirement item of kind "criterion" in this set (FIE state criteria). Uses `criterionScale`. */
    criteriaFrom: z.string().max(80).nullable().default(null),
    criterionScale: Scale.optional(),
    /** Rate each (option × criterion) cell, options and criteria taken from the `items` input (kind field "option" / "criterion"). */
    matrix: z.boolean().default(false),
    instructions: z.string().max(4000).default(""),
    /** Ask each reviewer for strengths and weaknesses as well as ratings. */
    strengthsAndWeaknesses: z.boolean().default(true),
  })
  .superRefine((c, ctx) => {
    const briefs = c.reviewers.map((r) => normBrief(r.brief));
    if (new Set(briefs).size !== briefs.length) ctx.addIssue({ code: "custom", path: ["reviewers"], message: "each reviewer needs a different brief" });
    if (new Set(c.reviewers.map((r) => r.key)).size !== c.reviewers.length) ctx.addIssue({ code: "custom", path: ["reviewers"], message: "reviewer keys must be unique" });
    if (!c.criteria.length && !c.criteriaFrom && !c.matrix) ctx.addIssue({ code: "custom", path: ["criteria"], message: "give criteria, criteriaFrom or matrix" });
  });
export type ReviewConfig = z.output<typeof ReviewConfig>;

export const CheckItem = z.object({
  key: ConfigKey,
  label: z.string().max(200),
  question: z.string().max(1000),
  severity: severity.default("major"),
  /** Section spec keys the check reads; empty: the whole document. */
  appliesTo: z.array(z.string().max(80)).max(20).default([]),
});
export type CheckItem = z.output<typeof CheckItem>;

const DEFAULT_CHECK_STATUSES: StatusSpec[] = [
  { key: "met", label: "Met", ok: true, severity: "info" },
  { key: "partly_met", label: "Partly met", ok: false, severity: "minor" },
  { key: "not_met", label: "Not met", ok: false, severity: "major" },
  { key: "not_applicable", label: "Not applicable", ok: true, severity: "info" },
];

export const STEP_NODE_SPECS: NodeSpec[] = [
  // --- Inputs ---------------------------------------------------------------------
  spec({
    type: "doc.read",
    category: "Inputs",
    label: "Document",
    description: "The document's text and sections, and its type's definition (sections, required elements, rubric).",
    config: z.object({ sectionChars: z.number().int().min(500).max(50_000) }),
    defaults: () => ({ sectionChars: 8000 }),
    inputs: () => [],
    outputs: () => [
      { name: "document", label: "document", type: "json" },
      { name: "text", label: "text", type: "text" },
      { name: "sections", label: "sections", type: "json", list: true },
      { name: "empty_sections", label: "empty sections", type: "json", list: true },
      { name: "type", label: "type", type: "json" },
    ],
  }),
  spec({
    type: "doc.notes",
    category: "Inputs",
    label: "Notes",
    description: "The notes scratchpad and each section's notes.",
    config: z.object({}),
    defaults: () => ({}),
    inputs: () => [],
    outputs: () => [
      { name: "notes", label: "notes", type: "json" },
      { name: "text", label: "text", type: "text" },
    ],
  }),
  spec({
    type: "sources.list",
    category: "Inputs",
    label: "Linked sources",
    description: "The sources linked to the document, with their summaries.",
    config: z.object({ readyOnly: z.boolean() }),
    defaults: () => ({ readyOnly: true }),
    inputs: () => [],
    outputs: () => [
      { name: "sources", label: "sources", type: "json", list: true },
      { name: "text", label: "text", type: "text" },
    ],
  }),
  spec({
    type: "sources.read",
    category: "Inputs",
    label: "Source passages",
    description: "The linked sources' citable passages most relevant to the focus, within a size budget.",
    config: z.object({ focus: z.string().max(2000), budget: z.number().int().min(2000).max(120_000), nameContains: z.string().max(80) }),
    defaults: () => ({ focus: "", budget: 30_000, nameContains: "" }),
    inputs: () => [{ name: "focus", label: "focus (optional)", type: "text", optional: true }],
    outputs: () => [
      { name: "sources", label: "sources", type: "json" },
      { name: "passages", label: "passages", type: "json", list: true },
      { name: "text", label: "text", type: "text" },
    ],
  }),
  spec({
    type: "data.list",
    category: "Inputs",
    label: "Linked data",
    description: "The data tables linked to the document, with their first rows.",
    config: z.object({ maxRows: z.number().int().min(0).max(500) }),
    defaults: () => ({ maxRows: 50 }),
    inputs: () => [],
    outputs: () => [
      { name: "tables", label: "tables", type: "json", list: true },
      { name: "text", label: "text", type: "text" },
    ],
  }),
  spec({
    type: "requirements.read",
    category: "Inputs",
    label: "Requirements",
    description: "Dated requirement sets (state criteria, agency limits, reporting guidelines). Each carries its source and the date it was checked.",
    config: z.object({ sets: z.array(z.string().max(80)).max(12), items: z.array(z.string().max(160)).max(60) }),
    defaults: () => ({ sets: [], items: [] }),
    inputs: () => [],
    outputs: () => [
      { name: "requirements", label: "requirements", type: "json" },
      { name: "text", label: "text", type: "text" },
    ],
  }),

  // --- Review steps --------------------------------------------------------------------
  spec({
    type: "type.coverage",
    category: "Review steps",
    label: "Source coverage",
    description: "Scores each section's sources needed, data needed and required elements as supported, weak or missing, with the passages behind each.",
    config: z.object({ includeElements: z.boolean() }),
    defaults: () => ({ includeElements: true }),
    inputs: () => [{ name: "document", label: "document", type: "json" }, optionalJson("sources"), optionalJson("data")],
    outputs: () => [
      { name: "coverage", label: "coverage", type: "json", list: true },
      { name: "gaps", label: "gaps", type: "json", list: true },
      { name: "findings", label: "findings", type: "json", list: true },
      { name: "table", label: "table", type: "json" },
    ],
  }),
  spec({
    type: "web.find",
    category: "Review steps",
    label: "Find web resources",
    description: "Searches the web for public resources that fill the gaps. Results stay unverified until a person accepts them. For sensitive types no document text is sent and only the type's public domains are searched.",
    config: z.object({
      maxResults: z.number().int().min(1).max(10),
      maxSearches: z.number().int().min(1).max(8),
      allowedDomains: z.array(z.string().max(120)).max(30),
      blockedDomains: z.array(z.string().max(120)).max(30),
    }),
    defaults: () => ({ maxResults: 6, maxSearches: 4, allowedDomains: [], blockedDomains: [] }),
    inputs: () => [{ name: "gaps", label: "gaps", type: "json" }, optionalJson("document")],
    outputs: () => [
      { name: "resources", label: "resources", type: "json", list: true },
      { name: "findings", label: "findings", type: "json", list: true },
    ],
  }),
  spec({
    type: "rubric.score",
    category: "Review steps",
    label: "Rubric score",
    description: "Scores the document (or the drafted sections) against the type's rubric plus the universal writing rubric, with evidence and a suggested fix per criterion.",
    config: z.object({ scope: z.enum(["document", "drafted"]), criteria: z.array(z.string().max(80)).max(30) }),
    defaults: () => ({ scope: "document" as const, criteria: [] }),
    inputs: () => [{ name: "document", label: "document", type: "json" }, optionalJson("drafts", "drafts", true)],
    outputs: () => [
      { name: "scores", label: "scores", type: "json", list: true },
      { name: "findings", label: "findings", type: "json", list: true },
      { name: "table", label: "table", type: "json" },
    ],
  }),
  spec({
    type: "step.gate",
    category: "Review steps",
    label: "Gate",
    description: "Confirms the required inputs are present. If any is missing the run stops at “blocked: missing input” and lists them.",
    config: z.object({ inputs: z.array(GateInput).min(1).max(20), useModel: z.boolean() }),
    defaults: () => ({ inputs: [{ key: "type", label: "A document type", kind: "type" as const, match: [], specKeys: [], required: true, help: "Choose a type for the document." }], useModel: false }),
    inputs: () => [optionalJson("document"), optionalJson("sources"), optionalJson("data"), optionalJson("notes")],
    outputs: () => [
      { name: "pass", label: "pass", type: "any" },
      { name: "blocked", label: "blocked", type: "json" },
      { name: "report", label: "report", type: "json" },
    ],
  }),
  spec({
    type: "step.extract",
    category: "Review steps",
    label: "Extract items",
    description: "Pulls the structured items later checks need (scores, claims, requirements, budget lines), each with where it was found.",
    config: z.object({
      item: z.string().trim().min(1).max(60),
      fields: z
        .array(FieldSpec)
        .min(1)
        .max(14)
        .refine((a) => new Set(a.map((f) => f.name)).size === a.length, "field names must be unique"),
      instructions: z.string().max(4000),
      from: z.array(z.enum(["document", "sources", "data", "notes"])).min(1).max(4),
      /** Read only these sections of the document (spec keys); empty: all. */
      sectionKeys: z.array(z.string().max(80)).max(30),
      /** Read only sources whose title, filename or role contains one of these; empty: all. */
      sourceMatch: z.array(keyword).max(10),
      maxItems: z.number().int().min(1).max(200),
    }),
    defaults: () => ({
      item: "claim",
      fields: [{ name: "statement", label: "Statement", type: "text" as const, description: "The claim as written", required: true }],
      instructions: "",
      from: ["document" as const],
      sectionKeys: [],
      sourceMatch: [],
      maxItems: 60,
    }),
    inputs: () => [optionalJson("document"), optionalJson("sources"), optionalJson("data"), optionalJson("notes")],
    outputs: () => [
      { name: "items", label: "items", type: "json", list: true },
      { name: "table", label: "table", type: "json" },
    ],
  }),
  spec({
    type: "step.trace",
    category: "Review steps",
    label: "Trace",
    description: "Links each item to its support (source passages, other items, the document) and flags items with none. Without access to what the claims are about, marks them unverified.",
    config: z.object({
      against: z.enum(["sources", "targets", "document", "code"]),
      statuses: statusList,
      /** The status for items nothing could be checked against (no sources linked, or against "code"). */
      unverifiedStatus: ConfigKey,
      question: z.string().max(1000),
      /** Also flag targets no item links to (needs with no goal, goals with no requirement). */
      bothWays: z.boolean(),
      /** With bothWays: a target whose field of this name is filled in (a stated reason for no goal) is not flagged. */
      exemptField: z.string().max(80).default(""),
      instructions: z.string().max(4000),
    }),
    defaults: () => ({
      against: "sources" as const,
      statuses: [
        { key: "supported", label: "Supported", ok: true, severity: "info" as const },
        { key: "partly_supported", label: "Partly supported", ok: false, severity: "minor" as const },
        { key: "unsupported", label: "Unsupported", ok: false, severity: "major" as const },
        { key: "unverified", label: "Unverified", ok: false, severity: "minor" as const },
      ],
      unverifiedStatus: "unverified",
      question: "Does the cited support establish the item as stated?",
      bothWays: false,
      exemptField: "",
      instructions: "",
    }),
    inputs: () => [{ name: "items", label: "items", type: "json" }, optionalJson("sources"), optionalJson("targets"), optionalJson("data"), optionalJson("document")],
    outputs: () => [
      { name: "traced", label: "traced", type: "json", list: true },
      { name: "findings", label: "findings", type: "json", list: true },
      { name: "table", label: "table", type: "json" },
    ],
  }),
  spec({
    type: "step.review",
    category: "Review steps",
    label: "Independent review",
    description: "Two or three reviewers, each with a different brief, rate the criteria without seeing each other. With “discuss”, each responds once to the others' rationales and rescores.",
    config: ReviewConfig,
    defaults: () => ({
      reviewers: [
        { key: "advocate", label: "Advocate", brief: "Build the strongest case that each criterion is met, citing the passages that support it." },
        { key: "skeptic", label: "Skeptic", brief: "Look for disconfirming evidence, gaps and weak support; argue each criterion is not met where the support is thin." },
      ],
      criteria: [{ key: "overall", label: "Overall", guidance: "", scale: { kind: "enum" as const, values: ["strong", "adequate", "weak"] } }],
      criteriaFrom: null,
      matrix: false,
      instructions: "",
      strengthsAndWeaknesses: true,
    }),
    inputs: () => [optionalJson("document"), optionalJson("sources"), optionalJson("items"), optionalJson("requirements"), optionalJson("discuss")],
    outputs: () => [
      { name: "reviews", label: "reviews", type: "json", list: true },
      { name: "findings", label: "findings", type: "json", list: true },
    ],
  }),
  spec({
    type: "step.agree",
    category: "Review steps",
    label: "Agreement",
    description: "Compares the reviewers item by item. Agreements carry forward; each disagreement is kept with every rationale. Nothing is averaged.",
    config: z.object({
      mode: z.enum(["verdict", "score"]),
      /** Score mode: reviewers disagree on an item when their scores differ by at least this much. */
      tolerance: z.number().min(0).max(100),
      /** Any reviewer giving one of these verdicts makes the item a blocker. */
      blockingVerdicts: z.array(z.string().max(60)).max(6),
      /** Score mode: also report the mean × 10 (the form NIH reports), beside the median and range. */
      meanTimes10: z.boolean(),
    }),
    defaults: () => ({ mode: "verdict" as const, tolerance: 2, blockingVerdicts: [], meanTimes10: false }),
    inputs: () => [{ name: "reviews", label: "reviews", type: "json", multiple: true }],
    outputs: () => [
      { name: "agreed", label: "agreed", type: "json", list: true },
      { name: "disagreements", label: "disagreements", type: "json", list: true },
      { name: "scores", label: "scores", type: "json", list: true },
      { name: "findings", label: "findings", type: "json", list: true },
      { name: "table", label: "table", type: "json" },
    ],
  }),
  spec({
    type: "step.check",
    category: "Review steps",
    label: "Checklist",
    description: "Answers each checklist question against the document (or each item), with the passage behind every answer.",
    config: z.object({ checklist: z.array(CheckItem).min(1).max(30), statuses: statusList, perItem: z.boolean(), instructions: z.string().max(4000) }),
    defaults: () => ({
      checklist: [{ key: "stated", label: "Stated", question: "Is it stated?", severity: "major" as const, appliesTo: [] }],
      statuses: DEFAULT_CHECK_STATUSES,
      perItem: false,
      instructions: "",
    }),
    inputs: () => [optionalJson("document"), optionalJson("sources"), optionalJson("items"), optionalJson("requirements"), optionalJson("data")],
    outputs: () => [
      { name: "results", label: "results", type: "json", list: true },
      { name: "findings", label: "findings", type: "json", list: true },
      { name: "table", label: "table", type: "json" },
    ],
  }),
  spec({
    type: "step.classify",
    category: "Review steps",
    label: "Classify passages",
    description: "Sorts each paragraph (or item) into fixed categories and flags the ones that belong elsewhere, such as Diátaxis explanation inside a how-to.",
    config: z.object({
      unit: z.enum(["paragraph", "item"]),
      categories: z
        .array(z.object({ key: ConfigKey, label: z.string().max(80), description: z.string().max(500), flag: z.boolean(), severity: severity.default("minor"), suggestion: z.string().max(300).default("") }))
        .min(2)
        .max(10),
      instructions: z.string().max(4000),
    }),
    defaults: () => ({
      unit: "paragraph" as const,
      categories: [
        { key: "on_type", label: "Fits the type", description: "Belongs in this document type", flag: false, severity: "info" as const, suggestion: "" },
        { key: "off_type", label: "Belongs elsewhere", description: "Belongs in another document type", flag: true, severity: "minor" as const, suggestion: "" },
      ],
      instructions: "",
    }),
    inputs: () => [optionalJson("document"), optionalJson("items")],
    outputs: () => [
      { name: "classified", label: "classified", type: "json", list: true },
      { name: "findings", label: "findings", type: "json", list: true },
      { name: "table", label: "table", type: "json" },
    ],
  }),
  spec({
    type: "step.simulate",
    category: "Review steps",
    label: "Walkthrough",
    description: "A simulated reader (new hire, beginner, competent practitioner) follows the text and logs every point where it must guess. Nothing is executed, so results are marked unverified.",
    config: z.object({
      persona: z.string().trim().min(10).max(1000),
      task: z.string().trim().min(10).max(1000),
      rules: z.array(z.string().max(300)).max(10),
      /** steps: log each step's stated and observed result; gaps: log guesses; answers: answer the questions from the text alone. */
      records: z.enum(["steps", "gaps", "answers"]),
      questions: z.array(z.string().max(500)).max(8),
    }),
    defaults: () => ({ persona: "A competent reader with only the stated prerequisites.", task: "Follow the document to reach its stated goal.", rules: [], records: "gaps" as const, questions: [] }),
    inputs: () => [optionalJson("document"), optionalJson("sources"), optionalJson("items")],
    outputs: () => [
      { name: "log", label: "log", type: "json" },
      { name: "findings", label: "findings", type: "json", list: true },
      { name: "table", label: "table", type: "json" },
    ],
  }),
  spec({
    type: "step.decide",
    category: "Review steps",
    label: "Decide",
    description: "Chooses one of the outcome's fixed values from the findings and agreement, with a rationale citing them (an editor's or panel's pass). The outcome stays advisory.",
    config: z
      .object({
        values: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)).min(2).max(8),
        guidance: z.string().trim().min(1).max(4000),
        categories: DecideCategories.nullable().default(null),
      })
      .refine((c) => !c.values.includes(OUTCOME_BLOCKED), "“blocked” is decided by the gate")
      .refine((c) => !c.categories || [c.categories.met, c.categories.metNoNeed, c.categories.notMet, c.categories.insufficient].every((v) => c.values.includes(v)), "the category values must be among the values"),
    defaults: () => ({ values: ["ready", "not_ready"], guidance: "Choose the value the findings support.", categories: null }),
    inputs: () => [optionalJson("findings", "findings", true), optionalJson("agreed", "agreed", true), optionalJson("disagreements", "disagreements", true), optionalJson("results", "results", true), optionalJson("scores", "scores", true)],
    outputs: () => [
      { name: "value", label: "value", type: "text" },
      { name: "rationale", label: "rationale", type: "text" },
      { name: "table", label: "table (by category)", type: "json" },
    ],
  }),

  // --- Changes ------------------------------------------------------------------------
  spec({
    type: "doc.write",
    category: "Changes",
    label: "Write to document",
    description: "Proposes changes to the document; the open editor applies them as one undo step after a version snapshot. Section notes and statuses are written directly.",
    config: z.object({ target: z.enum(["editor", "section_notes"]), title: z.string().max(120), snapshotReason: z.string().max(200) }),
    defaults: () => ({ target: "editor" as const, title: "Proposed change", snapshotReason: "Before applying a workflow change" }),
    inputs: () => [optionalJson("ops", "changes", true), optionalJson("findings", "findings", true)],
    outputs: () => [{ name: "change", label: "change", type: "json" }],
  }),
  spec({
    type: "suggest.emit",
    category: "Changes",
    label: "Add suggestions",
    description: "Turns gaps and web resources into suggestions in the document's Suggestions tab (web resources marked unverified until accepted).",
    config: z.object({}),
    defaults: () => ({}),
    inputs: () => [optionalJson("gaps"), optionalJson("resources")],
    outputs: () => [{ name: "suggestions", label: "suggestions", type: "json" }],
  }),
];
