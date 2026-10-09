import { beforeEach, describe, expect, it, vi } from "vitest";
import { permissionsForRole, PERMISSIONS } from "@/lib/ontology/permissions";

const mocks = vi.hoisted(() => ({
  caller: { current: { teamId: "org:a", agent: "ann", userId: "u", orgId: "a", permissions: [] as string[] } },
  configured: { value: true },
  claudeJson: vi.fn(),
  audit: [] as Array<{ action: string; result: unknown; allowed: boolean }>,
}));
vi.mock("@/lib/documents/team", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireTeam: async (permission: string) =>
      mocks.caller.current.permissions.includes(permission) ? mocks.caller.current : NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 }),
  };
});
vi.mock("@/lib/llm/claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/claude")>()),
  claudeConfigured: () => mocks.configured.value,
  claudeJson: mocks.claudeJson,
}));
vi.mock("@/lib/ontology/governance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ontology/governance")>()),
  defaultAuditSink: () => ({ write: async (e: { action: string; result: unknown; allowed: boolean }) => void mocks.audit.push(e) }),
}));

import { resetCatalogStore } from "@/catalog/store";
import { resetMemoryStore } from "@/lib/documents/store";
import { ModelRefusalError } from "@/lib/llm/claude";
import { DEFAULT_LIMITS } from "@/lib/limits/contract";
import { LEARN_TEAM_HOURLY_LIMIT, type LearnDraft, type LearnResponse } from "@/lib/learn/contract";
import { resetLearnStore } from "@/lib/learn/store";
import { createSource, resetSourceStore } from "@/lib/sources/store";
import { listWorkflows, resetWorkflowStore } from "@/lib/workflow/store";
import { EXAMPLE_A, modelReply, USAGE } from "@/lib/learn/__fixtures__/learn-reply";
import { POST as SAVE } from "./save/route";
import { POST } from "./route";

