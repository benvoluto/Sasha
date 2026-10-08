import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getType: vi.fn() }));
vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));
vi.mock("@/catalog", () => ({ getType: mocks.getType }));

import { getDocument, resetMemoryStore } from "@/lib/documents/store";
import { listSections } from "@/lib/documents/sections";
import { testType } from "@/lib/sections/test-fixtures";
import { POST } from "./route";

const post = (body: unknown) => POST(new Request("http://x/api/documents", { method: "POST", body: JSON.stringify(body) }));
const def = testType();

describe("POST /api/documents", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
    mocks.getType.mockReset().mockImplementation(async (_team: string, key: string) =>
      key === def.key || def.aliases.includes(key) ? { definition: def, origin: "file", enabled: true, overridden: false, updated_at: null } : null,
    );
  });

  it("builds the type's outline when only type_key is given, storing the canonical key", async () => {
    const res = await post({ type_key: "test_proposal" });
    expect(res.status).toBe(201);
    const { document } = await res.json();
    expect(document.type_key).toBe("test-proposal");
    const stored = await getDocument("org:a", document.id);
    const sections = listSections(stored!.content_json);
    expect(sections.map((s) => [s.heading, s.specKey])).toEqual([
      ["Header", "memo-header"],
      ["Summary", "summary"],
      ["Budget", "budget"],
      ["Timeline", "timeline"],
    ]);
    expect(sections.every((s) => /^s_[a-z0-9]{8}$/.test(s.sectionId))).toBe(true);
    expect(sections[0].bodyText).toContain("To:");
  });

  it("400s an unknown or disabled type", async () => {
    expect((await post({ type_key: "nope" })).status).toBe(400);
    mocks.getType.mockResolvedValue({ definition: def, origin: "file", enabled: false, overridden: false, updated_at: null });
    const res = await post({ type_key: def.key });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unknown document type." });
  });

  it("keeps the given body when content_json is sent", async () => {
    const content_json = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] };
    const res = await post({ type_key: "anything", content_json });
    expect(res.status).toBe(201);
    const { document } = await res.json();
    expect(document).toMatchObject({ type_key: "anything", content_text: "Hi" });
    expect(mocks.getType).not.toHaveBeenCalled();
    expect((await post({})).status).toBe(201);
  });
});
