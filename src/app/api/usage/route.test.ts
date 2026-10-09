import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const team = vi.hoisted(() => ({ deny: null as Response | null, teamId: "org:a", permission: null as string | null }));
vi.mock("@/lib/documents/team", () => ({
  requireTeam: async (permission: string) => {
    team.permission = permission;
    return team.deny ?? { teamId: team.teamId, userId: "u1", agent: "ann@x.org", permissions: [] };
  },
}));

import { memoryAuditSink, resetMemoryAudit, type AuditEntry } from "@/lib/ontology/governance";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { USAGE_CSV_COLUMNS, type UsageResponse } from "@/lib/usage/contract";
import { GET } from "./route";

const get = (qs = "") => GET(new Request(`http://x/api/usage${qs}`));

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  agent: "ann@x.org",
  action: "llm:rubric.check",
  args: {},
  result: { model: "claude-sonnet-5-5", input_tokens: 2000, output_tokens: 500 },
  allowed: true,
  teamId: "org:a",
  userId: "u1",
  task: "rubric.check",
  model: "claude-sonnet-5-5",
  ...over,
});

describe("GET /api/usage", () => {
  beforeEach(async () => {
    delete process.env.POSTGRES_URL;
    team.deny = null;
    team.teamId = "org:a";
    resetMemoryAudit();
    await memoryAuditSink.write(entry());
    await memoryAuditSink.write(entry({ teamId: "org:b", userId: "b1", agent: "=evil@b.org" }));
  });
  afterEach(() => resetMemoryAudit());

  it("requires audit:read", async () => {
    team.deny = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    expect((await get()).status).toBe(403);
    expect(team.permission).toBe(PERMISSIONS.auditRead);
  });

  it("returns the caller's team's usage for the default range, never another team's", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageResponse;
    expect(body.memoryOnly).toBe(true);
    expect(body.byDay).toHaveLength(30);
    expect(body.range.to).toBe(new Date().toISOString().slice(0, 10));
    expect(body.totals).toMatchObject({ calls: 1, input_tokens: 2000, output_tokens: 500 });
    expect(body.totals.cost_usd).toBeCloseTo(0.009, 6);
    expect(body.byUser.map((u) => u.user)).toEqual(["u1"]);
    expect(JSON.stringify(body)).not.toContain("evil");

    team.teamId = "org:b";
    const other = (await (await get()).json()) as UsageResponse;
    expect(other.byUser.map((u) => u.user)).toEqual(["b1"]);
  });

  it("rejects malformed, reversed and too-long ranges with a plain message", async () => {
    for (const qs of ["?from=yesterday", "?from=2026-10-05&to=2026-10-01", "?from=2024-01-01&to=2026-01-01", "?format=xml", "?from=2026-02-30"]) {
      const res = await get(qs);
      expect(res.status, qs).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
  });

  it("treats empty parameters as absent", async () => {
    expect((await get("?from=&to=")).status).toBe(200);
  });

  it("downloads CSV as an attachment, one line per day, user, task and model", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await get(`?from=${today}&to=${today}&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="sasha-usage-${today}-to-${today}.csv"`);
    const lines = (await res.text()).replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe(USAGE_CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(",u1,ann@x.org,rubric.check,claude-sonnet-5-5,1,0,2000,500,");
  });
});
