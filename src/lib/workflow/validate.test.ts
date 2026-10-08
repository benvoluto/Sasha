import { describe, expect, it } from "vitest";
import { defaultWorkflowGraph } from "./default-graph";
import { createsCycle, topologicalOrder, validateGraph } from "./validate";
import { renderTemplate, templateVariables } from "./template";
import type { WorkflowGraph } from "./types";

const errors = (g: WorkflowGraph) => validateGraph(g).filter((i) => i.severity === "error").map((i) => i.message);

describe("validateGraph", () => {
  it("accepts the default workflow", () => {
    expect(errors(defaultWorkflowGraph())).toEqual([]);
  });

  it("requires inputs to be connected", () => {
    const g = defaultWorkflowGraph();
    g.edges = g.edges.filter((e) => e.target !== "summarize");
    expect(errors(g)).toContain("Summarize and list gaps: connect “sources”");
  });

  it("rejects wiring a port that does not exist", () => {
    const g = defaultWorkflowGraph();
    g.edges.push({ id: "bad", source: "sources", sourceHandle: "nope", target: "outcome", targetHandle: "summary" });
    expect(errors(g).some((m) => m.includes("port that no longer exists"))).toBe(true);
  });

  it("allows only one connection into a single input", () => {
    const g = defaultWorkflowGraph();
    g.edges.push({ id: "dup", source: "sources", sourceHandle: "passages", target: "summarize", targetHandle: "sources" });
    expect(errors(g)).toContain("Summarize and list gaps “sources” accepts one connection");
  });

  it("accepts several connections into the outcome's summary", () => {
    const g = defaultWorkflowGraph();
    g.edges.push({ id: "more", source: "sources", sourceHandle: "text", target: "outcome", targetHandle: "summary" });
    expect(errors(g)).toEqual([]);
  });

  it("requires an Outcome node, and only one", () => {
    const g = defaultWorkflowGraph();
    expect(errors({ ...g, nodes: g.nodes.filter((n) => n.type !== "outcome.report"), edges: g.edges.filter((e) => e.target !== "outcome") })).toContain(
      "Add an Outcome node so the run's outcome is recorded",
    );
    expect(errors({ ...g, nodes: [...g.nodes, { ...g.nodes.at(-1)!, id: "outcome2" }] })).toContain("Only one Outcome node is allowed");
  });

  it("gives every node an optional after input that orders and gates it", () => {
    const g = defaultWorkflowGraph();
    g.edges.push({ id: "after", source: "sources", sourceHandle: "passages", target: "summarize", targetHandle: "after" });
    g.edges.push({ id: "after2", source: "sources", sourceHandle: "text", target: "summarize", targetHandle: "after" });
    expect(errors(g)).toEqual([]);
  });

  it("detects cycles", () => {
    const g = defaultWorkflowGraph();
    expect(createsCycle(g, "summarize", "sources")).toBe(true);
    expect(createsCycle(g, "sources", "outcome")).toBe(false);
    g.nodes.push({ id: "ask", type: "ai.ask", position: { x: 0, y: 0 }, config: { provider: "anthropic", model: "m", temperature: 0, prompt: "{{input}}", inputs: ["input"] }, loop: false, expanded: false });
    g.nodes.push({ id: "c", type: "text.combine", position: { x: 0, y: 0 }, config: { template: "{{a}}", inputs: ["a"] }, loop: false, expanded: false });
    g.edges.push({ id: "x1", source: "summarize", sourceHandle: "response", target: "c", targetHandle: "a" });
    g.edges.push({ id: "x2", source: "c", sourceHandle: "text", target: "ask", targetHandle: "input" });
    g.edges.push({ id: "x3", source: "ask", sourceHandle: "response", target: "c", targetHandle: "a" });
    expect(topologicalOrder(g)).toBeNull();
    expect(errors(g)).toContain("The workflow has a loop of connections; steps must flow one way");
  });

  it("warns about template variables that are not inputs", () => {
    const g = defaultWorkflowGraph();
    g.nodes.push({ id: "c", type: "text.combine", position: { x: 0, y: 0 }, config: { template: "{{a}} and {{b}}", inputs: ["a"] }, loop: false, expanded: false });
    g.edges.push({ id: "e", source: "summarize", sourceHandle: "response", target: "c", targetHandle: "a" });
    expect(validateGraph(g).some((i) => i.severity === "warning" && i.message.includes("{{b}}"))).toBe(true);
  });
});

describe("templates", () => {
  it("lists and fills variables, leaving unknown ones", () => {
    expect(templateVariables("Hi {{ name }}, {{x}} {{name}}")).toEqual(["name", "x"]);
    expect(renderTemplate("A {{a}} B {{b}} C {{zz}}", { a: "one", b: ["x", "y"] })).toBe("A one B - x\n- y C {{zz}}");
  });
});
