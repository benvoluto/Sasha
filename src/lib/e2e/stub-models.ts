// Deterministic model replies for e2e runs (SASHA_E2E_STUB_MODELS=1, see
// mode.ts). The hooks sit at the lowest level (claude.ts `send`, call.ts
// `callModel`, the Gemini extraction and table entry points), so parsing,
// usage and the audit rows run as they do for a real reply.
//
// A structured task gets the smallest value that satisfies its JSON schema,
// unless TASK_FIXTURES has a better one; a text task gets a short paragraph.
// Token counts are a fixed function of the text (about four characters a
// token), so the usage dashboard has numbers to show.
//
// The e2e track owns this file and refines the fixtures (phase9-spec.md §4.1).

export type StubUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };

/** The parts of an Anthropic message the callers read (claude.ts casts it). */
export type StubMessage = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<{ type: "text"; text: string; citations: null }>;
  stop_reason: "end_turn";
  stop_sequence: null;
  stop_details: null;
  usage: StubUsage & { server_tool_use: { web_search_requests: number } | null };
};

const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

// The learned draft for learn.extract: a small type and a review workflow that
// pass src/lib/learn/validate.ts, so the learn dialog reaches its review screen.
// The words are invented; nothing here comes from an example document.
const LEARN_TYPE = {
  key: "equipment-request",
  version: 1,
  title: "Equipment request",
  family: "business",
  summary: "A short internal request for a piece of equipment. It states what is needed, why, what it costs and who approves it.",
  signals: ["Equipment request", "Justification", "Costs", "Approval", "Total", "Signed by"],
  audience: "A department head deciding whether to fund the purchase.",
  tone: "Plain and factual.",
  preamble: "You write short internal equipment requests for a department head. Keep every section brief and concrete.",
  sections: [
    { key: "summary", heading: "Summary", order: 10, guidance: "Say in two sentences what is needed and what problem it solves.", elements: ["The item", "The problem it solves"] },
    { key: "justification", heading: "Justification", order: 20, guidance: "Explain the cost of not having the item: lost sessions, delays or risks.", elements: ["Who asks", "Impact without it"] },
    { key: "costs", heading: "Costs", order: 30, guidance: "List each cost line and the total; the lines must add up to the total.", elements: ["Cost lines", "Total"] },
    { key: "approval", heading: "Approval", order: 40, guidance: "Name the role that signs.", elements: ["Approver role", "Signature line"] },
  ],
  rubric: [
    {
      key: "costs_add_up",
      criterion: "The cost lines add up to the stated total.",
      appliesTo: ["costs"],
      levels: [
        { score: 2, descriptor: "Lines and total disagree." },
        { score: 8, descriptor: "Lines add up to the total." },
      ],
    },
  ],
  provenance: { source: "model", url: "", license: "Team", retrieved: "2026-10-08" },
};

const LEARN_WORKFLOW = {
  key: "equipment-request-review",
  version: 1,
  title: "Equipment request review",
  summary: "Checks the request is complete and its costs add up, then recommends approve or revise.",
  kind: "type",
  appliesTo: ["equipment-request"],
  outcome: { label: "Recommendation", values: [{ key: "approve", label: "Approve" }, { key: "revise", label: "Revise" }] },
  checkpoint: { role: "Department head", required: true },
  requirementSets: [],
  provenance: { source: "model", checked: "2026-10-08" },
  steps: [
    { id: "doc", node: "doc.read" },
    {
      id: "gate",
      node: "step.gate",
      config: { inputs: [{ key: "costs", label: "A costs section", kind: "section", specKeys: ["costs"], help: "Add the cost lines and total." }] },
      in: { document: "doc.document" },
    },
    {
      id: "chk",
      node: "step.check",
      config: { checklist: [{ key: "signed", label: "Approver named", question: "Does the request name the role that signs?", appliesTo: ["approval"] }] },
      in: { document: "doc.document", after: "gate.pass" },
    },
    {
      id: "dec",
      node: "step.decide",
      config: { values: ["approve", "revise"], guidance: "Approve when the request is complete and justified." },
      in: { findings: ["chk.findings"], after: "gate.pass" },
    },
    {
      id: "out",
      node: "outcome.report",
      config: { rules: [], fallback: "revise" },
      in: { blocked: "gate.blocked", value: "dec.value", rationale: "dec.rationale", findings: ["chk.findings"] },
    },
    { id: "cp", node: "checkpoint", config: { signsOutcome: true }, in: { items: "out.outcome" } },
  ],
};

/**
 * Per-task replies that a schema's minimal value would not exercise well. JSON
 * tasks give a value, text tasks a string. Each JSON fixture must parse with
 * the task's real zod schema (stub-models.test.ts checks the importable ones).
 */
