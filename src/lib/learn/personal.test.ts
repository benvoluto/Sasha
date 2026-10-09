import { describe, expect, it } from "vitest";
import type { DocumentTypeDefinition } from "@/catalog/schema";
import type { WorkflowDefinition } from "@/catalog/workflow-schema";
import { EXAMPLE_A, EXAMPLE_B, typeDraft, workflowDraft } from "./__fixtures__/learn-reply";
import { findPersonalDetails, personalInKey, PLACEHOLDERS, properNounSpans, scrubPersonalDetails, scrubText, unkeptPersonalDetails } from "./personal";

const withGuidance = (...guidance: string[]) => ({
  type: typeDraft({ sections: guidance.map((g, i) => ({ key: `s${i}`, heading: `Section ${i}`, order: (i + 1) * 10, guidance: g, elements: [] })) }) as unknown as DocumentTypeDefinition,
});
const examples = [{ text: EXAMPLE_A, headings: ["Equipment request", "Summary", "Justification", "Costs", "Approval"] }, { text: EXAMPLE_B }];

describe("properNounSpans", () => {
  it("finds names and organizations used mid-sentence, not headings, sentence openings, public bodies or catalog vocabulary", () => {
    const spans = properNounSpans(`${EXAMPLE_A}\n${EXAMPLE_B}\nThe form follows the Department of Education rules. Specific Aims come first.`, ["Equipment request"], "specific aims");
    expect(spans).toEqual(
      expect.arrayContaining([
        { text: "Marisol Quintanilla Ortega", kind: "name" },
        { text: "Riverbend Community College", kind: "organization" },
      ]),
    );
    const texts = spans.map((s) => s.text);
    expect(texts).not.toContain("Equipment request");
    expect(texts.some((t) => t.includes("Department"))).toBe(false);
    expect(texts).not.toContain("Specific Aims");
  });
});

describe("properNounSpans: names in headings, names used alone, and tests", () => {
  const FIE = "# Evaluation Report for Jordan Alvarez\n\n## Cognitive\nThis report describes the evaluation of Jordan Alvarez, a fourth grader at the school. Testing used the Wechsler Intelligence Scale for Children and the Woodcock Johnson Tests of Achievement; the Woodcock Johnson scores were consistent. Jordan's reading was below grade level.";
  const heads = ["Evaluation Report for Jordan Alvarez", "Cognitive"];

  it("keeps the person named in the title heading, and finds their first name used alone", () => {
    const texts = properNounSpans(FIE, heads, "").map((s) => s.text);
    expect(texts).toEqual(expect.arrayContaining(["Jordan Alvarez", "Jordan"]));
    expect(texts).not.toContain("Evaluation Report");
    // A resume titled with the name alone, never used mid-sentence.
    expect(properNounSpans("# Jane Doe\n\n## Experience\nLed a team of five.", ["Jane Doe", "Experience"], "").map((s) => s.text)).toEqual(["Jane Doe"]);
    // A first heading that is a section, not a level-1 title, is section vocabulary.
    expect(properNounSpans("## Present Levels\nSee the Present Levels below.", ["Present Levels"], "")).toEqual([]);
  });

  it("does not take published tests (or their authors' names on their own) for people", () => {
    const texts = properNounSpans(FIE, heads, "").map((s) => s.text);
    expect(texts.some((t) => /Wechsler|Woodcock|Scale|Tests/.test(t))).toBe(false);
  });

  it("flags the name in guidance at extraction and at save", () => {
    const ex = [{ text: FIE, headings: heads }];
    const d = withGuidance("Summarize how Jordan Alvarez performed, then what Jordan's teacher reported. Report the Wechsler Intelligence Scale for Children composite.");
    expect(scrubPersonalDetails(d, ex, [], "").draft.type.sections[0].guidance).toBe("Summarize how [Name] performed, then what [Name]'s teacher reported. Report the Wechsler Intelligence Scale for Children composite.");
    expect(findPersonalDetails(d, ex, [], "").map((f) => f.text)).toEqual(["Jordan Alvarez", "Jordan"]);
  });
});

