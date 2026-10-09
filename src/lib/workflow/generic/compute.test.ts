import { describe, expect, it } from "vitest";
import type { ExtractedItem } from "../contract";
import { ComputeCheck } from "../node-specs/generic";
import type { DocSnapshot, SectionView, TableView } from "../nodes/types";
import { addDays, addYears, changedLineItems, dependencyItem, numbersIn, runComputeChecks, toNumber } from "./compute";

const check = (c: Record<string, unknown>) => ComputeCheck.parse({ key: "k", label: "Check", ...c });
const item = (id: string, fields: ExtractedItem["fields"]): ExtractedItem => ({ id, fields, location: null, evidence: [] });

function section(specKey: string, heading: string, text: string): SectionView {
  return { sectionId: `s_${specKey}`, heading, level: 2, specKey, index: 0, text, wordCount: text.split(/\s+/).filter(Boolean).length, hasContent: !!text, renderer: "narrative", required: true };
}

function doc(sections: SectionView[], extra = ""): DocSnapshot {
  const text = [extra, ...sections.map((s) => `${s.heading}\n${s.text}`)].join("\n");
  return { id: "d1", title: "Doc", typeKey: null, typeTitle: null, updatedAt: "", wordCount: text.split(/\s+/).filter(Boolean).length, text, preamble: extra, sections, type: null };
}

const run = (c: Record<string, unknown>, input: Partial<Parameters<typeof runComputeChecks>[2]> = {}) => runComputeChecks("comp", [check(c)], { doc: null, items: [], tables: [], ...input });
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("number and date helpers", () => {
  it("reads money, percentages and thousands separators", () => {
    expect(toNumber("$1,234.50")).toBe(1234.5);
    expect(toNumber("12%")).toBe(12);
    expect(toNumber("(300)")).toBe(-300);
    expect(toNumber(7)).toBe(7);
    expect(toNumber("about ten")).toBeNull();
  });

  it("finds numbers in text, normalized, skipping small integers", () => {
    expect(numbersIn("Of 1,200 people, 45.0% (540) reported 3 visits in 2024.")).toEqual(["1200", "45%", "540", "2024"]);
  });

  it("adds weekdays for school days", () => {
    expect(addDays("2026-10-09", 1, true)).toBe("2026-10-12"); // Friday + 1 school day = Monday
    expect(addDays("2026-10-09", 1, false)).toBe("2026-10-10");
  });
});

describe("length", () => {
  const nih = doc([section("specific-aims", "Specific Aims", words(700)), section("research-strategy", "Research Strategy", words(4000)), section("approach", "Approach", words(2500))], "Activity code: R21");

  it("estimates pages from words against a requirement item, marked approximate", () => {
    const { results, findings } = run({ kind: "length", specKeys: ["specific-aims"], unit: "pages", requirement: "nih-page-limits#specific-aims" }, { doc: nih });
    expect(results[0]).toMatchObject({ ok: false, approximate: true, expected: "at most 1 pages", detail: "estimated from words; figures and formatting not counted" });
    expect(results[0].actual).toMatch(/about 2 pages \(700 words\)/);
    expect(findings[0]).toMatchObject({ kind: "compute_length", severity: "major", location: { sectionId: "s_specific-aims" } });
    expect(results[0].evidence.map((e) => e.kind)).toEqual(["document", "requirement"]);
  });

  it("picks the limit by the activity code the document names", () => {
    const { results } = run({ kind: "length", specKeys: ["research-strategy", "approach"], unit: "pages", requirementSet: "nih-page-limits" }, { doc: nih });
    expect(results[0]).toMatchObject({ ok: false, expected: "at most 6 pages" }); // 6500 words ≈ 13 pages
    const r01 = doc(nih.sections, "Activity code: R01");
    expect(run({ kind: "length", specKeys: ["research-strategy", "approach"], unit: "pages", requirementSet: "nih-page-limits" }, { doc: r01 }).results[0]).toMatchObject({ ok: false, expected: "at most 12 pages" });
  });

  it("gives ok null with no activity code, no limit, or no such section", () => {
    const none = doc(nih.sections);
    expect(run({ kind: "length", specKeys: ["approach"], unit: "pages", requirementSet: "nih-page-limits" }, { doc: none }).results[0].ok).toBeNull();
    expect(run({ kind: "length", unit: "words" }, { doc: none }).results[0]).toMatchObject({ ok: null, actual: expect.stringMatching(/words$/) });
    expect(run({ kind: "length", specKeys: ["missing"], unit: "words", limit: 10 }, { doc: none }).results[0].ok).toBeNull();
    expect(run({ kind: "length", unit: "words", limit: 100000 }, { doc: none }).results[0].ok).toBe(true);
  });
});

