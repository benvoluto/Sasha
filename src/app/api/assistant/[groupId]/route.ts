import { NextRequest, NextResponse } from "next/server";
import { authFromClerk } from "@/lib/ontology/permissions";
import { runDocumentAssistant, type AssistantMessage } from "@/lib/ontology/assistant/agent";

export const runtime = "nodejs";
export const maxDuration = 60;

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
    const { answer, trace } = await runDocumentAssistant({ groupId, auth, messages });
    return NextResponse.json({ answer, trace });
  } catch (error) {
    console.error("[assistant] failed:", error);
    return NextResponse.json({ error: "assistant failed" }, { status: 500 });
  }
}
