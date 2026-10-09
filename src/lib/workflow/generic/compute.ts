// The compute step (phase6-spec.md §3.2): recalculates numbers in code and never
// asks a model. Totals, products, ratios, percentages and equal figures over
// extracted items; dates in order; counts; page and word counts against a
// limit; numbers in a summary that must reappear in the body; scores in the
// narrative against the evidence table; deadlines from a requirement item; and
// row checks over linked tables. `runComputeChecks` is pure; the handler only reads its inputs.
//
// A value that cannot be read (missing, or not a number or date) gives
// `ok: null` (could not compute), never a failure. Estimates (pages from words,
// school days as weekdays) are marked `approximate`.

import { requirementItem, requirementSet } from "@/catalog/workflows";
import { parseCell, parseDate, parseNumber } from "@/lib/data/infer";
import { wordCount } from "@/lib/documents/sections";
import { CHANGED_LINE_KIND, type ChangedLine, type ComputeResult, type EvidenceLink, type ExtractedItem, type Finding, type OutcomeTable } from "../contract";
import type { NodeHandler } from "../context";
import type { ComputeCheck } from "../node-specs/generic";
import type { DocSnapshot, SectionView, TableView } from "../nodes/types";
import { asDoc, asItems, asTables, clip, Findings, flat, outcomeTable } from "../nodes/util";

export type ComputeInput = { doc: DocSnapshot | null; items: ExtractedItem[]; tables: TableView[] };
export type ComputeOutput = { results: ComputeResult[]; findings: Finding[]; table: OutcomeTable };

/** The NIH activity code a document names first (R01, R21, K99…), which picks the page limit. */
export const ACTIVITY_CODE_RE = /\b(R01|R03|R15|R21|R34|U01|K\d\d|F\d\d)\b/;
/** Context searched around a label for its value (values_in_text). */
const NEAR_CHARS = 200;

// --- Reading values -----------------------------------------------------------------

/** A number from a field or cell: plain numbers, money, percentages, thousands separators. Null when it doesn't read as one. */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = parseNumber(v) ?? parseCell(v, "number");
  return typeof n === "number" ? n : null;
}

/** An ISO date (yyyy-mm-dd) from a field, or null. */
export function toDate(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? parseDate(v.trim()) : null;
}

const text = (v: unknown) => (v === null || v === undefined ? "" : Array.isArray(v) ? v.join("; ") : String(v)).trim();
const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[:.\s]+$/, "").trim();
const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 4 }));
/** Equal within the check's tolerance, or half a percent of the expected value (rounding in the source). */
const within = (actual: number, expected: number, tolerance: number) => Math.abs(actual - expected) <= Math.max(tolerance, Math.abs(expected) * 0.005);
const whereHolds = (item: ExtractedItem, w: { field: string; equals: string } | null) => !w || fold(text(item.fields[w.field])) === fold(w.equals);

// --- Evidence ----------------------------------------------------------------------------

const link = (l: Pick<EvidenceLink, "kind" | "ref" | "label"> & Partial<EvidenceLink>): EvidenceLink => ({ sourceId: null, quote: "", page: null, stance: "neutral", verified: true, ...l });
const sectionLink = (s: SectionView) => link({ kind: "document", ref: s.sectionId, label: clip(s.heading, 300) });
const tableLink = (t: TableView) => link({ kind: "data", ref: t.id, sourceId: t.sourceId, label: clip(t.name, 300) });
const itemLink = (i: ExtractedItem, label: string) => link({ kind: "item", ref: i.id, label: clip(label || i.id, 300) });
const requirementLink = (ref: string, title: string, citation?: string) => link({ kind: "requirement", ref, label: clip(title, 300), quote: clip(citation ?? "", 600) });

