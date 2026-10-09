import { describe, expect, it } from "vitest";
import { markdownToPlain } from "./plain-text";

describe("markdownToPlain", () => {
  it("removes heading, quote and list markers, keeping the words", () => {
    expect(markdownToPlain("# Title\n\n## Sub ##\n> quoted\n- one\n* two\n3. three\n- [x] done")).toBe("Title\n\nSub\nquoted\none\ntwo\nthree\ndone");
  });

  it("turns links into their text and drops images", () => {
    expect(markdownToPlain("See [the report](https://example.com/r) and <https://example.org>. ![Chart](c.png)")).toBe("See the report and https://example.org.");
    expect(markdownToPlain("A [ref][1] here.")).toBe("A ref here.");
  });

  it("removes emphasis, code spans, strike-through and escapes, but not underscores inside words", () => {
    expect(markdownToPlain("**Bold**, __also__, *it*, _em_, ~~gone~~, `code`, snake_case_name, 5 \\* 3")).toBe("Bold, also, it, em, gone, code, snake_case_name, 5 * 3");
  });

  it("joins table cells and drops the rule row", () => {
    expect(markdownToPlain("| Region | Sales |\n|:---|---:|\n| North | 1 |")).toBe("Region · Sales\nNorth · 1");
  });

  it("drops code fences (keeping their content), rules and HTML tags", () => {
    expect(markdownToPlain("```js\nconst a = 1;\n```\n---\n<b>Bold</b> line<br>next")).toBe("const a = 1;\nBold line next");
  });

  it("drops setext underlines and collapses blank lines", () => {
    expect(markdownToPlain("Heading\n=======\n\n\n\nBody")).toBe("Heading\n\nBody");
  });

  it("leaves plain text alone", () => {
    expect(markdownToPlain("Demand rose 12% in 2025 (a record).")).toBe("Demand rose 12% in 2025 (a record).");
  });

  it("cleans block syntax in a passage whose line breaks were collapsed", () => {
    const passage = "## Results **Table 2.** Mean scores rose from *41* to __58__ (see [the appendix](https://example.org/a)). | Group | Score | |---|---| | A | 58 | - First point with `code`";
    expect(markdownToPlain(passage)).toBe("Results Table 2. Mean scores rose from 41 to 58 (see the appendix). · Group · Score · A · 58 · First point with code");
    // A dash between words and a lone pipe are prose.
    expect(markdownToPlain("A - B is fine. Use a|b pipes.")).toBe("A - B is fine. Use a|b pipes.");
  });
});