describe("all-caps names and organizations (resume and form headers)", () => {
  const RESUME = "# JORDAN ALVAREZ\n\nSTUDENT: JORDAN ALVAREZ\n\n## WORK EXPERIENCE\n\nSenior engineer at ACME CORP since 2019, working with Priya Raman. Jordan led the platform team.\n\n## IEP PROGRESS REPORT\nNotes.";
  const heads = ["JORDAN ALVAREZ", "WORK EXPERIENCE", "IEP PROGRESS REPORT"];

  it("finds an all-caps title name, a header-line name and an all-caps organization, not caps section headings", () => {
    const spans = properNounSpans(RESUME, heads, "");
    expect(spans).toEqual(
      expect.arrayContaining([
        { text: "JORDAN ALVAREZ", kind: "name", caseless: true },
        { text: "ACME CORP", kind: "organization", caseless: true },
        { text: "Priya Raman", kind: "name" },
        { text: "Jordan", kind: "name" },
      ]),
    );
    const texts = spans.map((s) => s.text);
    expect(texts).not.toContain("WORK EXPERIENCE");
    expect(texts.some((t) => t.includes("PROGRESS"))).toBe(false);
  });

  it("matches them in the draft in any case, at extraction and at save", () => {
    const ex = [{ text: RESUME, headings: heads }];
    const d = withGuidance("Lead with the name, as in JORDAN ALVAREZ | ACME CORP, or Jordan Alvarez at Acme Corp.");
    expect(scrubPersonalDetails(d, ex, [], "").draft.type.sections[0].guidance).toBe("Lead with the name, as in [Name] | [Organization], or [Name] at [Organization].");
    expect(findPersonalDetails(d, ex, [], "").map((f) => f.text)).toEqual(["JORDAN ALVAREZ", "Jordan Alvarez", "ACME CORP", "Acme Corp"]);
  });

  it("reads an acronym organization word in caps", () => {
    expect(properNounSpans("# IEP\n\nDistrict: RIVERBEND ISD", [], "")).toEqual([{ text: "RIVERBEND ISD", kind: "organization", caseless: true }]);
  });

  it("accepts a model hint written in another case than the example", () => {
    const ex = [{ text: "# SAM ORTIZ-LEE\n\nSummary.", headings: [] }];
    expect(findPersonalDetails(withGuidance("Put Sam Ortiz-Lee first."), ex, [{ text: "Sam Ortiz-Lee", kind: "name" }], "").map((f) => f.text)).toEqual(["Sam Ortiz-Lee"]);
  });
});

describe("personal details in an outcome value", () => {
  it("finds a name in an outcome description", () => {
    const wf = workflowDraft({ outcome: { label: "Outcome", values: [{ key: "ready", label: "Ready", description: "Ready when Marisol Quintanilla Ortega approves." }, { key: "revise", label: "Revise" }] } });
    const flags = findPersonalDetails({ workflow: wf as unknown as WorkflowDefinition }, examples, [], "");
    expect(flags.map((f) => [f.path, f.text])).toEqual([["workflow.outcome.values.ready.description", "Marisol Quintanilla Ortega"]]);
  });
});

describe("personalInKey and scrubText", () => {
  const FIE = { text: "# Evaluation Report for Jordan Alvarez\n\nThe evaluation of Jordan Alvarez found needs.", headings: ["Evaluation Report for Jordan Alvarez"] };

  it("finds a name a key spells out, and nothing in a key without one", () => {
    expect(personalInKey("evaluation-report-for-jordan-alvarez", [FIE], [], "")).toEqual(expect.arrayContaining(["Jordan Alvarez"]));
    expect(personalInKey("evaluation-report-for-name", [FIE], [], "")).toEqual([]);
    expect(scrubText("Evaluation Report for Jordan Alvarez", [FIE], [], "")).toBe("Evaluation Report for [Name]");
  });
});

describe("unkeptPersonalDetails", () => {
  it("lets a kept name or organization pass, never a pattern", () => {
    const flags = [
      { path: "p", text: "Riverbend Community College", kind: "organization" as const, removed: false },
      { path: "p", text: "Jane Doe", kind: "name" as const, removed: false },
      { path: "p", text: "a@b.org", kind: "email" as const, removed: false },
    ];
    expect(unkeptPersonalDetails(flags, ["Riverbend Community College", "a@b.org"]).map((f) => f.text)).toEqual(["Jane Doe", "a@b.org"]);
  });
});