describe("sum, product, ratio, percent_of", () => {
  const items = [
    item("I1", { kind: "budget_line", name: "Design", amount: "$1,000" }),
    item("I2", { kind: "budget_line", name: "Build", amount: 2500 }),
    item("I3", { kind: "total", name: "Total", amount: "3,500" }),
  ];
  const sum = { kind: "sum", valueField: "amount", partWhere: { field: "kind", equals: "budget_line" }, totalWhere: { field: "kind", equals: "total" } };

  it("sums parts against each total", () => {
    expect(run(sum, { items }).results[0]).toMatchObject({ ok: true, expected: "3,500", actual: "3,500 (2 parts)" });
    const off = run(sum, { items: [...items.slice(0, 2), item("I3", { kind: "total", name: "Total", amount: 4000 })] });
    expect(off.results[0].ok).toBe(false);
    expect(off.findings[0]).toMatchObject({ kind: "compute_sum", title: "Check" });
  });

  it("gives ok null for an unreadable part or a missing total", () => {
    expect(run(sum, { items: [item("I1", { kind: "budget_line", amount: "TBD" }), items[2]] }).results[0].ok).toBeNull();
    expect(run(sum, { items: items.slice(0, 2) }).results[0].ok).toBeNull();
  });

  it("checks a × b = result per item, within tolerance", () => {
    const c = { kind: "product", aField: "rate", bField: "quantity", resultField: "amount" };
    const r = run(c, { items: [item("A", { name: "Dev", rate: 100, quantity: 10, amount: 1000 }), item("B", { name: "QA", rate: "$80", quantity: 5, amount: 450 }), item("C", { name: "PM", rate: 50 })] });
    expect(r.results.map((x) => x.ok)).toEqual([true, false]);
    expect(r.results[1].actual).toBe("80 × 5 = 400");
    expect(r.findings).toHaveLength(1);
  });

  it("checks two fields agree per item", () => {
    const r = run({ kind: "equal", aField: "net_income", bField: "cf_net_income" }, { items: [item("P1", { period: "2026", net_income: 1000, cf_net_income: "$1,000" }), item("P2", { period: "2027", net_income: 2000, cf_net_income: 1500 }), item("P3", { period: "2028", net_income: 10 })] });
    expect(r.results.map((x) => x.ok)).toEqual([true, false]);
    expect(r.results[1]).toMatchObject({ label: "Check: 2027", expected: "net_income 2,000", actual: "cf_net_income 1,500" });
    expect(run({ kind: "equal", aField: "a", bField: "b" }, { items: [item("X", { a: 1 })] }).results[0].ok).toBeNull();
  });

  it("computes ratios, informational when there is no result field", () => {
    const runway = run({ kind: "ratio", aField: "cash", bField: "burn", resultField: "runway" }, { items: [item("P1", { period: "2027", cash: 120000, burn: 10000, runway: 12 })] });
    expect(runway.results[0]).toMatchObject({ ok: true, label: "Check: 2027" });
    const share = run({ kind: "ratio", aField: "revenue", bField: "market_size", resultField: null }, { items: [item("P1", { revenue: 1e6, market_size: 1e8 })] });
    expect(share.results[0]).toMatchObject({ ok: null, actual: "1,000,000 ÷ 100,000,000 = 0.01" });
    expect(run({ kind: "ratio", aField: "a", bField: "b", resultField: "c" }, { items: [item("X", { a: 1, b: 0, c: 1 })] }).results[0].ok).toBeNull();
  });

  it("checks percentages of a whole", () => {
    const r = run({ kind: "percent_of", partField: "n", wholeField: "total", percentField: "pct" }, { items: [item("A", { n: 45, total: 120, pct: "37.5%" }), item("B", { n: 10, total: 40, pct: "30%" })] });
    expect(r.results.map((x) => x.ok)).toEqual([true, false]);
  });
});