export const TASK_FIXTURES: Record<string, unknown> = {
  // No candidates: the classifier chip stays away, so it never shifts the header under a test.
  "classify.type": { candidates: [], freeform: false },
  "outline.status": { sections: [] },
  "suggest.items": {
    coverage: [],
    proposals: [{ kind: "source", label: "A recent annual report", reason: "The end-to-end test stub suggests this so the Suggestions tab has a row to show.", spec_ref: null }],
  },
  // No title: an uploaded file keeps its own name in the library.
  "summarize.source": { summary: "A short summary written by the end-to-end test stub." },
  "learn.extract": {
    title: "Equipment request",
    type: JSON.stringify(LEARN_TYPE),
    workflow: JSON.stringify(LEARN_WORKFLOW),
    requirementSets: "[]",
    parts: [{ path: "type.sections.summary", note: "Opens with a two-sentence summary.", from: [{ example: 0, heading: null, quote: null }], shared: true }],
    differences: [],
    nearestType: null,
    personalDetails: [],
  },
  "rubric.check": { scores: [] },
  "draft.section": "This section was drafted by the end-to-end test stub. It is plain prose with no citations, so the editor can insert it as is.",
};

const TEXT_REPLY = "This paragraph was written by the end-to-end test stub. It stands in for a model reply so the flow can be checked without calling a paid API.";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  default?: unknown;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  definitions?: Record<string, JsonSchema>;
  format?: string;
};

/** The smallest value that satisfies `schema` (required properties only, minItems items). */
export function minimalValue(schema: JsonSchema | undefined, root: JsonSchema = schema ?? {}, depth = 0): unknown {
  if (!schema || depth > 20) return null;
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop() ?? "";
    return minimalValue(root.$defs?.[name] ?? root.definitions?.[name], root, depth + 1);
  }
  if ("const" in schema) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  const alt = schema.anyOf ?? schema.oneOf;
  if (alt?.length) return minimalValue(alt.find((s) => s.type !== "null") ?? alt[0], root, depth + 1);
  if (schema.allOf?.length) return Object.assign({}, ...schema.allOf.map((s) => minimalValue(s, root, depth + 1) as object));
  const type = Array.isArray(schema.type) ? (schema.type.find((t) => t !== "null") ?? schema.type[0]) : schema.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) out[key] = minimalValue(schema.properties?.[key], root, depth + 1);
      return out;
    }
    case "array":
      return Array.from({ length: schema.minItems ?? 0 }, () => minimalValue(schema.items, root, depth + 1));
    case "string":
      if (schema.format === "uri") return "https://example.com/";
      return "stub".padEnd(schema.minLength ?? 0, "x");
    case "integer":
    case "number":
      return schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 0);
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return null;
  }
}

/** A finished message for claude.ts. `jsonSchema` is the structured-output schema when the call asks for JSON. */
export function stubClaudeMessage(input: { task: string; model: string; system: string; user: string; jsonSchema?: JsonSchema | null; webSearch?: boolean }): StubMessage {
  const fixture = TASK_FIXTURES[input.task];
  const text =
    fixture !== undefined
      ? typeof fixture === "string"
        ? fixture
        : JSON.stringify(fixture)
      : input.jsonSchema
        ? JSON.stringify(minimalValue(input.jsonSchema))
        : TEXT_REPLY;
  return {
    id: `msg_e2e_${input.task}`,
    type: "message",
    role: "assistant",
    model: input.model,
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: tokens(input.system + input.user),
      output_tokens: tokens(text),
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: input.webSearch ? { web_search_requests: 0 } : null,
    },
  };
}

/** A reply for call.ts (workflow core nodes). */
export function stubCallModel(c: { model: string; system: string; user: string; json?: boolean; label?: string }): { text: string; truncated: false; model: string; usage: { input_tokens: number; output_tokens: number } } {
  const text = c.json === false ? TEXT_REPLY : "{}";
  return { text, truncated: false, model: c.model, usage: { input_tokens: tokens(c.system + c.user), output_tokens: tokens(text) } };
}

/** Gemini's text extraction for uploaded files: one readable page per file, with the document markers checkExtraction expects. */
export function stubGeminiExtraction(files: Array<{ name: string }>): { extractedContent: string; processedAt: string; fileCount: number; status: "success" } {
  const extractedContent = files
    .map((f) => `=== Document: ${f.name} ===\n--- Page 1 ---\nThis text was read by the end-to-end test stub from ${f.name}. It has enough words to count as readable text for the source library.`)
    .join("\n\n");
  return { extractedContent, processedAt: new Date().toISOString(), fileCount: files.length, status: "success" };
}

/** Gemini's table pass for a PDF or image: one small table on page 1. Shaped like GeminiTablesResult. */
export function stubGeminiTables(file: { name: string; mime: string }) {
  const method = file.mime.startsWith("image/") ? ("gemini-image" as const) : ("gemini-pdf" as const);
  return {
    ok: true as const,
    grids: [
      {
        name: "Stub table",
        match_key: "page:1#1",
        cells: [
          ["Item", "Amount"],
          ["Apples", "3"],
          ["Pears", "5"],
        ],
        truncated: false,
        method,
        page: 1,
        page_end: 1,
        confidence: 0.99,
        header_rows: 1,
      },
    ],
    warnings: [] as string[],
    dropped: [] as Array<{ title: string; page: number; reason: string }>,
    unread: [] as Array<{ first: number; last: number | null }>,
  };
}
