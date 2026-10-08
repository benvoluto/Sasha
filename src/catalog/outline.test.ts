import { describe, expect, it } from "vitest";
import { listSections, type PMNode } from "@/lib/documents/sections";
import { fileTypes } from "./files";
import { isScaffoldOnly, outlineDoc, randomSectionId, sectionNodes } from "./outline";

const counter = () => {
  let n = 0;
  return () => `s_${String(++n).padStart(8, "0")}`;
};

describe("outlineDoc", () => {
  it("makes one heading per section in order, carrying specKey and a unique sectionId", () => {
    const doc = outlineDoc([
      { key: "b", heading: "Second", order: 20 },
      { key: "a", heading: "First", order: 10, level: 3 },
    ]);
    const sections = listSections(doc);
    expect(sections.map((s) => [s.specKey, s.heading, s.level])).toEqual([
      ["a", "First", 3],
      ["b", "Second", 2],
    ]);
    expect(new Set(sections.map((s) => s.sectionId)).size).toBe(2);
    for (const s of sections) expect(s.sectionId).toMatch(/^s_[a-z0-9]{8}$/);
  });

  it("uses the given id factory and an empty paragraph after each heading", () => {
    const doc = outlineDoc([{ key: "a", heading: "A", order: 1 }], counter());
    expect(doc.content).toEqual([
      { type: "heading", attrs: { level: 2, sectionId: "s_00000001", specKey: "a" }, content: [{ type: "text", text: "A" }] },
      { type: "paragraph" },
    ]);
  });

  it("an empty outline is an empty document", () => {
    expect(outlineDoc([])).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
});

describe("sectionNodes", () => {
  it("inserts the scaffold with its headings demoted below the section", () => {
    const nodes = sectionNodes({ key: "header", heading: "Header", order: 1, level: 2, scaffold: "**To:** someone\n\n## Inner" }, counter());
    expect(nodes[0]).toMatchObject({ type: "heading", attrs: { level: 2, specKey: "header" } });
    expect(nodes[1].type).toBe("paragraph");
    expect(JSON.stringify(nodes[1])).toContain("To:");
    const inner = nodes.find((n, i) => i > 0 && n.type === "heading");
    expect(inner?.attrs?.level).toBe(3);
  });

  it("keeps a line-per-field scaffold on separate lines", () => {
    const scaffold = "**To:** [Name, title]\n**From:** [Name, title, office]\n**Date:** [Date]";
    const [, body] = sectionNodes({ key: "header", heading: "Header", order: 1, scaffold }, counter());
    expect(body.content).toEqual([
      { type: "text", text: "To:", marks: [{ type: "bold" }] },
      { type: "text", text: " [Name, title]" },
      { type: "hardBreak" },
      { type: "text", text: "From:", marks: [{ type: "bold" }] },
      { type: "text", text: " [Name, title, office]" },
      { type: "hardBreak" },
      { type: "text", text: "Date:", marks: [{ type: "bold" }] },
      { type: "text", text: " [Date]" },
    ]);
  });

  it("puts every **Label:** line of every bundled scaffold on its own line, and keeps scaffold tables", () => {
    let checked = 0;
    for (const def of fileTypes()) {
      for (const spec of def.sections) {
        if (!spec.scaffold?.trim()) continue;
        const nodes = sectionNodes(spec, counter()).slice(1);
        // Each child run starting a line (block start or after a hardBreak) is where a label may begin.
        const lineStarts: string[] = [];
        const walk = (n: PMNode) => {
          if (n.type === "paragraph" || n.type === "heading") {
            let start = true;
            for (const c of n.content ?? []) {
              if (c.type === "hardBreak") start = true;
              else if (start) {
                lineStarts.push(c.text ?? "");
                start = false;
              }
            }
          }
          (n.content ?? []).forEach(walk);
        };
        nodes.forEach(walk);
        const labels = spec.scaffold.split("\n").filter((l) => /^\*\*[^*]+:\*\*/.test(l.trim()));
        for (const l of labels) {
          const label = /^\*\*([^*]+:)\*\*/.exec(l.trim())![1];
          expect(lineStarts, `${def.key}/${spec.key}: ${label}`).toContain(label);
          checked++;
        }
        if (spec.scaffold.includes("| --- |")) expect(nodes.some((n) => n.type === "table"), `${def.key}/${spec.key}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe("randomSectionId", () => {
  it("has the editor's shape and varies", () => {
    const ids = new Set(Array.from({ length: 50 }, randomSectionId));
    for (const id of ids) expect(id).toMatch(/^s_[a-z0-9]{8}$/);
    expect(ids.size).toBe(50);
  });
});

describe("isScaffoldOnly", () => {
  const scaffold = "**To:** \n**From:** \n\n### Detail\n\n| A | B |\n| --- | --- |\n|  |  |";
  it("matches an untouched scaffold however it is spaced, and not once a field is filled", () => {
    expect(isScaffoldOnly("To:\nFrom:\nAB", scaffold)).toBe(true);
    expect(isScaffoldOnly("To:  From: A\tB", scaffold)).toBe(true);
    expect(isScaffoldOnly("To: Ann\nFrom:\nAB", scaffold)).toBe(false);
    expect(isScaffoldOnly("", undefined)).toBe(false);
    expect(isScaffoldOnly("", "")).toBe(false);
  });
});