// --- Dates --------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `start` plus `n` days; weekdays only when `weekdays` (school and business days, approximated). */
export function addDays(start: string, n: number, weekdays: boolean): string {
  let t = Date.parse(`${start}T00:00:00Z`);
  if (!weekdays) return isoDay(t + n * DAY_MS);
  let left = n;
  while (left > 0) {
    t += DAY_MS;
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) left--;
  }
  return isoDay(t);
}

/** `start` plus `n` whole calendar years; 29 February falls back to 28 February in a common year (never later). */
export function addYears(start: string, n: number): string {
  const [y, m, d] = start.split("-").map(Number);
  const year = y + Math.trunc(n);
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return isoDay(Date.UTC(year, m - 1, Math.min(d, last)));
}

// --- Numbers in text -----------------------------------------------------------------------

const NUMBER_RE = /(?<![\w.,])-?\d+(?:,\d{3})*(?:\.\d+)?%?/g;

/** The numbers in a text, normalized (thousands separators off, trailing zeros off, % kept as a mark). Small integers (0–9) are left out as noise. */
export function numbersIn(s: string): string[] {
  const out: string[] = [];
  for (const m of s.match(NUMBER_RE) ?? []) {
    const pct = m.endsWith("%");
    const raw = m.replace(/%$/, "").replace(/,/g, "");
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (!pct && Number.isInteger(n) && Math.abs(n) < 10 && !raw.includes(".")) continue;
    out.push(`${n}${pct ? "%" : ""}`);
  }
  return out;
}

/** A bare four-digit year, 1900–2099, as numbersIn normalizes it. */
const isYear = (n: string) => /^(19|20)\d\d$/.test(n);

/** Does the text contain the number (as a number, so "12.0" matches "12" and "1,200" matches "1200")? A percentage also matches the bare number. */
const hasNumber = (pool: Set<string>, n: string) => pool.has(n) || (n.endsWith("%") && pool.has(n.slice(0, -1))) || pool.has(`${n}%`);

// --- Tables --------------------------------------------------------------------------------

function labelColumn(t: TableView): number {
  const i = t.columns.findIndex((c) => c.type === "text");
  return i >= 0 ? i : 0;
}

/** Rows whose label matches: exact (ignoring case and spacing) first, else labels that contain it. */
function rowsLabelled(t: TableView, label: string): Array<Array<string | null>> {
  const col = labelColumn(t);
  const want = fold(label);
  const exact = t.rows.filter((r) => fold(r[col] ?? "") === want);
  return exact.length ? exact : t.rows.filter((r) => fold(r[col] ?? "").includes(want));
}

const numericColumns = (t: TableView) => t.columns.map((c, i) => ({ c, i })).filter(({ i }) => i !== labelColumn(t));

// --- The checks ------------------------------------------------------------------------------

type Ctx = ComputeInput;
type Res = Omit<ComputeResult, "key" | "label"> & { label?: string };

const result = (r: Partial<Res> & Pick<Res, "ok">): Res => ({ expected: "", actual: "", detail: "", approximate: false, evidence: [], ...r });

function sectionsFor(doc: DocSnapshot | null, keys: string[]): SectionView[] {
  if (!doc) return [];
  return keys.length ? doc.sections.filter((s) => s.specKey && keys.includes(s.specKey)) : doc.sections;
}

