import { describe, expect, it } from "vitest";
import { classifyPolarity, findPhraseMatches, normalizeForMatching } from "./text-match";

/** Convenience: normalize like a document, then match. */
function match(text: string, phrase: string) {
  return findPhraseMatches(normalizeForMatching(text), phrase);
}
const affirmed = (text: string, phrase: string) => match(text, phrase).filter((m) => m.polarity === "affirmed");

describe("normalizeForMatching", () => {
  it("folds typographic apostrophes to ASCII", () => {
    expect(normalizeForMatching("doesn’t")).toBe("doesn't");
  });

  it("collapses line breaks and runs of whitespace", () => {
    expect(normalizeForMatching("trouble making\nfriends")).toBe("trouble making friends");
    expect(normalizeForMatching("a  \t b")).toBe("a b");
  });

  it("folds dashes and non-breaking spaces", () => {
    expect(normalizeForMatching("well–known")).toBe("well-known");
    expect(normalizeForMatching("a b")).toBe("a b");
  });
});

describe("word-boundary anchoring (existing behaviour preserved)", () => {
  it("does not match a trigger embedded in a longer word", () => {
    expect(match("spelling errors", "ELL")).toHaveLength(0);
    expect(match("he slept", "LEP")).toHaveLength(0);
  });

  it("matches the trigger standing alone, case-insensitively", () => {
    expect(match("student is an ELL", "ell")).toHaveLength(1);
  });
});

describe("typography no longer defeats matching", () => {
  it("matches an apostrophe trigger against a curly apostrophe", () => {
    expect(match("he doesn’t make eye contact", "doesn't make eye contact")).toHaveLength(1);
  });

  it("matches a phrase reflowed across a line break", () => {
    expect(match("has trouble making\nfriends at recess", "trouble making friends")).toHaveLength(1);
  });

  it("matches when the trigger itself is authored with a curly apostrophe", () => {
    expect(match("he doesn't hear instructions", "doesn’t hear instructions")).toHaveLength(1);
  });
});

describe("negation scoping", () => {
  it("negates the regression case: a clearing screening report", () => {
    // This exact shape previously blocked the entire determination.
    const [m] = match("Vision and hearing screening: no hearing loss noted.", "hearing loss");
    expect(m.polarity).toBe("negated");
    expect(affirmed("Vision and hearing screening: no hearing loss noted.", "hearing loss")).toHaveLength(0);
  });

  it.each([
    ["parent denies frequent absences", "frequent absences"],
    ["student is not an English language learner", "English language learner"],
    ["no evidence of hearing loss", "hearing loss"],
    ["cultural factors were ruled out by the team", "cultural factors"],
    ["there were no vision problems", "vision problems"],
    ["hearing loss was ruled out", "hearing loss"],
    ["vision problems are not present", "vision problems"],
    ["screening was negative for hearing loss", "hearing loss"],
    ["no history of frequent absences", "frequent absences"],
  ])("negates %j", (text, phrase) => {
    expect(affirmed(text, phrase)).toHaveLength(0);
  });

  it.each([
    ["student has hearing loss", "hearing loss"],
    ["teacher reports frequent absences this term", "frequent absences"],
    ["documented vision problems requiring correction", "vision problems"],
  ])("affirms %j", (text, phrase) => {
    expect(affirmed(text, phrase)).toHaveLength(1);
  });

  it("treats double negation as affirmed (finding may be present)", () => {
    expect(affirmed("hearing loss cannot be ruled out", "hearing loss")).toHaveLength(1);
    expect(affirmed("hearing loss was not ruled out", "hearing loss")).toHaveLength(1);
  });

  it("does not let a negation leak across a clause boundary", () => {
    // "no hearing loss, but vision problems were noted" — only the first is negated.
    const text = "no hearing loss, but vision problems were noted";
    expect(affirmed(text, "hearing loss")).toHaveLength(0);
    expect(affirmed(text, "vision problems")).toHaveLength(1);
  });

  it("does not let a negation leak across a sentence boundary", () => {
    const text = "There was no hearing loss. Vision problems were documented.";
    expect(affirmed(text, "vision problems")).toHaveLength(1);
  });

  it("does not negate on a distant, unrelated cue", () => {
    const text =
      "The parent reported no interest in sports whatsoever, and the teacher separately documented vision problems";
    expect(affirmed(text, "vision problems")).toHaveLength(1);
  });

  it("still records negated mentions as evidence", () => {
    // Negated signals are preserved so a reviewer can see what the packet said.
    const all = match("no hearing loss noted", "hearing loss");
    expect(all).toHaveLength(1);
    expect(all[0].polarity).toBe("negated");
  });
});

describe("classifyPolarity", () => {
  it("is exported for direct use and agrees with findPhraseMatches", () => {
    const text = normalizeForMatching("denies frequent absences");
    const i = text.indexOf("frequent absences");
    expect(classifyPolarity(text, i, "frequent absences".length)).toBe("negated");
  });
});
