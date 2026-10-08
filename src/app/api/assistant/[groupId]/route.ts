import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { claudeConfigured } from "@/lib/llm/claude";
import { authFromClerk } from "@/lib/ontology/permissions";
import { runDocumentAssistant, type AssistantMessage } from "@/lib/ontology/assistant/agent";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Per model request, with one retry. */
const REQUEST_TIMEOUT_MS = 90_000;
/** The whole tool loop (up to seven model calls) stops here, leaving time to audit and reply. */
const TURN_DEADLINE_MS = 270_000;

/**
 * A client for one turn: each request times out on its own, and every request
 * is aborted once the turn's deadline passes, so the assistant's catch (which
 * writes the audit entry) runs before the function is killed.
 */
function turnClient(): Anthropic {
  const deadline = AbortSignal.timeout(TURN_DEADLINE_MS);
  return new Anthropic({
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 1,
    fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline }),
  });
}

const MAX_MESSAGES = 20;
const MAX_LEN = 4000;

/**
 * POST /api/assistant/[groupId]
 * Body: { messages: [{ role: "user" | "assistant", content }] }
 * Read-only, audited Q&A over the document's sources. Never writes.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  const auth = await authFromClerk();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { messages?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages: AssistantMessage[] = raw
    .filter(
      (m): m is AssistantMessage =>
        !!m &&
        typeof (m as AssistantMessage).content === "string" &&
        ((m as AssistantMessage).role === "user" || (m as AssistantMessage).role === "assistant"),
    )
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_LEN) }));

  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "a trailing user message is required" }, { status: 400 });
  }

  try {
    const client = claudeConfigured() ? turnClient() : undefined;
    const { answer, trace } = await runDocumentAssistant({ groupId, auth, messages, client });
    return NextResponse.json({ answer, trace });
  } catch (error) {
    console.error("[assistant] failed:", error);
    return NextResponse.json({ error: "assistant failed" }, { status: 500 });
  }
}