function lengthCheck(c: Extract<ComputeCheck, { kind: "length" }>, { doc }: Ctx): Res[] {
  if (!doc) return [result({ ok: null, detail: "No document to count." })];
  const secs = c.specKeys.length ? sectionsFor(doc, c.specKeys) : [];
  if (c.specKeys.length && !secs.length) return [result({ ok: null, detail: `The document has no section for ${c.specKeys.join(", ")}.` })];
  const words = c.specKeys.length ? secs.reduce((n, s) => n + (Number.isFinite(s.wordCount) ? s.wordCount : wordCount(s.text)), 0) : doc.wordCount;
  const pages = c.unit === "pages";
  const value = pages ? Math.ceil(words / c.wordsPerPage) : words;
  const actual = pages ? `about ${value} page${value === 1 ? "" : "s"} (${fmt(words)} words)` : `${fmt(words)} words`;
  const approx = { approximate: pages, detail: pages ? "estimated from words; figures and formatting not counted" : "" };
  const evidence = secs.map(sectionLink);

  let limit: number | null = null;
  let source: EvidenceLink | null = null;
  if (c.requirement) {
    const r = requirementItem(c.requirement);
    if (r && typeof r.item.value === "number") {
      limit = r.item.value;
      source = requirementLink(c.requirement, r.item.title, r.item.citation);
    }
  } else if (c.requirementSet) {
    const code = ACTIVITY_CODE_RE.exec(doc.text)?.[1] ?? null;
    const set = requirementSet(c.requirementSet);
    const item = code ? set?.items.find((i) => i.appliesTo?.activityCodes?.includes(code) && typeof i.value === "number") : undefined;
    if (!item) return [result({ ok: null, actual, ...approx, evidence, detail: code ? `No limit for ${code} in the requirement set; check the funding opportunity.` : "No activity code (R01, R21…) found in the document, so the limit is unknown." })];
    limit = item.value!;
    source = requirementLink(`${c.requirementSet}#${item.key}`, item.title, item.citation);
  } else {
    limit = c.limit;
  }
  if (limit === null) return [result({ ok: null, actual, ...approx, evidence, detail: approx.detail || "No limit set." })];
  return [result({ ok: value <= limit, expected: `at most ${fmt(limit)} ${c.unit}`, actual, ...approx, evidence: source ? [...evidence, source] : evidence })];
}

function sumCheck(c: Extract<ComputeCheck, { kind: "sum" }>, { items }: Ctx): Res[] {
  const parts = items.filter((i) => whereHolds(i, c.partWhere));
  const totals = items.filter((i) => whereHolds(i, c.totalWhere));
  if (!parts.length || !totals.length) return [result({ ok: null, detail: !parts.length ? "No parts found to add up." : "No total found to compare with." })];
  const values = parts.map((p) => toNumber(p.fields[c.valueField]));
  const unread = parts.filter((_, i) => values[i] === null);
  const evidence = [...parts, ...totals].map((i) => itemLink(i, text(i.fields.name) || text(i.fields[c.valueField])));
  if (unread.length) return [result({ ok: null, detail: `Could not read ${c.valueField} for ${unread.length} part(s).`, evidence })];
  const sum = values.reduce<number>((a, b) => a + (b ?? 0), 0);
  return totals.map((t) => {
    const total = toNumber(t.fields[c.valueField]);
    const name = text(t.fields.name);
    if (total === null) return result({ label: name ? `${c.label}: ${name}` : undefined, ok: null, detail: `Could not read the total's ${c.valueField}.`, evidence });
    return result({ label: totals.length > 1 && name ? `${c.label}: ${name}` : undefined, ok: within(sum, total, c.tolerance), expected: fmt(total), actual: `${fmt(sum)} (${parts.length} parts)`, evidence });
  });
}

