import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { Node as PMNodeClass } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { collectCitations } from "@/lib/citations/contract";
import type { PMNode as PMJSON } from "@/lib/documents/sections";
import {
  addedKeys,
  citationRuns,
  hintText,
  numberRuns,
  missingKeys,
  quoteParts,
  referenceTitle,
  refWidgets,
  runFor,
  runMark,
  runsAt,
  statusText,
  textWithMarkers,
} from "./citation-layer-model";
import { documentExtensions } from "./extensions";

const schema = getSchema(documentExtensions());
const cite = (passageId: string, extra: Record<string, unknown> = {}) => ({ type: "citation", attrs: { kind: "passage", passageId, sourceId: "src", dataTableId: null, quote: null, verified: true, ...extra } });
const table = { type: "citation", attrs: { kind: "table", passageId: null, sourceId: "src", dataTableId: "t1", quote: null, verified: true } };
const t = (text: string, marks: PMJSON["marks"] = []): PMJSON => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
const para = (...content: PMJSON[]): PMJSON => ({ type: "paragraph", content });
const node = (...content: PMJSON[]) => PMNodeClass.fromJSON(schema, { type: "doc", content });

const A = "S1a2b3c4d.P1";
const B = "S1a2b3c4d.P2";

// "One. " (1..6) "Two" bold+A (6..9) "." A (9..10) " Three." B (10..17)
const sample = () =>
  node(
    para(t("One. "), t("Two", [{ type: "bold" }, cite(A)]), t(".", [cite(A)]), t(" Three.", [cite(B)])),
    para(t("Again.", [cite(B), cite(A)]), t(" Costs", [table])),
  );

describe("citationRuns", () => {
  it("joins adjacent text nodes with the same citation into one run per textblock", () => {
    const runs = citationRuns(sample());
    expect(runs.map((r) => [r.key, r.from, r.to])).toEqual([
      [`p:${A}`, 6, 10],
      [`p:${B}`, 10, 17],
      // Runs that start together keep the marks' order (collectCitations reads them the same way).
      [`p:${B}`, 19, 25],
      [`p:${A}`, 19, 25],
      ["t:t1", 25, 31],
    ]);
  });

  it("numbers by first appearance, as collectCitations does", () => {
    const doc = sample();
    const numbers = numberRuns(citationRuns(doc));
    const { numberOf } = collectCitations(doc.toJSON() as PMJSON);
    expect([...numbers.entries()]).toEqual([...numberOf.entries()]);
    expect([...numbers.entries()]).toEqual([
      [`p:${A}`, 1],
      [`p:${B}`, 2],
      ["t:t1", 3],
    ]);
  });

  it("places one number per run end, keys in number order", () => {
    const runs = citationRuns(sample());
    expect(refWidgets(runs, numberRuns(runs))).toEqual([
      { pos: 10, keys: [`p:${A}`] },
      { pos: 17, keys: [`p:${B}`] },
      { pos: 25, keys: [`p:${A}`, `p:${B}`] },
      { pos: 31, keys: ["t:t1"] },
    ]);
  });

  it("finds the runs at the caret, and a run by key and position", () => {
    const runs = citationRuns(sample());
    expect(runsAt(runs, 6)).toEqual([]);
    expect(runsAt(runs, 8).map((r) => r.key)).toEqual([`p:${A}`]);
    expect(runsAt(runs, 10).map((r) => r.key)).toEqual([`p:${A}`]);
    expect(runsAt(runs, 22).map((r) => r.key)).toEqual([`p:${B}`, `p:${A}`]);
    expect(runFor(runs, `p:${A}`, 25)?.from).toBe(19);
    expect(runFor(runs, `p:${A}`, 7)?.from).toBe(6);
    expect(runFor(runs, "p:none", 7)).toBeNull();
  });

  it("finds the exact mark to remove from a run", () => {
    const doc = sample();
    const run = citationRuns(doc).find((r) => r.key === `p:${B}` && r.from === 19)!;
    const mark = runMark(doc, run)!;
    expect(mark.attrs.passageId).toBe(B);
    // Removing exactly that mark (one transaction, so one undo step) leaves the other citation on the same text.
    const state = EditorState.create({ schema, doc });
    const next = state.apply(state.tr.removeMark(run.from, run.to, mark));
    expect(citationRuns(next.doc).filter((r) => r.from === 19).map((r) => r.key)).toEqual([`p:${A}`]);
  });

  it("reports keys that were added", () => {
    expect(addedKeys(new Set(["a"]), new Set(["a", "b"]))).toEqual(["b"]);
    expect(addedKeys(new Set(["a", "b"]), new Set(["a"]))).toEqual([]);
  });
});