describe("date_order and count", () => {
  const c = { kind: "date_order", dateField: "date", idField: "name", dependsOnField: "depends_on", labelField: "name" };
  it("flags an item dated before what it depends on", () => {
    const r = run(c, {
      items: [item("A", { name: "Design", date: "2027-01-10" }), item("B", { name: "Build", date: "2027-01-05", depends_on: "design" }), item("C", { name: "Launch", date: "2027-03-01", depends_on: "Build" }), item("D", { name: "Party", date: null, depends_on: "Launch" })],
    });
    expect(r.results.map((x) => x.ok)).toEqual([false, true, null]);
    expect(r.findings[0].kind).toBe("compute_date_order");
  });

  it("finds a dependency named by a short id inside the item's name (a live proposal's “D1” and “D1, Curriculum pack”)", () => {
    const items = [
      item("I1", { name: "D1, Curriculum pack", date: "2027-03-01" }),
      item("I2", { name: "D2, Facilitator training", date: "2027-03-12", depends_on: "D1" }),
      item("I3", { name: "D3, Course delivery", date: "2027-05-07", depends_on: "D2" }),
      item("I4", { name: "D4, Evaluation report", date: "2027-04-30", depends_on: "D3" }),
      item("I5", { name: "D10, Handover", date: "2027-06-01", depends_on: "D1" }),
    ];
    const r = run(c, { items });
    expect(r.results.map((x) => x.ok)).toEqual([true, true, false, true]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].title).toContain("D4, Evaluation report");
    // "D1" is a whole word of "D1, Curriculum pack" only, not of "D10, Handover"; an ambiguous name stays unmatched.
    expect(dependencyItem(items, "name", "D1", items[1])?.id).toBe("I1");
    expect(dependencyItem([...items, item("I6", { name: "D1 kickoff" })], "name", "D1", items[1])).toBeUndefined();
    expect(dependencyItem(items, "name", "D9", items[1])).toBeUndefined();
  });

  it("counts items against min and max", () => {
    const items = [item("A", { kind: "option" }), item("B", { kind: "option" }), item("C", { kind: "criterion" })];
    expect(run({ kind: "count", where: { field: "kind", equals: "option" }, min: 3 }, { items }).results[0]).toMatchObject({ ok: false, actual: "2" });
    expect(run({ kind: "count", max: 3 }, { items }).results[0].ok).toBe(true);
    expect(run({ kind: "count" }, { items }).results[0].ok).toBeNull();
  });

  it("counts traced items by trace status within the where filter, as n of m", () => {
    const traced = (id: string, priority: string, status: string) => ({ ...item(id, { priority }), status, rationale: "", linkedTargets: [] });
    const items = [traced("A", "required", "direct"), traced("B", "required", "adjacent"), traced("C", "required", "none"), traced("D", "preferred", "direct")];
    const met = run({ kind: "count", where: { field: "priority", equals: "required" }, status: ["direct"] }, { items }).results[0];
    expect(met).toMatchObject({ ok: null, actual: "1 of 3" });
    expect(run({ kind: "count", where: { field: "priority", equals: "required" }, status: ["direct", "adjacent"], min: 3 }, { items }).results[0]).toMatchObject({ ok: false, actual: "2 of 3" });
    expect(run({ kind: "count", status: ["direct"] }, { items }).results[0].actual).toBe("2 of 4");
    // Plain extracted items have no status, so none count.
    expect(run({ kind: "count", status: ["direct"] }, { items: [item("X", {})] }).results[0].actual).toBe("0 of 1");
  });

  it("counts doc.write's accepted lines (the resume's lines changed), never anything else as one", () => {
    const changed = (id: string, result: string) => ({ id, kind: "changed_line", action: "rewrite", sectionId: "e1", heading: "Experience", original: "a", proposed: "b", occurrence: 0, occurrences: 1, reason: "", requirementKeys: [], evidence: [], result, detail: "" });
    const items = changedLineItems([changed("L1", "accepted"), changed("L3", "accepted"), { id: "X", fields: {} }, null]);
    expect(items.map((i) => [i.id, (i as { status?: string }).status, i.fields.section])).toEqual([["L1", "accepted", "Experience"], ["L3", "accepted", "Experience"]]);
    const r = run({ kind: "count", label: "Lines changed" }, { items }).results[0];
    expect(r).toMatchObject({ ok: null, actual: "2" });
    expect(run({ kind: "count" }, { items: changedLineItems([]) }).results[0].actual).toBe("0");
  });
});

