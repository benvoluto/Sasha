import { NextResponse } from "next/server";
import { getType } from "@/catalog";
import { getDocument, isUuid } from "@/lib/documents/store";
import { requireTeam } from "@/lib/documents/team";
import { claudeConfigured, ModelDeadlineError, ModelRefusalError, ModelTruncatedError } from "@/lib/llm/claude";
import { PERMISSIONS } from "@/lib/ontology/permissions";
import { processMemory } from "@/lib/process-memory";
import { documentCitationsBlock, inputsHash, rubricCriteriaFor, scopeSnapshot, scoreRubric, sectionFingerprints } from "@/lib/rubric/check";
import { MAX_CHECK_CHARS, RubricCheckRequest, textFingerprint, type RubricCheckError, type RubricCheckResponse } from "@/lib/rubric/contract";
import { checkScopeKey, getStoredCheck, reserveModelCheck, saveCheck } from "@/lib/rubric/store";
import { SectionId } from "@/lib/sections/contract";
import { documentBlock } from "@/lib/workflow/nodes/prompts";
import { snapshotDocument } from "@/lib/workflow/nodes/readers";

export const dynamic = "force-dynamic";
// One Sonnet call (rubric.check, 16k tokens) inside claudeJson's own deadline.
export const maxDuration = 300;

/** Characters of each section's text the check sends. */
const SECTION_CHARS = 20_000;

type Ctx = { params: Promise<{ id: string }> };

/** Model checks in progress, by team, document, scope and inputs: a second identical request shares the first. */
const inflight = processMemory("rubricCheck.inflight", () => new Map<string, Promise<RubricCheckResponse>>());

const fail = (error: string, status: number, extra: Omit<RubricCheckError, "error"> = {}) => NextResponse.json({ error, ...extra } satisfies RubricCheckError, { status });

/**
 * POST /api/documents/[id]/check — score the STORED document, or one section
 * of it, against its type's rubric plus the universal one (the client saves
 * first). The same inputs return the last result (`cached: true`) unless
 * `force`; otherwise the per-scope interval and the team's hourly limit gate
 * the model call.
 */
export async function POST(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentWrite);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  if (!isUuid(id)) return fail("Document not found.", 404);
  const parsed = RubricCheckRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
  const body = parsed.data;
  const doc = await getDocument(caller.teamId, id);
  if (!doc) return fail("Document not found.", 404);
  const def = (await getType(caller.teamId, doc.type_key))?.definition ?? null;
  const d = snapshotDocument(doc, def, SECTION_CHARS);

  const sectionId = body.scope === "section" ? body.sectionId : null;
  const section = sectionId ? d.sections.find((s) => s.sectionId === sectionId) : null;
  if (sectionId && !section) return fail("That section no longer exists.", 404);
  // Headings alone are nothing to score.
  const empty = section ? !section.text.trim() : d.sections.length ? !d.preamble.trim() && d.sections.every((s) => !s.text.trim()) : !d.text.trim();
  if (empty) return fail(section ? "This section is empty." : "The document is empty.", 400);
  if (!section && d.text.length > MAX_CHECK_CHARS) return fail("This document is too long to check at once. Check one section at a time.", 413);

  const criteria = rubricCriteriaFor(d, section ? { section: { specKey: section.specKey } } : {});
  const checked = section ? scopeSnapshot(d, [section.sectionId]) : d;
  // The prompt clips each section to SECTION_CHARS, but the cache key and the
  // interval follow the full text in scope (the fingerprints the panel compares
  // to call a result stale), so an edit past the clip still counts as a change.
  const fingerprints = sectionFingerprints(doc.content_json, sectionId);
  // What the text in scope cites, so the model counts cited claims as
  // attributed. Part of the inputs: adding or removing a citation re-checks.
  const citations = await documentCitationsBlock(caller.teamId, id, doc.content_json, sectionId ? [sectionId] : null);
  const scopeText = [documentBlock(checked), JSON.stringify(fingerprints), section ? "" : textFingerprint(d.text), citations ?? ""].join("\n");
  const hash = inputsHash(criteria, d.typeKey, d.type?.version ?? null, scopeText);
  const scopeKey = checkScopeKey(sectionId);
  const last = await getStoredCheck(caller.teamId, id, scopeKey);
  if (last && last.inputsHash === hash && !body.force) return NextResponse.json({ ...last.result, cached: true } satisfies RubricCheckResponse);
  if (!claudeConfigured()) return fail("Claude is not configured.", 503);

  const key = `${caller.teamId}\u0000${id}\u0000${scopeKey}\u0000${hash}`;
  let running = inflight.get(key);
  if (!running) {
    // Counts this call too when it passes: the gate and the count are one step.
    const gate = await reserveModelCheck(caller.teamId, last, hash);
    if (!gate.ok) {
      const message = gate.reason === "interval" ? `Checked moments ago. Try again in ${gate.retryAfterSeconds}s.` : `Your team has used its rubric checks for this hour. Try again in ${Math.ceil(gate.retryAfterSeconds / 60)} min.`;
      return fail(message, 429, { retryAfterSeconds: gate.retryAfterSeconds });
    }
    running = (async () => {
      const { results, dropped } = await scoreRubric(d, { criteria, drafted: null, sectionIds: section ? [section.sectionId] : undefined, citations, call: { agent: caller.agent, documentId: id } });
      const response: RubricCheckResponse = {
        scope: body.scope,
        sectionId,
        typeKey: d.typeKey,
        typeVersion: d.type?.version ?? null,
        inputsHash: hash,
        cached: false,
        checkedAt: new Date().toISOString(),
        sectionFingerprints: fingerprints,
        results,
        droppedEvidence: dropped,
      };
      await saveCheck(caller.teamId, id, scopeKey, hash, response);
      return response;
    })().finally(() => inflight.delete(key));
    inflight.set(key, running);
  }

  try {
    return NextResponse.json((await running) satisfies RubricCheckResponse);
  } catch (error) {
    if (error instanceof ModelRefusalError || error instanceof ModelTruncatedError) return fail(error.message, 422);
    if (error instanceof ModelDeadlineError) return fail(`${error.message} Try again.`, 504);
    console.error("[check] failed:", error);
    return fail("The check failed. Try again.", 502);
  }
}

/** GET /api/documents/[id]/check?sectionId=… (omit for the document) — the last result for that scope, or 404. */
export async function GET(req: Request, { params }: Ctx) {
  const caller = await requireTeam(PERMISSIONS.documentRead);
  if (caller instanceof NextResponse) return caller;
  const { id } = await params;
  const sectionId = new URL(req.url).searchParams.get("sectionId");
  if (!isUuid(id) || (sectionId !== null && !SectionId.safeParse(sectionId).success)) return fail("Document not found.", 404);
  if (!(await getDocument(caller.teamId, id))) return fail("Document not found.", 404);
  const last = await getStoredCheck(caller.teamId, id, checkScopeKey(sectionId));
  if (!last) return fail("No check yet.", 404);
  return NextResponse.json({ ...last.result, cached: true } satisfies RubricCheckResponse);
}
