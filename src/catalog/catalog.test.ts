/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import bundle from "./catalog.bundle.json";
import index from "./catalog.index.json";
import { fileTypeByKey, fileTypes, resolveFileTypeKey } from "./files";
import { parseDefinition, type DocumentTypeDefinition } from "./schema";
import { minimalType } from "./test-fixtures";
import { rubricFor, UNIVERSAL_RUBRIC } from "./universal-rubric";

const files = import.meta.glob("./types/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const nameOf = (path: string) => path.replace(/^\.\/types\//, "").replace(/\.json$/, "");

describe("catalog files", () => {
  it("has the pipeline's own types", () => {
    expect(Object.keys(files).map(nameOf)).toEqual(expect.arrayContaining(["general-report", "proposal"]));
  });

  for (const [path, raw] of Object.entries(files)) {
    it(`${nameOf(path)} is valid and its file name is its key`, () => {
      const r = parseDefinition(raw);
      expect(r.ok ? [] : r.errors).toEqual([]);
      if (r.ok) expect(r.definition.key).toBe(nameOf(path));
    });
  }

  it("puts a scaffold only on static front matter", () => {
    // A narrative section's scaffold would seed text that Draft replaces unseen (draft prompts don't
    // include the body) and that makes an unwritten section look written; field lists go in guidance.
    const scaffolded = Object.values(files)
      .map((f) => parseDefinition(f))
      .flatMap((r) => (r.ok ? r.definition.sections.filter((s) => s.scaffold?.trim()).map((s) => [`${r.definition.key}/${s.key}`, s.renderer]) : []));
    expect(scaffolded.length).toBeGreaterThan(0);
    for (const [where, renderer] of scaffolded) expect([where, renderer]).toEqual([where, "static"]);
  });

  it("aliases are unique across types and never equal a key", () => {
    const defs = Object.values(files).map((f) => parseDefinition(f)).filter((r) => r.ok).map((r) => (r as { definition: DocumentTypeDefinition }).definition);
    const keys = new Set(defs.map((d) => d.key));
    const aliases = defs.flatMap((d) => d.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const a of aliases) expect(keys.has(a), a).toBe(false);
  });

  it("the bundle and index are in sync with the files (run npm run catalog:build)", () => {
    const fromFiles = Object.values(files)
      .map((f) => f as { key: string; version: number })
      .map((f) => `${f.key}@${f.version}`)
      .sort();
    expect((bundle as Array<{ key: string; version: number }>).map((d) => `${d.key}@${d.version}`)).toEqual(fromFiles);
    expect((index as Array<{ key: string; version: number }>).map((d) => `${d.key}@${d.version}`)).toEqual(fromFiles);
  });

  it("general-report answers to its legacy key and keeps the legacy section keys", () => {
    expect(resolveFileTypeKey("general_report")).toBe("general-report");
    expect(fileTypeByKey("general_report")?.sections.map((s) => s.key)).toEqual(["introduction", "background", "findings", "discussion", "recommendations"]);
    expect(fileTypeByKey("general-report")?.preamble).not.toMatch(/Ground every statement/);
  });

  it("proposal ports the Phase 1 outline", () => {
    const p = fileTypeByKey("proposal");
    expect(p?.family).toBe("business");
    expect(p?.sections.map((s) => s.key)).toEqual(["summary", "reason", "objectives", "approach", "timeline", "budget", "evaluation"]);
    for (const s of p?.sections ?? []) expect(s.elements.length).toBeGreaterThan(1);
  });

  it("fileTypes are sorted by title with sections sorted by order", () => {
    const titles = fileTypes().map((t) => t.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    for (const t of fileTypes()) {
      const orders = t.sections.map((s) => s.order);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    }
  });
});

describe("rubricFor", () => {
  it("is the five universal criteria plus the type's own", () => {
    expect(UNIVERSAL_RUBRIC.map((c) => c.key)).toEqual(["clarity", "concision", "audience_fit", "structure", "evidence"]);
    for (const c of UNIVERSAL_RUBRIC) expect(c.levels.map((l) => l.score)).toEqual([4, 3, 2, 1]);
    const own = { key: "fit", criterion: "Fit", levels: [{ score: 2, descriptor: "a" }, { score: 1, descriptor: "b" }] };
    const def = parseDefinition(minimalType({ rubric: [own] }));
    if (!def.ok) throw new Error(def.errors.join());
    expect(rubricFor(def.definition).map((c) => c.key)).toEqual(["clarity", "concision", "audience_fit", "structure", "evidence", "fit"]);
  });

  it("a type criterion with a universal key replaces it in place", () => {
    const evidence = { key: "evidence", criterion: "Cites the record", levels: [{ score: 2, descriptor: "a" }, { score: 1, descriptor: "b" }] };
    const def = parseDefinition(minimalType({ rubric: [evidence] }));
    if (!def.ok) throw new Error(def.errors.join());
    const r = rubricFor(def.definition);
    expect(r).toHaveLength(5);
    expect(r[4].criterion).toBe("Cites the record");
  });
});

describe("fie", () => {
  it("never asks a draft to answer the referral questions, which would state the team's determination", () => {
    const fie = fileTypeByKey("fie")!;
    const texts = [
      ...fie.sections.flatMap((s) => [s.guidance, ...s.elements]),
      ...fie.rubric.flatMap((r) => [r.criterion, ...r.levels.map((l) => l.descriptor)]),
    ];
    const offending = texts.filter((t) => /\banswer(s|ed|ing)?\b/i.test(t) && /referral/i.test(t));
    expect(offending).toEqual([]);
    const eligibility = fie.sections.find((s) => s.key === "eligibility_determination")!;
    expect(eligibility.elements).toContain("Evidence bearing on each referral question, citing the earlier section (no conclusion)");
  });

  it("keeps its section keys and alias, and opens with static front matter holding only placeholders", () => {
    const fie = fileTypeByKey("fie_basic")!;
    expect(fie.key).toBe("fie");
    expect(fie.version).toBeGreaterThan(1);
    const keys = fie.sections.map((s) => s.key);
    // The type workflow (type-fie) and stored documents refer to these keys.
    for (const k of ["student_background", "reason_for_referral", "assessment_procedures", "cognitive_functioning", "academic_functioning", "social_emotional_behavioral", "exclusionary_factors", "eligibility_determination", "recommendations"]) expect(keys).toContain(k);
    expect(fie.sections.length).toBeLessThanOrEqual(12);
    const front = fie.sections[0];
    expect(front).toMatchObject({ key: "front_matter", renderer: "static" });
    for (const field of ["Date of birth", "Grade", "Evaluation type", "Referral date", "Consent received", "Evaluation dates", "Suspected disability categories", "Role and credential"]) expect(front.scaffold).toContain(field);
    // Every value is a bracketed placeholder: no student data ships in the type.
    const cells = front.scaffold!.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Field") && !l.startsWith("| Name")).flatMap((l) => l.split("|").slice(2, -1).map((c) => c.trim()));
    expect(cells.length).toBeGreaterThan(10);
    for (const c of cells) expect(c, c).toMatch(/^\[.+\]$/);
  });

  it("prompts for suspected categories and the data each one needs, and covers communication, motor, adaptive, vision and hearing", () => {
    const fie = fileTypeByKey("fie")!;
    const referral = fie.sections.find((s) => s.key === "reason_for_referral")!;
    expect(referral.elements).toContain("Suspected disability categories named");
    expect(referral.guidance).toMatch(/other health impairment/i);
    expect(referral.guidance).toMatch(/classroom observation|observation in the general education classroom/i);
    const all = fie.sections.map((s) => [s.heading, s.guidance, ...s.elements].join(" ")).join(" ");
    for (const area of [/speech-language/i, /\bmotor\b/i, /adaptive behavior/i, /\bvision\b/i, /\bhearing\b/i]) expect(all).toMatch(area);
    expect(fie.sections.map((s) => s.key)).toEqual(expect.arrayContaining(["communication_language", "adaptive_behavior"]));
    const eligibility = fie.sections.find((s) => s.key === "eligibility_determination")!;
    expect(eligibility.elements).toContain("Each category considered, listed by name");
    expect(eligibility.elements).toContain("Explicit statement that the determination rests with the team");
  });

  it("lays out composite, subtest and other scores in separate tables with the shared header", () => {
    const fie = fileTypeByKey("fie")!;
    expect(fie.preamble).toContain("| Measure | Score | Percentile | Range |");
    expect(fie.preamble).toMatch(/composite or index scores, subtest scores, and other reported scores/);
    expect(fie.preamble).toMatch(/short paragraphs and lists/);
    const cognitive = fie.sections.find((s) => s.key === "cognitive_functioning")!;
    expect(cognitive.guidance).toMatch(/Do not mix composites and subtests/);
    expect(cognitive.guidance).toMatch(/Other reported scores/);
  });

  it("keeps state terms out of the drafting text; the requirement sets carry them", () => {
    const fie = fileTypeByKey("fie")!;
    const drafting = [fie.preamble, ...fie.sections.flatMap((s) => [s.guidance, ...s.elements])].join(" ");
    expect(drafting).not.toMatch(/\bARD\b|19 TAC|Texas|LSSP/);
  });
});

describe("clinical drafts (IEP, reevaluation review, FBA and BIP)", () => {
  const clinical = ["iep", "reevaluation-review", "fba-bip"] as const;

  it.each(clinical)("%s is clinical, labelled a draft for the team including the parent, and opens with placeholder front matter", (key) => {
    const t = fileTypeByKey(key)!;
    expect(t.family).toBe("clinical");
    expect(t.preamble).toMatch(/DRAFT/);
    expect(t.preamble).toMatch(/includes the parent/);
    expect(t.preamble).toMatch(/Do not diagnose/);
    expect(t.sections[0].renderer).toBe("static");
    expect(t.sections[0].scaffold).toMatch(/DRAFT/);
    expect(t.sections[0].scaffold).toContain("[Student name]");
    for (const s of t.sections.filter((x) => x.required)) expect(s.elements.length, `${key}/${s.key}`).toBeGreaterThan(1);
  });

  it.each(clinical)("%s guidance never decides eligibility or diagnoses", (key) => {
    const t = fileTypeByKey(key)!;
    const texts = [t.preamble, ...t.sections.flatMap((s) => [s.guidance, ...s.elements]), ...t.rubric.flatMap((r) => [r.criterion, ...r.levels.map((l) => l.descriptor)])];
    // Instructions to state a decision (as opposed to telling the model not to).
    const decides = texts.filter((x) => /\b(state|determine|conclude|confirm)s? (that )?the student (is|is not|qualifies|continues to (have|qualify))\b/i.test(x) || /\bdiagnose (the student|a disorder)\b/i.test(x));
    expect(decides).toEqual([]);
    expect(t.preamble).toMatch(/\b(team decides|team develops and adopts|team adopts or changes)\b/);
    const eligibilityDecided = texts.filter((x) => /\b(is|are) eligible\b|\bqualifies for\b/i.test(x));
    expect(eligibilityDecided).toEqual([]);
  });

  it("each sets out the rule-specific content the doc names", () => {
    const iep = fileTypeByKey("iep")!;
    expect(iep.sections.map((s) => s.key)).toEqual(expect.arrayContaining(["present-levels", "annual-goals", "progress-reporting", "services", "transition"]));
    expect(iep.sections.find((s) => s.key === "services")!.guidance).toMatch(/start date and the anticipated frequency, location and duration/);
    const reed = fileTypeByKey("reevaluation-review")!;
    expect(reed.sections.find((s) => s.key === "review-by-question")!.elements).toHaveLength(5);
    expect(reed.sections.find((s) => s.key === "notice-and-consent")!.guidance).toMatch(/right to ask for an assessment/);
    const fba = fileTypeByKey("fba-bip")!;
    expect(fba.preamble).toMatch(/replacement behavior must serve the same function/);
    expect(fba.sections.find((s) => s.key === "target-behavior")!.guidance).toMatch(/baseline/);
  });
});

describe("technical types added in Phase 8", () => {
  it.each(["diataxis-reference", "diataxis-explanation", "incident-postmortem"])("%s is technical, cites its basis, and stays under the classifier budget", (key) => {
    const t = fileTypeByKey(key)!;
    expect(t.family).toBe("technical");
    expect(t.provenance.url).toMatch(/^https:\/\//);
    expect(t.summary.length + t.signals.join("; ").length).toBeLessThanOrEqual(850);
  });

  it("Diátaxis types are attributed CC BY-SA paraphrases; the postmortem is own text with no licensed postmortem guide", () => {
    for (const k of ["diataxis-reference", "diataxis-explanation"]) expect(fileTypeByKey(k)!.provenance.license).toMatch(/CC BY-SA 4\.0.*paraphrased, attributed/);
    const pm = fileTypeByKey("incident-postmortem")!;
    expect(pm.provenance.license).toMatch(/^Own text/);
    expect(JSON.stringify(pm)).not.toMatch(/where we got lucky|Site Reliability Engineering/i);
    expect(pm.preamble).toMatch(/blameless/);
  });
});

describe("classifier budget for the Phase 8 clinical and technical types", () => {
  it.each(["fie", "iep", "reevaluation-review", "fba-bip", "diataxis-reference", "diataxis-explanation", "incident-postmortem"])("%s: 10–18 signals of at most 60 characters, summary plus signals within 850", (key) => {
    const t = fileTypeByKey(key)!;
    expect(t.signals.length).toBeGreaterThanOrEqual(10);
    expect(t.signals.length).toBeLessThanOrEqual(18);
    for (const s of t.signals) expect(s.length, s).toBeLessThanOrEqual(60);
    expect(t.summary.length + t.signals.join("; ").length).toBeLessThanOrEqual(850);
    expect(t.rubric.length).toBeGreaterThanOrEqual(3);
    expect(t.rubric.length).toBeLessThanOrEqual(6);
  });
});
