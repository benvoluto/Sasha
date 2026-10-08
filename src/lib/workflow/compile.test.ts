import { describe, expect, it } from "vitest";
import { WorkflowDefinition, type WorkflowDefinitionInput } from "@/catalog/workflow-schema";
import { compileWorkflow } from "./compile";
import { NODE_SPEC_INDEX } from "./registry";
import { validateGraph } from "./validate";

const def = (over: Partial<WorkflowDefinitionInput> = {}) =>
  WorkflowDefinition.parse({
    key: "type-test",
    version: 2,
    title: "Test",
    summary: "A test workflow.",
    kind: "type",
    appliesTo: ["proposal"],
    outcome: { label: "Readiness", values: [{ key: "ready", label: "Ready" }, { key: "not_ready", label: "Not ready" }] },
    checkpoint: { role: "Owner", required: true },
    requirementSets: ["nih-page-limits"],
    notAssessed: ["Budget"],
    notes: ["A note."],
    provenance: { source: "docs/workflows-by-document-type.md", checked: "2026-10-08" },
    steps: [
      { id: "doc", node: "doc.read" },
      { id: "src", node: "sources.read" },
      { id: "chk", node: "step.check", config: { perItem: false }, in: { document: "doc.document", sources: "src.sources" } },
      { id: "out", node: "outcome.report", config: { rules: [], fallback: "ready", topFindings: 3 }, in: { findings: ["chk.findings"], tables: "chk.table" } },
      { id: "cp", node: "checkpoint", config: { signsOutcome: true, editable: "outcome" }, in: { items: "out.outcome" } },
    ],
    ...over,
  });

describe("compileWorkflow", () => {
  it("places each step one row below the deepest step feeding it, spread left to right in order", () => {
    const g = compileWorkflow(def());
    const at = Object.fromEntries(g.nodes.map((n) => [n.id, n.position]));
    expect(at).toEqual({ doc: { x: 0, y: 0 }, src: { x: 300, y: 0 }, chk: { x: 0, y: 200 }, out: { x: 0, y: 400 }, cp: { x: 0, y: 600 } });
  });

  it("lays step config over the node defaults and injects the outcome and checkpoint settings", () => {
    const g = compileWorkflow(def());
    const out = g.nodes.find((n) => n.id === "out")!;
    expect(out.config).toMatchObject({ label: "Readiness", values: [{ key: "ready" }, { key: "not_ready" }], requirementSets: ["nih-page-limits"], notAssessed: ["Budget"], notes: ["A note."], topFindings: 3, fallback: "ready", rules: [] });
    const cp = g.nodes.find((n) => n.id === "cp")!;
    expect(cp.config).toMatchObject({ role: "Owner", signsOutcome: true, editable: "outcome", allowExclude: false });
    const chk = g.nodes.find((n) => n.id === "chk")!;
    expect(chk.config).toEqual({ ...(NODE_SPEC_INDEX["step.check"].defaults() as object), perItem: false });
    expect(g.nodes.every((n) => n.expanded === false)).toBe(true);
  });

  it("lets a step's own config win over injected values", () => {
    const d = def();
    d.steps[3].config = { ...d.steps[3].config, label: "Custom" };
    expect(compileWorkflow(d).nodes.find((n) => n.id === "out")!.config.label).toBe("Custom");
  });

  it("builds one edge per wiring, ids from both ends, lists expanded in order", () => {
    const g = compileWorkflow(def());
    expect(g.edges.map((e) => e.id)).toEqual(["doc.document->chk.document", "src.sources->chk.sources", "chk.findings->out.findings", "chk.table->out.tables", "out.outcome->cp.items"]);
    expect(g.edges[0]).toEqual({ id: "doc.document->chk.document", source: "doc", sourceHandle: "document", target: "chk", targetHandle: "document" });
    expect(g.format).toBe("graph-v1");
    expect(validateGraph(g).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("keeps labels and loop flags", () => {
    const d = def({ kind: "generic", appliesTo: [], checkpoint: null, steps: [
      { id: "doc", node: "doc.read", label: "Document" },
      { id: "draft", node: "draft.section", loop: true, in: { section: "doc.empty_sections", document: "doc.document" } },
      { id: "out", node: "outcome.report", config: { rules: [], fallback: "ready" }, in: { findings: "draft.findings" } },
    ] });
    const g = compileWorkflow(d);
    expect(g.nodes[0].label).toBe("Document");
    expect(g.nodes[1]).toMatchObject({ loop: true, position: { x: 0, y: 200 } });
    expect(validateGraph(g).filter((i) => i.severity === "error")).toEqual([]);
  });
});