describe("numbers_match and values_in_text", () => {
  const d = doc([section("abstract", "Abstract", "Of 1,200 adults, 45% improved (p = 0.03)."), section("results", "Results", "We enrolled 1200 adults; 45.0% improved, p = 0.04.")]);

  it("lists abstract numbers missing from the results", () => {
    const r = run({ kind: "numbers_match", fromSpecKeys: ["abstract"], toSpecKeys: ["results"] }, { doc: d });
    expect(r.results[0]).toMatchObject({ ok: false, actual: "not found: 0.03" });
    expect(r.findings[0]).toMatchObject({ kind: "compute_numbers_match", location: { sectionId: "s_abstract" } });
    expect(run({ kind: "numbers_match", fromSpecKeys: ["missing"] }, { doc: d }).results[0].ok).toBeNull();
  });

  it("does not ask for years to reappear (a live report's introduction “September 2025 to August 2026” failed)", () => {
    const y = doc([section("introduction", "Introduction", "The pilot ran from September 2025 to August 2026 and lent 1,140 laptops."), section("findings", "Findings", "There were 1140 loans.")]);
    expect(run({ kind: "numbers_match", fromSpecKeys: ["introduction"] }, { doc: y }).results[0]).toMatchObject({ ok: true, actual: "all found" });
  });

  it("compares with the rest of the document when no target sections are named", () => {
    expect(run({ kind: "numbers_match", fromSpecKeys: ["results"] }, { doc: d }).results[0]).toMatchObject({ ok: false, actual: "not found: 0.04" });
  });

  it("fails a value not found near its label (value_mismatch), skips labels the text never names", () => {
    const fie = doc([section("cognitive_functioning", "Cognitive Functioning", "On the WISC-V the student earned a Full Scale IQ of 82, in the low average range. The KTEA-3 was not given.")]);
    const r = run({ kind: "values_in_text", labelField: "instrument", valueField: "result" }, {
      doc: fie,
      items: [item("I1", { instrument: "Full Scale IQ", result: "FSIQ 82" }), item("I2", { instrument: "KTEA-3", result: "SS 91" }), item("I3", { instrument: "BASC-3", result: "T 70" })],
    });
    expect(r.results.map((x) => x.ok)).toEqual([true, false]);
    expect(r.findings[0]).toMatchObject({ kind: "value_mismatch", location: { sectionId: "s_cognitive_functioning" } });
  });
});

describe("deadline", () => {
  const c = { kind: "deadline", startField: "consent_date", requirement: "tx-19tac-89-1011#fie-report", extendByField: "absences", extendWhenAtLeast: 3, endField: "report_date" };

  it("adds school days as weekdays, approximate, informational without a stated date", () => {
    const r = run(c, { items: [item("I1", { consent_date: "2026-09-01", absences: 2 })] });
    expect(r.results[0]).toMatchObject({ ok: null, approximate: true, expected: "by 2026-11-03 (45 school days from 2026-09-01)" });
    expect(r.results[0].detail).toMatch(/school calendar not linked; holidays and breaks not counted/);
    expect(r.findings).toHaveLength(0);
  });

  it("extends by absences when they reach the threshold, and fails a later stated date", () => {
    const r = run(c, { items: [item("I1", { consent_date: "2026-09-01", absences: 3, report_date: "2026-11-09" })] });
    expect(r.results[0].expected).toBe("by 2026-11-06 (48 school days from 2026-09-01)");
    expect(r.results[0]).toMatchObject({ ok: false, actual: "stated 2026-11-09" });
    expect(r.findings[0].kind).toBe("compute_deadline");
  });

  it("gives ok null without a start date", () => {
    expect(run(c, { items: [item("I1", { absences: 3 })] }).results[0].ok).toBeNull();
  });
  it("adds whole calendar years, failing a stated date after the due date", () => {
    const three = { kind: "deadline", startField: "last_evaluation_date", requirement: "idea-evaluation-34cfr#three-year", endField: "review_date" };
    const late = run(three, { items: [item("I1", { last_evaluation_date: "2023-10-02", review_date: "2026-10-05" })] });
    expect(late.results[0]).toMatchObject({ ok: false, expected: "by 2026-10-02 (3 year(s) from 2023-10-02)", actual: "stated 2026-10-05" });
    const open = run(three, { items: [item("I1", { last_evaluation_date: "2023-10-02" })] });
    expect(open.results[0]).toMatchObject({ ok: null, expected: "by 2026-10-02 (3 year(s) from 2023-10-02)" });
  });

  it("picks the period by report kind and does not assess an unmapped kind", () => {
    const byKind = {
      kind: "deadline",
      startField: "period_end",
      endField: "submitted",
      byKind: {
        field: "report_kind",
        requirements: { annual: "uniform-guidance-reporting#annual-report-due", interim: "uniform-guidance-reporting#interim-report-due", final: "uniform-guidance-reporting#final-report-due" },
        notAssessed: "NIH and NSF annual reports are due before the budget period ends",
      },
    };
    const period = (report_kind: string, submitted: string) => ({ items: [item("P", { kind: "period", period_end: "2026-06-30", submitted, report_kind })] });
    // Day 100: inside the final report's 120 days, past the annual 90.
    expect(run(byKind, period("Final", "2026-10-08")).results[0]).toMatchObject({ ok: true, expected: "by 2026-10-28 (120 calendar days from 2026-06-30)" });
    expect(run(byKind, period("annual", "2026-10-08")).results[0]).toMatchObject({ ok: false, expected: "by 2026-09-28 (90 calendar days from 2026-06-30)" });
    // Day 60: past the interim report's 30 days.
    expect(run(byKind, period("interim", "2026-08-29")).results[0]).toMatchObject({ ok: false, expected: "by 2026-07-30 (30 calendar days from 2026-06-30)" });
    const agency = run(byKind, period("agency_dated", "2026-07-30"));
    expect(agency.results[0]).toMatchObject({ ok: null, detail: "Not assessed: NIH and NSF annual reports are due before the budget period ends." });
    expect(agency.findings).toHaveLength(0);
    expect(run(byKind, period("", "2026-07-30")).results[0]).toMatchObject({ ok: null, actual: "no report kind stated" });
  });

  it("moves 29 February back to 28 February in a common year", () => {
    expect(addYears("2028-02-29", 3)).toBe("2031-02-28");
    expect(addYears("2028-02-29", 4)).toBe("2032-02-29");
    expect(addYears("2026-12-31", 1)).toBe("2027-12-31");
  });
});

