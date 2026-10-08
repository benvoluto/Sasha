import { describe, expect, it } from "vitest";
import { DocumentTypeDefinition, parseDefinition, toTypeSummary } from "./schema";
import { minimalType } from "./test-fixtures";

const level = (score: number) => ({ score, descriptor: `level ${score}` });

describe("DocumentTypeDefinition", () => {
  it("accepts a minimal definition and applies defaults", () => {
    const r = parseDefinition(minimalType());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.definition.sections[0];
    expect(s).toMatchObject({ level: 2, required: true, renderer: "narrative", elements: [], sourcesNeeded: [], dataNeeded: [] });
    expect(r.definition).toMatchObject({ signals: [], aliases: [], rubric: [] });
  });

  it("is strict: unknown fields are rejected at the top level and in sections", () => {
    expect(parseDefinition({ ...minimalType(), extra: 1 }).ok).toBe(false);
    const t = minimalType();
    const r = parseDefinition({ ...t, sections: [{ ...(t.sections[0] as object), colour: "red" }] });
    expect(r.ok).toBe(false);
  });

  it("rejects duplicate section and rubric keys", () => {
    const dupSections = parseDefinition(minimalType({ sections: [{ key: "a", heading: "A", order: 1, guidance: "g" }, { key: "a", heading: "B", order: 2, guidance: "g" }] }));
    expect(dupSections.ok).toBe(false);
    if (!dupSections.ok) expect(dupSections.errors.join()).toMatch(/duplicate section key "a"/);
    const crit = { key: "c", criterion: "C", levels: [level(2), level(1)] };
    const dupRubric = parseDefinition(minimalType({ rubric: [crit, crit] }));
    expect(dupRubric.ok).toBe(false);
    if (!dupRubric.ok) expect(dupRubric.errors.join()).toMatch(/duplicate rubric key "c"/);
  });

  it("rejects appliesTo naming an unknown section and duplicate scores", () => {
    const r = parseDefinition(minimalType({ rubric: [{ key: "c", criterion: "C", levels: [level(2), level(1)], appliesTo: ["nope"] }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/unknown section key "nope"/);
    expect(parseDefinition(minimalType({ rubric: [{ key: "c", criterion: "C", levels: [level(2), level(2)] }] })).ok).toBe(false);
    expect(parseDefinition(minimalType({ rubric: [{ key: "c", criterion: "C", levels: [level(2), level(1)], appliesTo: ["ask"] }] })).ok).toBe(true);
  });

  it("rejects bad key formats", () => {
    for (const key of ["Upper", "under_score", "-lead", "a", "two--dashes", "sp ace"]) expect(parseDefinition(minimalType({ key })).ok, key).toBe(false);
    expect(parseDefinition(minimalType({ key: "ok-key-2" })).ok).toBe(true);
    expect(parseDefinition(minimalType({ sections: [{ key: "Bad Key", heading: "H", order: 1, guidance: "g" }] })).ok).toBe(false);
    expect(parseDefinition(minimalType({ sections: [{ key: "snake_case", heading: "H", order: 1, guidance: "g" }] })).ok).toBe(true);
  });

  it("rejects an alias equal to the type's own key, and bad renderers", () => {
    expect(parseDefinition(minimalType({ aliases: ["team-brief"] })).ok).toBe(false);
    expect(parseDefinition(minimalType({ sections: [{ key: "a", heading: "A", order: 1, guidance: "g", renderer: "fancy" }] })).ok).toBe(false);
    expect(parseDefinition(minimalType({ sections: [{ key: "a", heading: "A", order: 1, guidance: "g", renderer: "pack:fie-exclusion" }] })).ok).toBe(true);
  });

  it("toTypeSummary sorts sections by order", () => {
    const definition = DocumentTypeDefinition.parse(minimalType());
    const summary = toTypeSummary({ definition, origin: "team", enabled: true, overridden: false, updated_at: null });
    expect(summary.sections.map((s) => s.key)).toEqual(["ask", "context"]);
    expect(summary).toMatchObject({ key: "team-brief", origin: "team", enabled: true, overridden: false });
  });
});