/** product, ratio, percent_of: per item, the value computed from two fields against the item's own result field. */
function perItem(c: Extract<ComputeCheck, { kind: "product" | "ratio" | "percent_of" }>, { items }: Ctx): Res[] {
  const [aF, bF, rF] = c.kind === "percent_of" ? [c.partField, c.wholeField, c.percentField] : [c.aField, c.bField, c.resultField];
  const symbol = c.kind === "product" ? "×" : "÷";
  const out: Res[] = [];
  for (const item of items) {
    const raw = [item.fields[aF], item.fields[bF], rF ? item.fields[rF] : undefined];
    const given = (v: unknown) => text(v) !== "";
    if (!given(raw[0]) || !given(raw[1]) || (rF && !given(raw[2]))) continue;
    const name = text(item.fields.name) || text(item.fields.period) || item.id;
    const evidence = [itemLink(item, name)];
    const label = `${c.label}: ${name}`;
    const [a, b] = [toNumber(raw[0]), toNumber(raw[1])];
    const r = rF ? toNumber(raw[2]) : null;
    if (a === null || b === null || (rF && r === null)) {
      out.push(result({ label, ok: null, detail: "A value could not be read as a number.", evidence }));
      continue;
    }
    if (c.kind !== "product" && b === 0) {
      out.push(result({ label, ok: null, detail: `${bF} is zero.`, evidence }));
      continue;
    }
    const computed = c.kind === "product" ? a * b : c.kind === "ratio" ? a / b : (a / b) * 100;
    const shown = `${fmt(a)} ${symbol} ${fmt(b)}${c.kind === "percent_of" ? " × 100" : ""} = ${fmt(computed)}`;
    if (r === null) out.push(result({ label, ok: null, actual: shown, detail: "Informational: no stated value to compare.", evidence }));
    else out.push(result({ label, ok: within(computed, r, c.tolerance), expected: fmt(r), actual: shown, evidence }));
  }
  return out.length ? out : [result({ ok: null, detail: `No item has both ${aF} and ${bF}${rF ? ` and ${rF}` : ""}.` })];
}

