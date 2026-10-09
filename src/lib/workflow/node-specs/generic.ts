// Nodes for the generic workflows (restructure to type, draft all empty
// sections) and the compute step, which recalculates numbers in code and
// never asks a model.
//
// CONTRACT (Phase 6): owned by the workflow-defs track; implementations live
// in src/lib/workflow/generic/. Port names and config shapes are shared with
// the workflow definitions and the canvas.

import { z } from "zod";
import { MAX_CHANGE_LINES, SEVERITIES } from "../contract";
import { ConfigKey, optionalJson, spec, type NodeSpec } from "../node-spec";

const severity = z.enum(SEVERITIES).default("major");
const field = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/);
const where = z.object({ field, equals: z.string().max(80) });
/** "<set key>#<item key>" in src/catalog/requirements/. */
export const RequirementRef = z.string().regex(/^[a-z0-9-]+#[a-z0-9_-]+$/, "<set>#<item>");

/** The resume Tailor step's node type (not "step.*": learned workflows never change text). */
export const TAILOR_NODE_TYPE = "tailor.lines";

const keyword = z.string().trim().min(1).max(80);

/**
 * tailor.lines (After Phase 9, user decision 2026-10-09). Sources are the master history:
 * those whose title or role contains a `masterMatch` keyword (empty: every source), less those
 * matching an `excludeSources` keyword (the job posting), which are never shown as evidence.
 * The posting's terms reach the model through the `requirements` input (the before trace).
 */
export const TailorConfig = z.object({
  instructions: z.string().max(4000),
  masterMatch: z.array(keyword).max(20),
  excludeSources: z.array(keyword).max(20),
  /** With the gate's `report` wired to `gate`: leave out the sources the gate bound under these input keys (the job posting), whatever they are titled. */
  excludeBound: z.array(ConfigKey).max(10).default([]),
  /** Sections it may change (spec keys); empty: every section except static ones (contact). */
  sectionKeys: z.array(z.string().max(80)).max(30),
  maxLines: z.number().int().min(1).max(Math.min(60, MAX_CHANGE_LINES)),
});
export type TailorConfig = z.infer<typeof TailorConfig>;

const base = { key: ConfigKey, label: z.string().trim().min(1).max(200), severity };

/**
 * One deterministic check. Values come from extracted items (fields named
 * here), linked data tables, the document text, or requirement items; the
 * arithmetic is always done in code.
 */
export const ComputeCheck = z.discriminatedUnion("kind", [
  /** Words or estimated pages in the document or some sections, against a limit (or a requirement item's value). */
  z.object({
    kind: z.literal("length"),
    ...base,
    specKeys: z.array(z.string().max(80)).max(20).default([]),
    unit: z.enum(["pages", "words"]),
    /** Pages are estimated from words (single-spaced 11 pt is about 500). */
    wordsPerPage: z.number().int().min(100).max(1500).default(500),
    limit: z.number().positive().nullable().default(null),
    requirement: RequirementRef.nullable().default(null),
    /** Pick the requirement item from this set whose appliesTo.activityCodes includes the activity code found in the document (NIH R01, R21…). */
    requirementSet: z.string().max(80).nullable().default(null),
  }),
  /** Parts sum to the total: items where partWhere holds, summed over valueField, against items where totalWhere holds. */
  z.object({ kind: z.literal("sum"), ...base, valueField: field, partWhere: where, totalWhere: where, tolerance: z.number().min(0).default(0.01) }),
  /** a × b = result on each item (rate × quantity = cost; customers × price = revenue). */
  z.object({ kind: z.literal("product"), ...base, aField: field, bField: field, resultField: field, tolerance: z.number().min(0).default(0.01) }),
  /** a ÷ b = result on each item (runway = cash ÷ burn; share = revenue ÷ market). */
  z.object({ kind: z.literal("ratio"), ...base, aField: field, bField: field, resultField: field.nullable().default(null), tolerance: z.number().min(0).default(0.01) }),
  /** a = b on each item (net income on the income statement = net income on the cash flow statement). */
  z.object({ kind: z.literal("equal"), ...base, aField: field, bField: field, tolerance: z.number().min(0).default(0.5) }),
  /** part ÷ whole × 100 = percent on each item. */
  z.object({ kind: z.literal("percent_of"), ...base, partField: field, wholeField: field, percentField: field, tolerance: z.number().min(0).default(0.5) }),
  /** Dates run in order: each item's date comes after the date of the item its dependency field names. */
  z.object({ kind: z.literal("date_order"), ...base, dateField: field, idField: field, dependsOnField: field, labelField: field }),
  /**
   * How many items (optionally where a field equals a value), against min and
   * max. With `status` (traced items from step.trace): only items whose trace
   * status is one of these count, reported as "n of m", m being the items where
   * `where` holds (required items met before and after tailoring).
   */
  z.object({
    kind: z.literal("count"),
    ...base,
    where: where.nullable().default(null),
    status: z.array(ConfigKey).min(1).max(10).nullable().default(null),
    min: z.number().int().min(0).nullable().default(null),
    max: z.number().int().min(0).nullable().default(null),
  }),
  /** Every number in the `from` sections (summary, abstract) also appears in the `to` sections (empty: the rest of the document). */
  z.object({ kind: z.literal("numbers_match"), ...base, fromSpecKeys: z.array(z.string().max(80)).min(1).max(10), toSpecKeys: z.array(z.string().max(80)).max(20).default([]) }),
  /** Each item's value appears in the document next to its label (scores in the narrative match the evidence table). */
  z.object({ kind: z.literal("values_in_text"), ...base, labelField: field, valueField: field, specKeys: z.array(z.string().max(80)).max(20).default([]) }),
  /** A due date from a start date and a requirement item's value and unit (school days are approximated as weekdays and say so). */
  z.object({
    kind: z.literal("deadline"),
    ...base,
    startField: field,
    /** The requirement item that gives the period; null with `byKind`. */
    requirement: RequirementRef.nullable().default(null),
    /**
     * Picks the requirement item by the start item's kind field (annual, interim
     * or final report). A kind with no entry, or none stated, is not assessed:
     * the result says `notAssessed` instead of applying another kind's period.
     */
    byKind: z
      .object({ field, requirements: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), RequirementRef), notAssessed: z.string().trim().max(300).default("") })
      .nullable()
      .default(null),
    /** Days to add (absences): added only when the value is at least `extendWhenAtLeast` (Texas: three or more school days absent). */
    extendByField: field.nullable().default(null),
    extendWhenAtLeast: z.number().int().min(0).default(0),
    /** The date the document states the work was (or will be) done; later than the due date fails. Without it the result is informational. */
    endField: field.nullable().default(null),
  }),
  /** In a linked table, rows whose label matches `left` sum to rows matching `right`, per numeric column (assets = liabilities + equity). */
  z.object({ kind: z.literal("table_rows_equal"), ...base, tableMatch: z.string().max(80), left: z.array(z.string().max(80)).min(1).max(5), right: z.array(z.string().max(80)).min(1).max(5), tolerance: z.number().min(0).default(0.5) }),
  /**
   * In a linked table, rows whose label matches stay at or above `min` in every
   * numeric column (cash stays above zero). With `coveredBy`, a column below
   * `min` still passes when rows matching those labels (financing raised) add
   * up, over that column and the ones before it, to at least the shortfall.
   */
  z.object({
    kind: z.literal("table_row_min"),
    ...base,
    tableMatch: z.string().max(80),
    row: z.string().max(80),
    min: z.number().default(0),
    coveredBy: z.array(z.string().max(80)).max(5).default([]),
  }),
]);
export type ComputeCheck = z.output<typeof ComputeCheck>;

