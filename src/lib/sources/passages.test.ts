import { describe, expect, it } from "vitest";
import { checkCitations, redact, toPassages } from "./passages";

const doc = (text: string, i = 0) => ({ doc_id: `g-${i}`, doc_type: "Teacher Report", text });

describe("toPassages", () => {
  it("splits documents into ordered, citable passages", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} describes classroom reading behavior.`).join(" ");
    const ps = toPassages([doc(long), doc("Second document.", 1)]);
    expect(ps[0].passage_id).toBe("D0.P0");
    expect(ps.filter((p) => p.doc_id === "g-0").length).toBeGreaterThan(1);
    expect(ps.at(-1)).toMatchObject({ passage_id: "D1.P0", text: "Second document." });
    expect(ps.every((p) => p.text.length <= 700)).toBe(true);
  });
});

describe("checkCitations", () => {
  const ps = toPassages([doc("He can't sound out words. He guesses at words from pictures.")]);

  it("verifies a quote found in the cited passage, ignoring case and punctuation", () => {
    expect(checkCitations([{ passage_id: "D0.P0", quote: "he CAN’T sound out words" }], ps).verified).toBe(1);
  });

  it("rejects a passage that does not exist", () => {
    expect(checkCitations([{ passage_id: "D9.P9", quote: "anything" }], ps).unknownPassages).toEqual(["D9.P9"]);
  });

  it("rejects a quote the passage does not contain", () => {
    const r = checkCitations([{ passage_id: "D0.P0", quote: "failed hearing screening" }], ps);
    expect(r.verified).toBe(0);
    expect(r.unsupportedQuotes).toHaveLength(1);
  });
});

describe("redact", () => {
  it("removes the student's full name, name parts and possessives, and the school", () => {
    const out = redact("Jordan Smith attends Lincoln Elementary. Jordan's teacher says Smith reads slowly.", {
      student: "Jordan Smith",
      school: "Lincoln Elementary",
    });
    expect(out).toBe("[Student] attends [School]. [Student]'s teacher says [Student] reads slowly.");
  });

  it("leaves words that merely contain a name part", () => {
    expect(redact("Annabelle and Ann", { student: "Ann Lee" })).toBe("Annabelle and [Student]");
  });
});
