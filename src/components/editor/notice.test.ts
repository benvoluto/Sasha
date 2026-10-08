import { describe, expect, it } from "vitest";
import { dismissNotice, NO_NOTICES, pushNotice, type Notice } from "./notice";

const changedA: Notice = { text: "“A” changed while Claude was writing.", sticky: true, key: "changed:s_a", actions: [{ label: "Replace anyway", run: () => {} }] };

describe("notices", () => {
  it("keeps a pending decision when later notices arrive, until it is dismissed", () => {
    let s = pushNotice(NO_NOTICES, changedA, 1);
    // Section B's run finishes, then a deletion, then a notice is cleared.
    s = pushNotice(s, { text: "Drafted “B”." }, 2);
    s = pushNotice(s, { text: "Deleted “C”." }, 3);
    s = pushNotice(s, null, 4);
    expect(s.decisions.map((d) => d.id)).toEqual([1]);
    expect(s.decisions[0].actions?.[0].label).toBe("Replace anyway");
    expect(s.passing).toBeNull();
    s = dismissNotice(s, 1);
    expect(s).toEqual(NO_NOTICES);
  });

  it("lets passing notices replace each other", () => {
    const s = pushNotice(pushNotice(NO_NOTICES, { text: "one" }, 1), { text: "two" }, 2);
    expect(s.passing).toMatchObject({ id: 2, text: "two" });
    // Dismissing a notice that was already replaced changes nothing.
    expect(dismissNotice(s, 1)).toBe(s);
  });

  it("stacks decisions for different sections and replaces one for the same section", () => {
    let s = pushNotice(NO_NOTICES, changedA, 1);
    s = pushNotice(s, { ...changedA, key: "changed:s_b", text: "B" }, 2);
    s = pushNotice(s, { ...changedA, text: "A again" }, 3);
    expect(s.decisions.map((d) => [d.id, d.text])).toEqual([
      [2, "B"],
      [3, "A again"],
    ]);
  });
});