describe("scrubPersonalDetails", () => {
  it("replaces patterns (email, phone, date of birth, ID, address) with placeholders and flags them removed", () => {
    const d = withGuidance(
      "Contact marisol.q@example.org or (512) 555-0147 before sending.",
      "Student born on 03/14/2012, ID: 88123456, lives at 4120 Oak Hollow Drive.",
      "SSN 123-45-6789 must never appear.",
    );
    const { draft, flags } = scrubPersonalDetails(d, examples);
    const g = draft.type.sections.map((s) => s.guidance);
    expect(g[0]).toBe(`Contact ${PLACEHOLDERS.email} or ${PLACEHOLDERS.phone} before sending.`);
    expect(g[1]).toBe(`Student ${PLACEHOLDERS.date_of_birth}, ${PLACEHOLDERS.id_number}, lives at ${PLACEHOLDERS.address}.`);
    expect(g[2]).toContain(PLACEHOLDERS.id_number);
    expect(flags.map((f) => f.kind).sort()).toEqual(["address", "date_of_birth", "email", "id_number", "id_number", "phone"]);
    expect(flags.every((f) => f.removed)).toBe(true);
    expect(flags[0].path).toBe("type.sections.s0.guidance");
  });

  it("replaces names and organizations that came from an example, and the model's hints when an example has them", () => {
    const d = withGuidance("Name the requester (as Marisol Quintanilla Ortega did) and the site, e.g. Riverbend Community College.", "Mention Quintanilla only once.");
    const { draft, flags } = scrubPersonalDetails(d, examples, [
      { text: "Quintanilla", kind: "name" },
      { text: "Not In Any Example", kind: "name" },
    ]);
    expect(draft.type.sections[0].guidance).toBe("Name the requester (as [Name] did) and the site, e.g. [Organization].");
    expect(draft.type.sections[1].guidance).toBe("Mention [Name] only once.");
    expect(flags.map((f) => [f.kind, f.text]).sort()).toEqual([
      ["name", "Marisol Quintanilla Ortega"],
      ["name", "Quintanilla"],
      ["organization", "Riverbend Community College"],
    ]);
  });

  it("leaves pattern-free, name-free drafts alone", () => {
    const d = withGuidance("List each cost line and the total.");
    expect(scrubPersonalDetails(d, examples).flags).toEqual([]);
  });
});

describe("findPersonalDetails (the save route's check)", () => {
  it("reports what is left without changing anything, removed: false", () => {
    const flags = findPersonalDetails(withGuidance("Ask Marisol Quintanilla Ortega."), examples);
    expect(flags).toEqual([{ path: "type.sections.s0.guidance", text: "Marisol Quintanilla Ortega", kind: "name", removed: false }]);
    expect(findPersonalDetails(withGuidance("Ask [Name]."), examples)).toEqual([]);
  });
});

describe("roles, offices and funds are not personal details", () => {
  const REPORT =
    "# City of Maple Grove Springs — City Council Staff Report\n\n**Prepared by:** Dana Whitfield, Transportation Engineer\n\n## Recommendation\nAuthorize the City Manager to execute the contract with Northline Paving. There is no impact on the General Fund; the City Council adopted the plan.";
  const heads = ["City of Maple Grove Springs — City Council Staff Report", "Recommendation"];

  it("flags the people, places and firms, not the roles and funds every city has", () => {
    const texts = properNounSpans(REPORT, heads, "").map((s) => s.text);
    expect(texts).toEqual(expect.arrayContaining(["Dana Whitfield", "Northline Paving", "Maple Grove Springs"]));
    for (const generic of ["City Manager", "General Fund", "City Council", "City Council Staff Report"]) expect(texts).not.toContain(generic);
  });

  it("ignores a role the model pointed out, and keeps a type key named for the kind of document", () => {
    const ex = [{ text: REPORT, headings: heads }];
    const { draft, flags } = scrubPersonalDetails(withGuidance("Say whether the General Fund is affected and which City Manager signs."), ex, [{ text: "City Manager", kind: "name" }]);
    expect(flags).toEqual([]);
    expect((draft.type!.sections[0] as { guidance: string }).guidance).toContain("General Fund");
    expect(personalInKey("city-council-staff-report", ex, [{ text: "City Council Staff Report", kind: "organization" }])).toEqual([]);
    expect(personalInKey("northline-paving-report", ex)).toEqual(["Northline Paving"]);
  });
});
