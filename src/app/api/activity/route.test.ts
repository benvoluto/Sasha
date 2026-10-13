import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({ activityFeed: vi.fn(), permissions: [] as string[], denied: false }));
vi.mock("@/lib/documents/team", () => ({
  requireTeam: async () => (mocks.denied ? NextResponse.json({ error: "Sign in to continue." }, { status: 401 }) : { teamId: "org:a", agent: "ann", permissions: mocks.permissions }),
}));
vi.mock("@/lib/activity/feed", () => ({ activityFeed: mocks.activityFeed }));

import { ACTIVITY_LIMIT_MAX } from "@/lib/activity/contract";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { GET } from "./route";

const get = (qs = "") => GET(new Request(`http://x/api/activity${qs}`));

describe("GET /api/activity", () => {
  beforeEach(() => {
    mocks.denied = false;
    mocks.permissions = [PERMISSIONS.documentRead, PERMISSIONS.workflowRead];
    mocks.activityFeed.mockReset().mockResolvedValue([{ kind: "document", id: "doc:1" }]);
  });

  it("answers the team's feed with runs for a caller who can read workflows", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ kind: "document", id: "doc:1" }] });
    expect(mocks.activityFeed).toHaveBeenCalledWith("org:a", { limit: 50, includeRuns: true });
  });

  it("leaves runs out without workflowRead", async () => {
    mocks.permissions = [PERMISSIONS.documentRead];
    await get();
    expect(mocks.activityFeed).toHaveBeenCalledWith("org:a", { limit: 50, includeRuns: false });
  });

  it("caps the limit and rejects a bad one", async () => {
    await get("?limit=7");
    expect(mocks.activityFeed).toHaveBeenLastCalledWith("org:a", { limit: 7, includeRuns: true });
    await get("?limit=100000");
    expect(mocks.activityFeed).toHaveBeenLastCalledWith("org:a", { limit: ACTIVITY_LIMIT_MAX, includeRuns: true });
    for (const bad of ["0", "-1", "abc", "2.5", ""]) {
      const res = await get(`?limit=${bad}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid limit." });
    }
  });

  it("passes the auth failure through", async () => {
    mocks.denied = true;
    expect((await get()).status).toBe(401);
    expect(mocks.activityFeed).not.toHaveBeenCalled();
  });
});
