import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/team", () => ({ requireTeam: async () => ({ teamId: "org:a", agent: "ann" }) }));

import { createDocFolder } from "@/lib/documents/folder-store";
import { resetMemoryStore } from "@/lib/documents/store";
import { GET, POST } from "./route";

const post = (body: unknown) => POST(new Request("http://x/api/document-folders", { method: "POST", body: JSON.stringify(body) }));

describe("/api/document-folders", () => {
  beforeEach(() => {
    delete process.env.POSTGRES_URL;
    resetMemoryStore();
  });

  it("creates a folder (201) and lists the team's folders by name", async () => {
    const res = await post({ name: "  Grants " });
    expect(res.status).toBe(201);
    const { folder } = await res.json();
    expect(folder).toMatchObject({ name: "Grants", document_count: 0, created_by: "ann" });
    await post({ name: "applications" });
    await createDocFolder("org:b", "zed", "Elsewhere");

    const list = await (await GET()).json();
    expect(list.folders.map((f: { name: string }) => f.name)).toEqual(["applications", "Grants"]);
  });

  it("400s an empty or too-long name and 409s a duplicate (ignoring case)", async () => {
    expect(await (await post({ name: "  " })).json()).toEqual({ error: "Name the folder." });
    expect((await post({})).status).toBe(400);
    const long = await post({ name: "x".repeat(121) });
    expect(long.status).toBe(400);
    expect((await long.json()).error).toMatch(/120 characters/);

    expect((await post({ name: "Grants" })).status).toBe(201);
    const dup = await post({ name: "GRANTS" });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "A folder with that name already exists." });
  });
});
