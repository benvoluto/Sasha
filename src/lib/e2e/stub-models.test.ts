import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/ontology/governance", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ontology/governance")>()), defaultAuditSink: () => ({ write: async () => {} }) }));

import { resetCatalogStore } from "@/catalog/store";
import { ClassifyModelOutput } from "@/lib/classifier/classify";
import { allErrors } from "@/lib/learn/validate";
import { extractFromExamples } from "@/lib/learn/extract";
import { ExtractModelOutput, RepairModelOutput } from "@/lib/learn/prompts";
import { claudeConfigured, claudeJson, claudeText } from "@/lib/llm/claude";
import { TASKS, type Task } from "@/lib/llm/tasks";
import { RubricModelOutput } from "@/lib/rubric/check";
import { applyModel } from "@/lib/sections/outline-status";
import { summarizeSource } from "@/lib/sources/summarize";
import { SuggestModelOutput } from "@/lib/suggestions/prompt";
import { minimalValue, stubCallModel, stubClaudeMessage, stubGeminiExtraction, stubGeminiTables, TASK_FIXTURES } from "./stub-models";

type Schema = Parameters<typeof minimalValue>[0];

const ENV = ["SASHA_E2E_STUB_MODELS", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "POSTGRES_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.SASHA_E2E_STUB_MODELS = "1";
  // A stray real key must not matter: the stub answers before any request.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.POSTGRES_URL;
  resetCatalogStore();
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("minimalValue", () => {
  it("fills required properties only, with minItems items and the first enum value", () => {
    const schema: Schema = {
      type: "object",
      required: ["name", "tags", "kind", "n", "ok"],
      properties: {
        name: { type: "string", minLength: 6 },
        tags: { type: "array", minItems: 2, items: { type: "string" } },
        kind: { enum: ["a", "b"] },
        n: { type: "integer", minimum: 3 },
        ok: { type: "boolean" },
        extra: { type: "string" },
      },
    };
    expect(minimalValue(schema)).toEqual({ name: "stubxx", tags: ["stub", "stub"], kind: "a", n: 3, ok: false });
  });

  it("follows $ref, const, anyOf (preferring the non-null branch), allOf and nullable types", () => {
    const schema: Schema = {
      type: "object",
      required: ["a", "b", "c", "d", "e", "f"],
      properties: {
        a: { $ref: "#/$defs/Item" },
        b: { const: "fixed" },
        c: { anyOf: [{ type: "null" }, { type: "number", exclusiveMinimum: 0 }] },
        d: { allOf: [{ type: "object", required: ["x"], properties: { x: { type: "string" } } }, { type: "object", required: ["y"], properties: { y: { type: "boolean" } } }] },
        e: { type: ["null", "string"] },
        f: { type: "string", format: "uri" },
      },
      $defs: { Item: { type: "object", required: ["id"], properties: { id: { type: "string" } } } },
    };
    expect(minimalValue(schema)).toEqual({ a: { id: "stub" }, b: "fixed", c: 1, d: { x: "stub", y: false }, e: "stub", f: "https://example.com/" });
  });

  it("gives null for no schema and stops on a self-referencing one", () => {
    expect(minimalValue(undefined)).toBeNull();
    const loop = { $ref: "#/$defs/L", $defs: { L: { $ref: "#/$defs/L" } } };
    expect(minimalValue(loop)).toBeNull();
  });

  it("satisfies zod schemas converted the way structured output sends them", () => {
    for (const schema of [ClassifyModelOutput, SuggestModelOutput, RubricModelOutput, ExtractModelOutput, RepairModelOutput]) {
      const value = minimalValue(z.toJSONSchema(schema) as Schema);
      expect(schema.safeParse(value).success).toBe(true);
    }
  });
});

describe("task fixtures", () => {
  it("only name real tasks", () => {
    for (const task of Object.keys(TASK_FIXTURES)) expect(TASKS).toHaveProperty(task);
  });

  it("parse with each task's real schema through claudeJson (the structured-output path)", async () => {
    expect(claudeConfigured()).toBe(true);
    const cases: Array<[Task, z.ZodType]> = [
      ["classify.type", ClassifyModelOutput],
      ["suggest.items", SuggestModelOutput],
      ["rubric.check", RubricModelOutput],
      ["learn.extract", ExtractModelOutput],
      ["learn.extract", RepairModelOutput],
    ];
    for (const [task, schema] of cases) {
      const { data, usage } = await claudeJson({ task, system: "s", user: "u", schema });
      expect(schema.safeParse(data).success).toBe(true);
      expect(usage.input_tokens).toBeGreaterThan(0);
    }
    const { data } = await claudeJson({ task: "suggest.items", system: "s", user: "u", schema: SuggestModelOutput });
    expect(data.proposals).toHaveLength(1);
  });

  it("gives every JSON task a reply its schema's minimal value would also give, when it has no fixture", async () => {
    const schema = z.object({ items: z.array(z.object({ id: z.string() })).min(1), done: z.boolean() });
    const { data } = await claudeJson({ task: "coverage.score", system: "s", user: "u", schema });
    expect(data).toEqual({ items: [{ id: "stub" }], done: false });
  });

  it("summarizes a source without renaming it", async () => {
    expect(await summarizeSource({ title: "small.csv", text: "a,b\n1,2" })).toEqual({ summary: "A short summary written by the end-to-end test stub." });
  });

  it("gives outline.status a reply applyModel accepts", () => {
    const rows = [{ specKey: "summary", heading: "Summary", present: true, sectionId: "s1", elements: [] }] as unknown as Parameters<typeof applyModel>[0];
    expect(() => applyModel(rows, TASK_FIXTURES["outline.status"] as Parameters<typeof applyModel>[1])).not.toThrow();
  });

  it("learns a draft that validates, so the learn review renders", async () => {
    const text = "# Equipment request\n\n## Summary\nWe need a new kiln for the art room.\n\n## Costs\nKiln 900, total 900.";
    const example = { index: 0, ref: { kind: "document" as const, documentId: "d1" }, title: "Kiln request", words: 18, headings: [{ level: 1, text: "Equipment request" }], text, truncated: false };
    const { draft, repaired } = await extractFromExamples("org:e2e", [example], {}, { agent: "e2e", today: "2026-10-08" });
    expect(repaired).toBe(false);
    expect(allErrors(draft.validation)).toEqual([]);
    expect(draft.type).toMatchObject({ title: "Equipment request" });
    expect((draft.workflow as { steps: unknown[] }).steps.length).toBeGreaterThan(3);
  });

  it("gives text tasks prose, with a fixture for draft.section", async () => {
    const drafted = await claudeText({ task: "draft.section", system: "s", user: "u" });
    expect(drafted.text).toBe(TASK_FIXTURES["draft.section"]);
    const rewritten = await claudeText({ task: "rewrite.section", system: "s", user: "u" });
    expect(rewritten.text).toMatch(/end-to-end test stub/);
  });
});

describe("other stubs", () => {
  it("reports token counts from the text and a search request when asked", () => {
    const m = stubClaudeMessage({ task: "web.find", model: "claude-sonnet-5-5", system: "abcd", user: "efgh", webSearch: true });
    expect(m.usage.input_tokens).toBe(2);
    expect(m.usage.server_tool_use).toEqual({ web_search_requests: 0 });
    expect(m.model).toBe("claude-sonnet-5-5");
  });

  it("answers workflow core nodes with JSON or prose", () => {
    expect(stubCallModel({ model: "m", system: "s", user: "u" }).text).toBe("{}");
    expect(stubCallModel({ model: "m", system: "s", user: "u", json: false }).text).toMatch(/stub/);
  });

  it("marks Gemini's extraction per document and page, and gives one small table", () => {
    const x = stubGeminiExtraction([{ name: "a.pdf" }, { name: "b.pdf" }]);
    expect(x.fileCount).toBe(2);
    expect(x.extractedContent).toContain("=== Document: a.pdf ===\n--- Page 1 ---");
    expect(x.extractedContent).toContain("=== Document: b.pdf ===");
    const t = stubGeminiTables({ name: "a.png", mime: "image/png" });
    expect(t.grids[0].method).toBe("gemini-image");
    expect(t.grids[0].cells).toHaveLength(3);
  });
});