const as = (permissions: string[]) => (mocks.caller.current = { ...mocks.caller.current, permissions });
const post = (body: unknown, handler = POST, url = "http://x/api/document-types/learn") => handler(new Request(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
const save = (body: unknown) => post(body, SAVE, "http://x/api/document-types/learn/save");

async function example() {
  const s = await createSource("org:a", "ann", { kind: "note", title: "Centrifuge", extracted_text: EXAMPLE_A, extraction_status: "ready" });
  return [{ kind: "source", sourceId: s.id }];
}

async function learn(): Promise<{ examples: Awaited<ReturnType<typeof example>>; draft: LearnDraft }> {
  const examples = await example();
  mocks.claudeJson.mockResolvedValueOnce({ data: modelReply(), usage: USAGE });
  const res = await post({ examples });
  expect(res.status).toBe(200);
  return { examples, draft: ((await res.json()) as LearnResponse).draft };
}

beforeEach(() => {
  delete process.env.POSTGRES_URL;
  resetMemoryStore();
  resetSourceStore();
  resetCatalogStore();
  resetWorkflowStore();
  resetLearnStore();
  mocks.claudeJson.mockReset();
  mocks.configured.value = true;
  mocks.audit.length = 0;
  as(permissionsForRole("member"));
});

describe("POST /api/document-types/learn", () => {
  it("returns a draft, audits counts only, and saves nothing", async () => {
    const { draft } = await learn();
    expect(draft.type.key).toBe("equipment-request");
    expect(draft.confidence).toBe("low");
    const entry = mocks.audit.find((a) => a.action === "learn_type_extract")!;
    expect(entry).toMatchObject({ allowed: true, result: { type: "equipment-request", confidence: "low", repaired: false, tokens: 150 } });
    expect(JSON.stringify(entry)).not.toContain("centrifuge");
    expect(await listWorkflows("org:a")).toEqual([]);
  });

  it("needs document:write, Claude, and a valid request", async () => {
    as([PERMISSIONS.documentRead]);
    expect((await post({ examples: [] })).status).toBe(403);
    as(permissionsForRole("member"));
    mocks.configured.value = false;
    expect((await post({ examples: await example() })).status).toBe(503);
    mocks.configured.value = true;
    const bad = await post({ examples: [] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).issues[0]).toMatch(/^examples/);
    expect((await post("{oops")).status).toBe(400);
    expect((await post({ examples: Array.from({ length: 6 }, () => ({ kind: "document", documentId: crypto.randomUUID() })) })).status).toBe(400);
  });

  it("checks the examples before spending the hourly allowance (404 unknown, 409 still reading)", async () => {
    expect((await post({ examples: [{ kind: "source", sourceId: crypto.randomUUID() }] })).status).toBe(404);
    const busy = await createSource("org:a", "ann", { kind: "note", title: "Busy", extraction_status: "extracting" });
    expect((await post({ examples: [{ kind: "source", sourceId: busy.id }] })).status).toBe(409);
    expect(mocks.claudeJson).not.toHaveBeenCalled();
  });

  it(`caps extractions per user and at ${LEARN_TEAM_HOURLY_LIMIT} an hour per team (429 with Retry-After)`, async () => {
    const examples = await example();
    mocks.claudeJson.mockResolvedValue({ data: modelReply(), usage: USAGE });
    const userLimit = DEFAULT_LIMITS.learn.user[0].limit;
    for (let i = 0; i < userLimit; i++) expect((await post({ examples })).status).toBe(200);
    const mine = await post({ examples });
    expect(mine.status).toBe(429);
    expect(Number(mine.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await mine.json()).toMatchObject({ code: "rate_limited", scope: "user", family: "learn", error: expect.stringMatching(/^You've used your 4 learning runs for this hour\. Try again in \d+ min\.$/) });

    mocks.caller.current = { ...mocks.caller.current, userId: "u2" };
    for (let i = userLimit; i < LEARN_TEAM_HOURLY_LIMIT; i++) expect((await post({ examples })).status).toBe(200);
    const team = await post({ examples });
    expect(team.status).toBe(429);
    expect(await team.json()).toMatchObject({ scope: "team", error: expect.stringMatching(/^Your team has used its 6 learning runs for this hour/) });
    expect(mocks.claudeJson).toHaveBeenCalledTimes(LEARN_TEAM_HOURLY_LIMIT);
    mocks.caller.current = { ...mocks.caller.current, userId: "u" };
  });

  it("maps a refusal to 422 and other failures to 502, audited as not allowed", async () => {
    const examples = await example();
    mocks.claudeJson.mockRejectedValueOnce(new ModelRefusalError(null));
    expect((await post({ examples })).status).toBe(422);
    mocks.claudeJson.mockRejectedValueOnce(new Error("socket hang up"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ examples });
    expect(res.status).toBe(502);
    expect((await res.json()).error).not.toContain("socket");
    expect(mocks.audit.filter((a) => a.action === "learn_type_extract" && !a.allowed)).toHaveLength(2);
  });
});

describe("POST /api/document-types/learn/save", () => {
  const body = (examples: unknown, draft: LearnDraft, extra: Record<string, unknown> = {}) => ({ examples, type: draft.type, workflow: draft.workflow, requirementSets: draft.requirementSets, reviewed: true, ...extra });

  it("saves the reviewed draft (201) with the workflow bound to the type; a second save is 409", async () => {
    const { examples, draft } = await learn();
    const res = await save(body(examples, draft));
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out).toMatchObject({ type: { key: "equipment-request", origin: "team" }, requirementSets: ["team-approvals"] });
    expect((await listWorkflows("org:a"))[0]).toMatchObject({ id: out.workflow.id, applies_to: "equipment-request" });
    expect(mocks.audit.some((a) => a.action === "learn_type_saved")).toBe(true);
    expect((await save(body(examples, draft))).status).toBe(409);
  });

  it("needs the author's checkpoint and both permissions", async () => {
    const { examples, draft } = await learn();
    expect((await save(body(examples, draft, { reviewed: false }))).status).toBe(400);
    as(permissionsForRole("member").filter((p) => p !== PERMISSIONS.workflowEdit));
    expect((await save(body(examples, draft))).status).toBe(403);
  });

  it("refuses (422) a draft with a personal detail put back in", async () => {
    const { examples, draft } = await learn();
    const type = { ...draft.type, preamble: "Write like Marisol Quintanilla Ortega." };
    const res = await save(body(examples, { ...draft, type }));
    expect(res.status).toBe(422);
    const out = await res.json();
    expect(out.personalDetails).toEqual([{ path: "type.preamble", text: "Marisol Quintanilla Ortega", kind: "name", removed: false }]);
    expect(out.overlaps).toEqual([]);
  });

  it("refuses examples the team can't read (404)", async () => {
    const { draft } = await learn();
    const res = await save(body([{ kind: "source", sourceId: crypto.randomUUID() }], draft));
    expect(res.status).toBe(404);
  });
});
