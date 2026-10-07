// The document assistant's model-driven loop: open-ended questions with no
// fixed tool order. Implemented in-process with the app's Gemini client, with
// every tool call going through the read-only, audited choke point. The model
// reads the sources and explains; it never writes.

import { GoogleGenAI, Type, type Content, type FunctionDeclaration, type Schema } from "@google/genai";
import { GEMINI_MODEL } from "@/lib/gemini-model";
import type { Auth } from "../governance";
import type { SourceDocument } from "@/lib/sources/passages";
import { renderMenu } from "./menu";
import { governedTool } from "./governance";
import { ASSISTANT_TOOLS, loadSources } from "./tools";

export type AssistantMessage = { role: "user" | "assistant"; content: string };
export type ToolTraceEntry = { tool: string; target: string; ok: boolean };

const MAX_STEPS = 6;

const PERSONA = `You are a writing assistant for one document. You help the user
understand the source files uploaded to it and plan or improve their writing.

Rules:
- Answer only from what you read via your tools. If a tool returns nothing or an
  error, say the information isn't available — do not guess.
- Start with list_documents when you don't yet know what sources exist; use
  search_text to find specific facts and read_document to read around them.
- Name the source file you are relying on when you state a fact.
- Be concise.`;

const TOOLS: FunctionDeclaration[] = Object.values(ASSISTANT_TOOLS).map((t) => ({
  name: t.name,
  description: t.description,
  parameters: {
    type: Type.OBJECT,
    properties: Object.fromEntries(Object.entries(t.params).map(([k, d]) => [k, { type: Type.STRING, description: d } satisfies Schema])),
    required: t.required,
  },
}));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errDetail(e: unknown): string {
  const s = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return s.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Call the model with one retry; report the error text instead of throwing. */
async function generate<T>(fn: () => Promise<T>, label: string): Promise<{ ok: true; value: T } | { ok: false; detail: string }> {
  let detail = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      detail = errDetail(e);
      console.error(`[assistant] ${label} attempt ${attempt + 1} failed: ${detail}`);
      if (attempt === 0) await sleep(500);
    }
  }
  return { ok: false, detail };
}

/** A compact, read-only snapshot of the sources for the no-tools fallback. */
async function sourceBriefing(auth: Auth, groupId: string): Promise<string> {
  const listing = await governedTool(auth, "list_documents", {}, groupId).catch(() => null);
  const docs = (listing as { documents?: Array<{ doc_id: string }> } | null)?.documents ?? [];
  const sections = [`### list_documents\n${JSON.stringify(listing)}`];
  for (const d of docs.slice(0, 4)) {
    const r = (await governedTool(auth, "read_document", { doc: d.doc_id }, groupId).catch(() => null)) as { name?: string; text?: string } | null;
    if (r?.text) sections.push(`### ${r.name ?? d.doc_id}\n${r.text.slice(0, 2000)}`);
  }
  return sections.join("\n\n").slice(0, 9000);
}

/**
 * Fallback when the tool-enabled (function-calling) request fails: pre-fetch a
 * briefing of the sources and answer WITHOUT tools. Keeps the assistant working even if
 * the model rejects function calling, while staying read-only + audited.
 */
async function answerFromBriefing(
  ai: GoogleGenAI,
  baseSystem: string,
  messages: AssistantMessage[],
  auth: Auth,
  groupId: string,
  trace: ToolTraceEntry[],
  priorDetail: string,
): Promise<{ answer: string; trace: ToolTraceEntry[] }> {
  const briefing = await sourceBriefing(auth, groupId).catch(() => "");
  const contents: Content[] = messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const systemInstruction = `${baseSystem}\n\nLive tools are unavailable this turn. Answer ONLY from the SOURCE BRIEFING below. If it doesn't contain the answer, say the information isn't available.\n\nSOURCE BRIEFING:\n${briefing || "(no data available)"}`;
  const r = await generate(() => ai.models.generateContent({ model: GEMINI_MODEL, contents, config: { systemInstruction, temperature: 0.2 } }), "briefing");
  if (r.ok) {
    const text = (r.value.text || "").trim();
    if (text) return { answer: text, trace };
  }
  const detail = r.ok ? "empty model response" : r.detail || priorDetail;
  return { answer: `The assistant couldn't reach the model right now — please try again shortly. (diagnostic: ${detail})`, trace };
}

export async function runDocumentAssistant(input: {
  groupId: string;
  auth: Auth;
  messages: AssistantMessage[];
}): Promise<{ answer: string; trace: ToolTraceEntry[] }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { answer: "The assistant is unavailable (no model API key configured).", trace: [] };

  const ai = new GoogleGenAI({ apiKey });
  const systemInstruction = `${PERSONA}\n\n${renderMenu(input.auth)}\n\n(The document is fixed; all tools operate on its sources.)`;
  const contents: Content[] = input.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const trace: ToolTraceEntry[] = [];
  // Load the group's sources at most once per turn, however many tools run.
  let cached: Promise<SourceDocument[]> | null = null;
  const sources = () => (cached ??= loadSources(input.groupId));

  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await generate(
      () => ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: { systemInstruction, temperature: 0.2, tools: [{ functionDeclarations: TOOLS }] },
      }),
      "tool-call",
    );
    // The tool-calling request is the fragile one; if it won't go through, answer
    // from a briefing instead of failing the turn.
    if (!r.ok) return answerFromBriefing(ai, systemInstruction, input.messages, input.auth, input.groupId, trace, r.detail);
    const response = r.value;

    const calls = response.functionCalls ?? [];
    if (calls.length === 0) {
      return { answer: (response.text || "").trim() || "I couldn't find enough in the sources to answer that.", trace };
    }

    // Record the model's tool calls, then execute each through the audited,
    // read-only choke point and feed the results back.
    contents.push({ role: "model", parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) });
    const responseParts = [];
    for (const call of calls) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      let out: unknown;
      const target = JSON.stringify(args).slice(0, 120);
      try {
        out = await governedTool(input.auth, call.name ?? "", args, input.groupId, sources);
      } catch (error) {
        // A tool failure must not crash the turn — feed the error back to the model.
        console.error(`[assistant] tool '${call.name}' ${target} failed:`, error);
        out = { error: "tool execution failed" };
      }
      trace.push({ tool: call.name ?? "?", target, ok: !!out && typeof out === "object" && !("error" in out) });
      // functionResponse.response must be a JSON object; wrap nulls/arrays/primitives
      // (e.g. a query that returned null) so the SDK doesn't reject the next request.
      const response_obj = out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : { result: out ?? null };
      responseParts.push({ functionResponse: { name: call.name ?? "", response: response_obj } });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  // Ran out of tool budget — force a final text answer without tools.
  const fin = await generate(
    () => ai.models.generateContent({ model: GEMINI_MODEL, contents, config: { systemInstruction, temperature: 0.2 } }),
    "final",
  );
  if (fin.ok) return { answer: (fin.value.text || "").trim() || "I read the sources but couldn't compose an answer — please rephrase.", trace };
  return answerFromBriefing(ai, systemInstruction, input.messages, input.auth, input.groupId, trace, fin.detail);
}
