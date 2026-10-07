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
    g.edges.push({ id: "bad", source: "sources", sourceHandle: "nope", target: "output", targetHandle: "text" });
    expect(errors(g).some((m) => m.includes("port that no longer exists"))).toBe(true);
  });

  it("allows only one connection into a single input", () => {
    const g = defaultWorkflowGraph();
    g.edges.push({ id: "dup", source: "sources", sourceHandle: "names", target: "summarize", targetHandle: "sources" });
    expect(errors(g)).toContain("Summarize and list gaps “sources” accepts one connection");
  });

  it("accepts several connections into Save output", () => {
    const g = defaultWorkflowGraph();
    g.edges.push({ id: "more", source: "sources", sourceHandle: "combined", target: "output", targetHandle: "text" });
    expect(errors(g)).toEqual([]);
  });

  it("requires a Save output node, and only one", () => {
    const g = defaultWorkflowGraph();
    expect(errors({ ...g, nodes: g.nodes.filter((n) => n.type !== "output.save"), edges: g.edges.filter((e) => e.target !== "output") })).toContain(
      "Add a Save output node so the run's result is recorded",
    );
    expect(errors({ ...g, nodes: [...g.nodes, { ...g.nodes.at(-1)!, id: "output2" }] })).toContain("Only one Save output node is allowed");
  });

  it("detects cycles", () => {
    const g = defaultWorkflowGraph();
    expect(createsCycle(g, "summarize", "sources")).toBe(true);
    expect(createsCycle(g, "sources", "output")).toBe(false);
    g.nodes.push({ id: "ask", type: "ai.ask", position: { x: 0, y: 0 }, config: { provider: "gemini", model: "m", temperature: 0, prompt: "{{input}}", inputs: ["input"] }, loop: false, expanded: false });
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
