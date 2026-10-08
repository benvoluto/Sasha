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
});