export const GENERIC_NODE_SPECS: NodeSpec[] = [
  spec({
    type: "step.compute",
    category: "Review steps",
    label: "Compute",
    description: "Recalculates numbers in code: totals, products, dates, counts, page and word counts, deadlines. Never asks a model.",
    config: z.object({ checks: z.array(ComputeCheck).min(1).max(20) }),
    defaults: () => ({ checks: [{ kind: "length" as const, key: "length", label: "Length", severity: "major" as const, specKeys: [], unit: "words" as const, wordsPerPage: 500, limit: null, requirement: null, requirementSet: null }] }),
    inputs: () => [optionalJson("document"), optionalJson("items"), optionalJson("data"), optionalJson("requirements")],
    outputs: () => [
      { name: "results", label: "results", type: "json", list: true },
      { name: "findings", label: "findings", type: "json", list: true },
      { name: "table", label: "table", type: "json" },
    ],
  }),
  spec({
    type: "restructure.plan",
    category: "Changes",
    label: "Plan restructure",
    description: "Maps each part of the document (a heading and its text) onto the target type's sections, and lists parts with no home and sections with no content. Nothing is moved yet.",
    config: z.object({ mode: z.enum(["merge", "rewrite"]) }),
    defaults: () => ({ mode: "merge" as const }),
    inputs: () => [{ name: "document", label: "document", type: "json" }],
    outputs: () => [
      { name: "plan", label: "plan", type: "json" },
      { name: "rows", label: "rows", type: "json", list: true },
      { name: "findings", label: "findings", type: "json", list: true },
      { name: "table", label: "table", type: "json" },
    ],
  }),
  spec({
    type: "restructure.apply",
    category: "Changes",
    label: "Apply restructure",
    description: "Turns the approved mapping (with the checkpoint's edits) into a change that moves text verbatim, adds empty sections, and keeps content with no home under “Content to place”.",
    config: z.object({}),
    defaults: () => ({}),
    inputs: () => [
      { name: "plan", label: "plan", type: "json" },
      { name: "approved", label: "approved", type: "any" },
      optionalJson("decision"),
    ],
    outputs: () => [
      { name: "op", label: "change", type: "json" },
      { name: "sections", label: "sections to reword", type: "json", list: true },
    ],
  }),
  spec({
    type: "restructure.rewrite",
    category: "Changes",
    label: "Reword section",
    description: "Rewrite mode: rewords one restructured section (a separate step from moving the text), adding only transitional prose.",
    config: z.object({}),
    defaults: () => ({}),
    inputs: () => [{ name: "section", label: "section", type: "json" }, optionalJson("document")],
    outputs: () => [{ name: "op", label: "change", type: "json" }],
    loopable: true,
    minTimeMs: 150_000,
    maxConcurrency: 2,
  }),
  spec({
    type: "draft.section",
    category: "Changes",
    label: "Draft section",
    description: "Drafts one empty section from its notes and the linked sources. Each sentence carries the note or passage behind it, or is marked unsourced.",
    config: z.object({ skipStatic: z.boolean() }),
    defaults: () => ({ skipStatic: true }),
    inputs: () => [{ name: "section", label: "section", type: "json" }, optionalJson("document"), optionalJson("notes")],
    outputs: () => [
      { name: "draft", label: "draft", type: "json" },
      { name: "op", label: "change", type: "json" },
      { name: "findings", label: "findings", type: "json", list: true },
    ],
    loopable: true,
    minTimeMs: 150_000,
    maxConcurrency: 2,
  }),
  spec({
    type: TAILOR_NODE_TYPE,
    category: "Changes",
    label: "Tailor lines",
    description:
      "Resume Tailor step: proposes line rewrites of the open document from the master history (lead with matching evidence, the posting's terms where the history supports them, the source's numbers, trim unrelated lines). Each new line cites the master passages behind it and is truth-checked before it is proposed; lines that fail are dropped and reported.",
    config: TailorConfig,
    defaults: () => ({
      instructions: "",
      masterMatch: [],
      excludeSources: [],
      excludeBound: [],
      sectionKeys: [],
      maxLines: 25,
    }),
    inputs: () => [{ name: "document", label: "document", type: "json" }, optionalJson("sources"), optionalJson("requirements", "requirements (traced)"), optionalJson("gate", "gate report")],
    outputs: () => [
      { name: "op", label: "change", type: "json" },
      { name: "lines", label: "lines", type: "json", list: true },
      { name: "findings", label: "findings", type: "json", list: true },
      { name: "table", label: "table", type: "json" },
    ],
    minTimeMs: 150_000,
  }),
];