describe("textWithMarkers", () => {
  it("reads like textBetween with a bare marker after each passage citation run", () => {
    const doc = sample();
    const all = textWithMarkers(doc, 0, doc.content.size);
    expect(all).toBe(`One. Two.[[p:${A}]] Three.[[p:${B}]]\n\nAgain.[[p:${B}]][[p:${A}]] Costs`);
    // Without citations it is exactly textBetween.
    const plain = node(para(t("First.")), para(t("Second "), t("bold", [{ type: "bold" }])));
    expect(textWithMarkers(plain, 0, plain.content.size)).toBe(plain.textBetween(0, plain.content.size, "\n\n"));
  });

  it("closes a run cut by the range end", () => {
    const doc = sample();
    expect(textWithMarkers(doc, 6, 9)).toBe(`Two[[p:${A}]]`);
  });
});

describe("words on screen", () => {
  it("explains each lint status", () => {
    const passage = { kind: "passage" as const, verified: true };
    expect(statusText({ status: "unlinked", kind: "passage" }, passage)).toBe("This source was unlinked from the document.");
    expect(statusText({ status: "deleted", kind: "passage" }, passage)).toBe("This source was deleted.");
    expect(statusText({ status: "deleted", kind: "table" }, { kind: "table", verified: true })).toBe("This table was deleted.");
    expect(statusText({ status: "missing", kind: "passage" }, passage)).toBe("This source was re-read; the passage no longer exists.");
    expect(statusText({ status: "ok", kind: "passage" }, passage)).toMatch(/Checked against the source/);
    expect(statusText({ status: "ok", kind: "passage" }, { kind: "passage", verified: false })).toBe("Not checked against the source.");
    expect(statusText(null, passage)).toBe("Checking the source…");
    // A quote the server dropped (not in the passage) is flagged, whatever the mark's `verified` says.
    expect(statusText({ status: "ok", kind: "passage", quote: null }, { ...passage, quote: "The board admitted it" })).toBe("The quoted words are not in this passage.");
    expect(statusText({ status: "ok", kind: "passage", quote: "Demand rose" }, { ...passage, quote: "Demand rose" })).toMatch(/Checked against the source/);
  });

  it("titles references and hints the shortcut per platform", () => {
    expect(referenceTitle({ kind: "table", sourceTitle: "Budget.xlsx", tableName: "Costs" }, { kind: "table" })).toBe("Table “Costs”, Budget.xlsx");
    expect(referenceTitle(null, { kind: "passage" })).toBe("Source");
    expect(hintText(2, "keyboard")).toBe("Source 2, Alt+Enter to open details");
    expect(hintText(2, "mac")).toBe("Source 2, Option+Enter to open details");
    expect(hintText(2, "touch")).toBe("Source 2, tap [2] for details");
  });

  it("highlights the quote in the excerpt tolerantly, or not at all", () => {
    expect(quoteParts("Demand rose 12 percent, year-over-year.", "rose 12 PERCENT year over")).toEqual(["Demand ", "rose 12 percent, year-over", "-year."]);
    expect(quoteParts("Demand rose.", "fell")).toEqual(["Demand rose."]);
    expect(quoteParts("Demand rose.", null)).toEqual(["Demand rose."]);
    expect(quoteParts("Demand rose.", "rose…")).toEqual(["Demand ", "rose", "."]);
    // Whole words only, as the server checks: no highlight that splits a number or a word.
    expect(quoteParts("Demand rose 12% in 2024.", "Demand rose 1%")).toEqual(["Demand rose 12% in 2024."]);
    expect(quoteParts("Sales fell.", "ales fell")).toEqual(["Sales fell."]);
    expect(quoteParts("Demand rose 12% in 2024.", "rose 12% in 20…")).toEqual(["Demand ", "rose 12% in 20", "24."]);
  });
});

describe("missingKeys", () => {
  it("lists each citation in the editor the last lint had no reference for, once", () => {
    const runs = [{ key: "p:A" }, { key: "p:B" }, { key: "p:A" }, { key: "t:T" }];
    expect(missingKeys(runs, new Map([["p:A", {}]]))).toEqual(["p:B", "t:T"]);
    expect(missingKeys(runs, new Map([["p:A", {}], ["p:B", {}], ["t:T", {}]]))).toEqual([]);
  });
});