describe("table checks", () => {
  const table = (name: string, rows: string[][]): TableView => ({
    id: `t_${name}`,
    name,
    sourceId: "src1",
    sourceTitle: "Model.xlsx",
    columns: [
      { key: "c0", label: "Line", type: "text", unit: null },
      { key: "c1", label: "2026", type: "currency", unit: "USD" },
      { key: "c2", label: "2027", type: "currency", unit: "USD" },
    ],
    rowCount: rows.length,
    rows,
  });
  const balance = table("Balance sheet", [
    ["Total assets", "$1,000", "$1,500"],
    ["Total liabilities", "$600", "$700"],
    ["Equity", "$400", "$700"],
  ]);
  const c = { kind: "table_rows_equal", tableMatch: "balance", left: ["total assets"], right: ["total liabilities", "equity"] };

  it("checks rows sum per column and links the table", () => {
    const r = run(c, { tables: [balance] });
    expect(r.results[0]).toMatchObject({ ok: false, actual: "2027: 1,500 vs 1,400" });
    expect(r.findings[0]).toMatchObject({ kind: "compute_table_rows_equal", evidence: [{ kind: "data", ref: "t_Balance sheet", sourceId: "src1" }] });
  });

  it("gives ok null with no matching table or row", () => {
    expect(run(c, { tables: [] }).results[0].ok).toBeNull();
    expect(run({ ...c, right: ["debt"] }, { tables: [balance] }).results[0].ok).toBeNull();
  });

  it("flags a row below its minimum", () => {
    const cash = table("Cash flow", [["Cash", "$5,000", "($200)"]]);
    const r = run({ kind: "table_row_min", tableMatch: "cash", row: "cash", min: 0 }, { tables: [cash] });
    expect(r.results[0]).toMatchObject({ ok: false, actual: "below in 2027: -200" });
  });

  it("passes a dip that financing shown covers, and fails one it doesn't", () => {
    const c = { kind: "table_row_min", tableMatch: "cash", row: "cash", min: 0, coveredBy: ["financing"] };
    const covered = run(c, { tables: [table("Cash flow", [["Cash", "$5,000", "($200)"], ["Financing", "", "$500"]])] });
    expect(covered.results[0]).toMatchObject({ ok: true, actual: "below in 2027: -200, covered by financing shown" });
    const short = run(c, { tables: [table("Cash flow", [["Cash", "$5,000", "($900)"], ["Financing", "$300", "$500"]])] });
    expect(short.results[0]).toMatchObject({ ok: false, actual: "below in 2027: -900" });
    const none = run(c, { tables: [table("Cash flow", [["Cash", "$5,000", "($200)"]])] });
    expect(none.results[0]).toMatchObject({ ok: false, actual: "below in 2027: -200; no financing row" });
  });
});

describe("output", () => {
  it("builds a table of every result, approximations marked", () => {
    const r = runComputeChecks("comp", [check({ kind: "length", unit: "pages", limit: 3 })], { doc: doc([section("a", "A", words(600))]), items: [], tables: [] });
    expect(r.table.rows[0].cells).toMatchObject({ check: "Check", result: "OK", actual: "about 2 pages (601 words) (estimate)" });
    expect(r.table.key).toBe("comp:compute");
  });
});
