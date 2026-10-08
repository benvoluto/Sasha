import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ del: vi.fn(), list: vi.fn() }));
vi.mock("@vercel/blob", () => ({ del: mocks.del, list: mocks.list }));

import { DELETE } from "./route";

describe("DELETE /api/upload-groups/[id]", () => {
  it("is retired: legacy groups have no team to check, so nothing is deleted", async () => {
    const res = await DELETE();
    expect(res.status).toBe(410);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });
});
