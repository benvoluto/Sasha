import { beforeEach, describe, expect, it } from "vitest";
import { RequirementSet } from "@/catalog/requirements-schema";
import { resetMemoryStore } from "@/lib/documents/store";
import { LEARN_INFERRED_LABEL, LEARN_TEAM_HOURLY_LIMIT } from "./contract";
import { deleteTeamRequirementSets, inferredRef, insertTeamRequirementSets, listTeamRequirementSets, reserveLearnCall, resetLearnStore, resolveSet, setRef } from "./store";

const set = (key = "team-approvals") =>
  RequirementSet.parse({
    key,
    version: 1,
    title: "Approvals",
    authority: "Inferred from the team's examples",
    jurisdiction: "Team",
    appliesTo: ["equipment-request"],
    effective: "",
    checked: "2026-10-08",
    inferred: true,
    provenance: { source: "Learned from 2 examples", url: "", license: "Team" },
    items: [{ key: "head_signs", kind: "checklist", title: "Head signs", text: "The department head signs." }],
  });

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  resetLearnStore();
});

describe("team requirement sets", () => {
  it("stores inferred sets per team, refuses a key the team has, and deletes", async () => {
    expect(await insertTeamRequirementSets("org:a", "ann", [set()])).toBe(true);
    expect(await insertTeamRequirementSets("org:a", "ann", [set("team-other"), set()])).toBe(false);
    expect((await listTeamRequirementSets("org:a")).map((s) => s.key)).toEqual(["team-approvals"]);
    expect(await listTeamRequirementSets("org:b")).toEqual([]);
    expect(await insertTeamRequirementSets("org:b", "bob", [set()])).toBe(true);
    await deleteTeamRequirementSets("org:a", ["team-approvals"]);
    expect(await listTeamRequirementSets("org:a")).toEqual([]);
    expect((await listTeamRequirementSets("org:b")).length).toBe(1);
  });

  it("only takes inferred sets with the team prefix", async () => {
    await expect(insertTeamRequirementSets("org:a", "ann", [set("approvals")])).rejects.toThrow(/Invalid inferred/);
    await expect(insertTeamRequirementSets("org:a", "ann", [{ ...set(), inferred: false }])).rejects.toThrow(/Invalid inferred/);
  });

  it("returns copies, and is cleared with the memory store", async () => {
    await insertTeamRequirementSets("org:a", "ann", [set()]);
    const [s] = await listTeamRequirementSets("org:a");
    s.title = "changed";
    expect((await listTeamRequirementSets("org:a"))[0].title).toBe("Approvals");
    resetMemoryStore();
    expect(await listTeamRequirementSets("org:a")).toEqual([]);
  });

  it("resolves catalog sets first and labels inferred ones, never with a URL", () => {
    const team = [set(), set("nih-page-limits")];
    expect(resolveSet("nih-page-limits", team)?.inferred).toBe(false);
    expect(resolveSet("team-approvals", team)?.key).toBe("team-approvals");
    expect(resolveSet("nope", team)).toBeNull();
    const ref = inferredRef(set());
    expect(ref).toMatchObject({ key: "team-approvals", url: "", effective: "" });
    expect(ref.verifyNote.startsWith(LEARN_INFERRED_LABEL)).toBe(true);
    expect(setRef(resolveSet("nih-page-limits", team)!).verifyNote).toMatch(/^Verify before relying/);
  });
});

describe("reserveLearnCall", () => {
  it(`allows ${LEARN_TEAM_HOURLY_LIMIT} extractions an hour per team`, async () => {
    const t0 = Date.parse("2026-10-08T12:00:00Z");
    for (let i = 0; i < LEARN_TEAM_HOURLY_LIMIT; i++) expect(await reserveLearnCall("org:a", t0 + i)).toEqual({ ok: true });
    const refused = await reserveLearnCall("org:a", t0 + 60_000);
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 3540 });
    expect(await reserveLearnCall("org:b", t0)).toEqual({ ok: true });
    expect(await reserveLearnCall("org:a", t0 + 3_600_001)).toEqual({ ok: true });
  });
});