/** equal: per item, two fields that must agree (the same figure in two statements). */
function equalCheck(c: Extract<ComputeCheck, { kind: "equal" }>, { items }: Ctx): Res[] {
  const out: Res[] = [];
  for (const item of items) {
    const [ra, rb] = [item.fields[c.aField], item.fields[c.bField]];
    if (text(ra) === "" || text(rb) === "") continue;
    const name = text(item.fields.name) || text(item.fields.period) || item.id;
    const evidence = [itemLink(item, name)];
    const label = `${c.label}: ${name}`;
    const [a, b] = [toNumber(ra), toNumber(rb)];
    if (a === null || b === null) {
      out.push(result({ label, ok: null, detail: "A value could not be read as a number.", evidence }));
      continue;
    }
    out.push(result({ label, ok: within(b, a, c.tolerance), expected: `${c.aField} ${fmt(a)}`, actual: `${c.bField} ${fmt(b)}`, evidence }));
  }
  return out.length ? out : [result({ ok: null, detail: `No item has both ${c.aField} and ${c.bField}.` })];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The item a dependency names: an exact id match, else the one other item
 * whose id contains the dependency as a whole word or is contained in it
 * ("D1" names "D1, Curriculum pack"). Ambiguous or unknown: undefined.
 */
export function dependencyItem(items: ExtractedItem[], idField: string, dep: string, self: ExtractedItem): ExtractedItem | undefined {
  const want = fold(dep);
  if (!want) return undefined;
  const ids = items.filter((i) => i !== self).map((i) => [fold(text(i.fields[idField])), i] as const).filter(([id]) => id);
  const exact = ids.find(([id]) => id === want);
  if (exact) return exact[1];
  const word = (needle: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(needle)}($|[^\\p{L}\\p{N}])`, "u");
  const hits = ids.filter(([id]) => word(want).test(id) || word(id).test(want));
  return hits.length === 1 ? hits[0][1] : undefined;
}

function dateOrder(c: Extract<ComputeCheck, { kind: "date_order" }>, { items }: Ctx): Res[] {
  const out: Res[] = [];
  for (const item of items) {
    const dep = text(item.fields[c.dependsOnField]);
    if (!dep) continue;
    const name = text(item.fields[c.labelField]) || item.id;
    const before = dependencyItem(items, c.idField, dep, item);
    const label = `${c.label}: ${name}`;
    if (!before) {
      out.push(result({ label, ok: null, detail: `“${clip(dep, 80)}” is not one of the items.`, evidence: [itemLink(item, name)] }));
      continue;
    }
    const evidence = [itemLink(item, name), itemLink(before, text(before.fields[c.labelField]))];
    const [d, b] = [toDate(item.fields[c.dateField]), toDate(before.fields[c.dateField])];
    if (!d || !b) out.push(result({ label, ok: null, detail: "A date is missing or could not be read.", evidence }));
    else out.push(result({ label, ok: d >= b, expected: `on or after ${b} (${clip(dep, 80)})`, actual: d, evidence }));
  }
  return out.length ? out : [result({ ok: null, detail: "No item names a dependency." })];
}

/** A traced item's status (step.trace output), or null for a plain extracted item. */
const statusOf = (item: ExtractedItem) => {
  const s = (item as ExtractedItem & { status?: unknown }).status;
  return typeof s === "string" ? s : null;
};

function countCheck(c: Extract<ComputeCheck, { kind: "count" }>, { items }: Ctx): Res[] {
  const pool = items.filter((i) => whereHolds(i, c.where));
  const status = c.status ? new Set(c.status) : null;
  const n = status ? pool.filter((i) => status.has(statusOf(i) ?? "")).length : pool.length;
  const actual = status ? `${n} of ${pool.length}` : String(n);
  const expected = [c.min !== null ? `at least ${c.min}` : "", c.max !== null ? `at most ${c.max}` : ""].filter(Boolean).join(" and ");
  if (c.min === null && c.max === null) return [result({ ok: null, actual, detail: "No minimum or maximum set." })];
  return [result({ ok: (c.min === null || n >= c.min) && (c.max === null || n <= c.max), expected, actual })];
}

function numbersMatch(c: Extract<ComputeCheck, { kind: "numbers_match" }>, { doc }: Ctx): Res[] {
  const from = sectionsFor(doc, c.fromSpecKeys);
  if (!doc || !from.length) return [result({ ok: null, detail: `The document has no section for ${c.fromSpecKeys.join(", ")}.` })];
  const fromIds = new Set(from.map((s) => s.sectionId));
  const to = c.toSpecKeys.length ? sectionsFor(doc, c.toSpecKeys) : doc.sections.filter((s) => !fromIds.has(s.sectionId));
  if (!to.length) return [result({ ok: null, detail: c.toSpecKeys.length ? `The document has no section for ${c.toSpecKeys.join(", ")}.` : "The document has no other sections." })];
  // Years ("2025") date the text rather than report a figure; an introduction's
  // period need not reappear in the body, so they are not checked.
  const wanted = [...new Set(from.flatMap((s) => numbersIn(`${s.heading}\n${s.text}`)))].filter((n) => !isYear(n));
  const pool = new Set(to.flatMap((s) => numbersIn(`${s.heading}\n${s.text}`)));
  const missing = wanted.filter((n) => !hasNumber(pool, n));
  const evidence = [...from, ...to].map(sectionLink).slice(0, 12);
  if (!wanted.length) return [result({ ok: null, detail: "No numbers to check.", evidence })];
  return [result({ ok: !missing.length, expected: `${wanted.length} number(s) also in ${to.map((s) => s.heading).join(", ")}`, actual: missing.length ? `not found: ${missing.slice(0, 20).join(", ")}` : "all found", evidence })];
}

function valuesInText(c: Extract<ComputeCheck, { kind: "values_in_text" }>, { doc, items }: Ctx): Res[] {
  if (!doc) return [result({ ok: null, detail: "No document to read." })];
  const secs = c.specKeys.length ? sectionsFor(doc, c.specKeys) : [];
  const body = c.specKeys.length ? secs.map((s) => s.text).join("\n") : doc.text;
  const lower = body.toLowerCase();
  const out: Res[] = [];
  for (const item of items) {
    const label = text(item.fields[c.labelField]);
    const value = text(item.fields[c.valueField]);
    if (label.length < 2 || !value) continue;
    const at: number[] = [];
    for (let i = lower.indexOf(label.toLowerCase()); i >= 0 && at.length < 20; i = lower.indexOf(label.toLowerCase(), i + 1)) at.push(i);
    if (!at.length) continue;
    // The value's first number ("SS 85 (16th percentile)" → 85); a value with none is matched as text.
    const firstNumber = numbersIn(value)[0] ?? null;
    const found = at.some((i) => {
      const near = body.slice(Math.max(0, i - NEAR_CHARS), i + label.length + NEAR_CHARS);
      return firstNumber ? hasNumber(new Set(numbersIn(near)), firstNumber) : near.toLowerCase().includes(value.toLowerCase());
    });
    const quote = clip(body.slice(at[0], at[0] + label.length + 120).trim(), 600);
    const sec = doc.sections.find((s) => s.text.toLowerCase().includes(label.toLowerCase()));
    const evidence = [itemLink(item, label), ...(sec ? [link({ kind: "document", ref: sec.sectionId, label: clip(sec.heading, 300), quote })] : [])];
    out.push(result({ label: `${c.label}: ${clip(label, 120)}`, ok: found, expected: clip(value, 200), actual: found ? "found near the name" : "not found within 200 characters of the name", evidence }));
  }
  return out.length ? out : [result({ ok: null, detail: "None of the items is named in the text." })];
}

function deadlineCheck(c: Extract<ComputeCheck, { kind: "deadline" }>, { items }: Ctx): Res[] {
  const item = items.find((i) => toDate(i.fields[c.startField]));
  // With byKind the item's kind picks the period (a final report's 120 days,
  // not the annual 90); an unmapped or unstated kind is not assessed.
  let ref = c.requirement;
  if (c.byKind) {
    const kind = item ? fold(text(item.fields[c.byKind.field])).replace(/[\s-]+/g, "_") : "";
    ref = kind && Object.hasOwn(c.byKind.requirements, kind) ? c.byKind.requirements[kind] : null;
    if (item && !ref) {
      const said = kind ? `${c.byKind.field.replace(/_/g, " ")} “${text(item.fields[c.byKind.field])}”` : `no ${c.byKind.field.replace(/_/g, " ")} stated`;
      return [result({ ok: null, actual: said, detail: `Not assessed: ${(c.byKind.notAssessed || "no due-date rule for this kind").replace(/\.$/, "")}.`, evidence: [itemLink(item, said)] })];
    }
    ref ??= Object.values(c.byKind.requirements)[0] ?? null;
  }
  const r = ref ? requirementItem(ref) : null;
  if (!ref || !r || typeof r.item.value !== "number" || !r.item.unit) return [result({ ok: null, detail: `Unknown requirement ${ref ?? "(none)"}.` })];
  const reqLink = requirementLink(ref, r.item.title, r.item.citation);
  if (!item) return [result({ ok: null, detail: `No ${c.startField.replace(/_/g, " ")} found.`, evidence: [reqLink] })];
  const start = toDate(item.fields[c.startField])!;
  const unit = r.item.unit;
  const end = c.endField ? toDate(item.fields[c.endField]) : null;
  if (unit === "years") {
    // Whole calendar years (the IDEA three-year reevaluation); no extension applies.
    const due = addYears(start, r.item.value);
    return [
      result({
        ok: end ? end <= due : null,
        expected: `by ${due} (${fmt(r.item.value)} year(s) from ${start})`,
        actual: end ? `stated ${end}` : "",
        evidence: [itemLink(item, start), reqLink],
      }),
    ];
  }
  const weekdays = unit === "school_days" || unit === "business_days";
  if (!weekdays && unit !== "calendar_days") return [result({ ok: null, detail: `A deadline in ${unit} cannot be computed.`, evidence: [reqLink] })];
  let days = r.item.value;
  const notes: string[] = [];
  const extra = c.extendByField ? toNumber(item.fields[c.extendByField]) : null;
  if (extra !== null && extra > 0 && extra >= c.extendWhenAtLeast) {
    days += extra;
    notes.push(`extended by ${fmt(extra)} day(s) (${c.extendByField!.replace(/_/g, " ")})`);
  }
  const due = addDays(start, days, weekdays);
  if (weekdays) notes.push("school calendar not linked; holidays and breaks not counted");
  if (c.byKind) notes.push(`${text(item.fields[c.byKind.field])}: ${r.item.title}`);
  const unitWord = unit.replace(/_/g, " ");
  return [
    result({
      ok: end ? end <= due : null,
      expected: `by ${due} (${fmt(days)} ${unitWord} from ${start})`,
      actual: end ? `stated ${end}` : "",
      approximate: weekdays,
      detail: notes.join("; "),
      evidence: [itemLink(item, start), reqLink],
    }),
  ];
}

function tableChecks(c: Extract<ComputeCheck, { kind: "table_rows_equal" | "table_row_min" }>, { tables }: Ctx): Res[] {
  const matching = tables.filter((t) => t.name.toLowerCase().includes(c.tableMatch.toLowerCase()));
  if (!matching.length) return [result({ ok: null, detail: `No linked table named like “${c.tableMatch}”.` })];
  return matching.map((t) => {
    const evidence = [tableLink(t)];
    const label = matching.length > 1 ? `${c.label}: ${t.name}` : undefined;
    const cols = numericColumns(t);
    if (c.kind === "table_row_min") {
      const rows = rowsLabelled(t, c.row);
      if (!rows.length) return result({ label, ok: null, detail: `No “${c.row}” row.`, evidence });
      const read = cols.some(({ i }) => rows.some((r) => toNumber(r[i]) !== null));
      if (!read) return result({ label, ok: null, detail: "No numbers in the row.", evidence });
      // Financing raised up to and including each column (coveredBy rows, summed).
      const cover = c.coveredBy.flatMap((l) => rowsLabelled(t, l).slice(0, 1));
      let raised = 0;
      const below: string[] = [];
      const covered: string[] = [];
      for (const { c: col, i } of cols) {
        raised += cover.reduce((a, r) => a + Math.max(toNumber(r[i]) ?? 0, 0), 0);
        for (const r of rows) {
          const v = toNumber(r[i]);
          if (v === null || v >= c.min) continue;
          (cover.length && raised >= c.min - v ? covered : below).push(`${col.label}: ${fmt(v)}`);
        }
      }
      const expected = `at least ${fmt(c.min)} in every column${c.coveredBy.length ? `, or financing (${c.coveredBy.join(", ")}) covering the shortfall` : ""}`;
      const actual = below.length
        ? `below in ${below.slice(0, 12).join("; ")}${cover.length ? "" : c.coveredBy.length ? "; no financing row" : ""}`
        : covered.length
          ? `below in ${covered.slice(0, 12).join("; ")}, covered by financing shown`
          : "every value at or above";
      return result({ label, ok: !below.length, expected, actual, evidence });
    }
    const left = c.left.map((l) => rowsLabelled(t, l));
    const right = c.right.map((l) => rowsLabelled(t, l));
    const absent = [...c.left.filter((_, i) => !left[i].length), ...c.right.filter((_, i) => !right[i].length)];
    if (absent.length) return result({ label, ok: null, detail: `No row for ${absent.map((a) => `“${a}”`).join(", ")}.`, evidence });
    /** The column's total over the first matching row of each label, or null when one doesn't read as a number. */
    const sumAt = (groups: Array<Array<Array<string | null>>>, i: number): number | null => {
      let total = 0;
      for (const rows of groups) {
        const v = toNumber(rows[0][i]);
        if (v === null) return null;
        total += v;
      }
      return total;
    };
    const off: string[] = [];
    let compared = 0;
    for (const { c: col, i } of cols) {
      const [l, r] = [sumAt(left, i), sumAt(right, i)];
      if (l === null || r === null) continue;
      compared++;
      if (!within(l, r, c.tolerance)) off.push(`${col.label}: ${fmt(l)} vs ${fmt(r)}`);
    }
    if (!compared) return result({ label, ok: null, detail: "No column has numbers in every row compared.", evidence });
    return result({ label, ok: !off.length, expected: `${c.left.join(" + ")} = ${c.right.join(" + ")}`, actual: off.length ? off.slice(0, 12).join("; ") : `equal in ${compared} column(s)`, evidence });
  });
}

function runOne(c: ComputeCheck, input: Ctx): Res[] {
  switch (c.kind) {
    case "length":
      return lengthCheck(c, input);
    case "sum":
      return sumCheck(c, input);
    case "product":
    case "ratio":
    case "percent_of":
      return perItem(c, input);
    case "equal":
      return equalCheck(c, input);
    case "date_order":
      return dateOrder(c, input);
    case "count":
      return countCheck(c, input);
    case "numbers_match":
      return numbersMatch(c, input);
    case "values_in_text":
      return valuesInText(c, input);
    case "deadline":
      return deadlineCheck(c, input);
    case "table_rows_equal":
    case "table_row_min":
      return tableChecks(c, input);
  }
}

/** The check's finding kind: values_in_text reports a value_mismatch, the rest compute_<kind>. */
const findingKind = (c: ComputeCheck) => (c.kind === "values_in_text" ? "value_mismatch" : `compute_${c.kind}`);

export function runComputeChecks(nodeId: string, checks: ComputeCheck[], input: ComputeInput): ComputeOutput {
  const results: ComputeResult[] = [];
  const findings = new Findings(nodeId);
  for (const c of checks) {
    for (const r of runOne(c, input)) {
      const res: ComputeResult = { ...r, key: c.key, label: clip(r.label ?? c.label, 300) };
      results.push(res);
      if (res.ok !== false) continue;
      const section = res.evidence.find((e) => e.kind === "document");
      const sec = section && input.doc?.sections.find((s) => s.sectionId === section.ref);
      findings.add({
        kind: findingKind(c),
        severity: c.severity,
        status: "failed",
        title: res.label,
        detail: [res.expected && `Expected ${res.expected}`, res.actual && `found ${res.actual}`, res.detail].filter(Boolean).join("; ") + ".",
        location: sec ? { sectionId: sec.sectionId, specKey: sec.specKey, heading: sec.heading, quote: section.quote } : null,
        evidence: res.evidence,
      });
    }
  }
  const okText = (ok: boolean | null) => (ok === null ? "Could not compute" : ok ? "OK" : "Mismatch");
  const table = outcomeTable(
    `${nodeId}:compute`,
    "Recalculated",
    [
      { key: "check", label: "Check" },
      { key: "expected", label: "Expected" },
      { key: "actual", label: "Found" },
      { key: "result", label: "Result" },
    ],
    results.map((r) => ({ cells: { check: r.label, expected: r.expected, actual: r.actual + (r.approximate ? " (estimate)" : ""), result: okText(r.ok) }, status: r.ok === null ? null : r.ok ? "ok" : "failed", evidence: r.evidence })),
  );
  return { results, findings: findings.list(), table };
}

/**
 * Pure: changed lines (doc.write's `lines`, the lines the author accepted) as items a count
 * can read: fields action and section, status the author's result. The resume's decide step
 * gets "lines changed: N accepted" from this count, never from the tailor step's proposed count.
 */
export function changedLineItems(v: unknown): ExtractedItem[] {
  return flat<ChangedLine>(v)
    .filter((l) => typeof l === "object" && l !== null && l.kind === CHANGED_LINE_KIND && typeof l.id === "string")
    .map((l) => ({ id: l.id, fields: { action: l.action, section: l.heading }, location: null, evidence: [], status: l.result }));
}

export const computeHandler: NodeHandler = async (inputs, node) => {
  const checks = node.config.checks as ComputeCheck[];
  const items = [...asItems(inputs.items), ...changedLineItems(inputs.items)];
  return runComputeChecks(node.node.id, checks, { doc: asDoc(inputs.document), items, tables: asTables(inputs.data) });
};
