// Generation for the editable report. Every section in a template is drafted
// by a model from the document's uploaded sources, then converted to Tiptap
// JSON, persisted, and audited. Section-by-section, with a concurrent
// generate-all that never overwrites a reviewed section. The report's
// `template_key` picks the outline and the drafting preamble.

import { sql } from "@vercel/postgres";
import { GoogleGenAI } from "@google/genai";
import { GEMINI_MODEL } from "@/lib/gemini-model";
import { type Auth, type AuditSink, can, defaultAuditSink } from "../governance";
import { fetchGroupMetadata } from "../group-metadata";
import { PERMISSIONS } from "../permissions";
import { GENERAL_REPORT_TEMPLATE_KEY, isRewritable, templateByKey, type ReportSectionSpec, type ReportTemplate } from "./template";
import { markdownToTiptap, tiptapToText, type PMDoc } from "@/lib/report/markdown-to-tiptap";
import { REWRITE_PRESETS } from "@/lib/report/rewrite-presets";

export const WRITE_PERMISSION = PERMISSIONS.reportWrite;

export const REPORTER: Auth = {
  agent: "report_generator",
  permissions: [PERMISSIONS.documentRead, PERMISSIONS.sourceRead, WRITE_PERMISSION],
};

const GEN_CONCURRENCY = 4;
const MAX_EVIDENCE = 12_000;

export type ReportSectionRow = {
  section_key: string;
  heading: string;
  sort_order: number;
  content_json: PMDoc | Record<string, unknown>;
  content_text: string;
  status: string;
  source: string;
  updated_at: string;
  /** Whether the section can be rewritten with a model (narrative sections). */
  rewritable: boolean;
};

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

/**
 * Create the report + pending sections from a template if none exists
 * (idempotent). `templateKey` only applies when the report is created.
 */
export async function ensureReport(
  groupId: string,
  opts: { auth?: Auth; templateKey?: string } = {},
): Promise<{ reportId: number; template: ReportTemplate } | { error: string }> {
  const auth = opts.auth ?? REPORTER;
  if (!can(auth, WRITE_PERMISSION)) return { error: `permission denied: requires '${WRITE_PERMISSION}'` };
  if (!process.env.POSTGRES_URL) return { error: "no database configured" };

  const existing = await sql`SELECT id, template_key FROM report WHERE group_id = ${groupId} LIMIT 1`;
  if (existing.rows[0]) return { reportId: Number(existing.rows[0].id), template: templateByKey(existing.rows[0].template_key as string) };

  const template = templateByKey(opts.templateKey ?? GENERAL_REPORT_TEMPLATE_KEY);
  const { rows } = await sql`
    INSERT INTO report (group_id, template_key, title, created_by)
    VALUES (${groupId}, ${template.key}, ${template.title}, ${auth.agent})
    ON CONFLICT (group_id) DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  const reportId = Number(rows[0].id);
  for (const s of template.sections) {
    await sql`
      INSERT INTO report_section (report_id, group_id, section_key, heading, sort_order, content_json, content_text, status)
      VALUES (${reportId}, ${groupId}, ${s.key}, ${s.heading}, ${s.order}, '{}'::jsonb, '', 'pending')
      ON CONFLICT (report_id, section_key) DO NOTHING
    `;
  }
  return { reportId, template };
}

/** Read the report + its sections (ordered). Null when none. */
export async function getReport(groupId: string): Promise<{ report: Record<string, unknown>; sections: ReportSectionRow[] } | null> {
  if (!process.env.POSTGRES_URL) return null;
  const r = await sql`SELECT id, group_id, template_key, title, status, created_at, updated_at FROM report WHERE group_id = ${groupId} LIMIT 1`;
  if (!r.rows[0]) return null;
  const reportId = Number(r.rows[0].id);
  const template = templateByKey(r.rows[0].template_key as string);
  const s = await sql`
    SELECT section_key, heading, sort_order, content_json, content_text, status, source, updated_at
    FROM report_section WHERE report_id = ${reportId} ORDER BY sort_order ASC
  `;
  const sections = s.rows.map((row) => {
    const spec = template.sections.find((x) => x.key === row.section_key);
    return { ...row, rewritable: spec ? isRewritable(spec) : false } as ReportSectionRow;
  });
  return { report: r.rows[0], sections };
}

/** The template a group's report was created from (the general report when none exists yet). */
async function reportTemplate(groupId: string): Promise<ReportTemplate> {
  if (!process.env.POSTGRES_URL) return templateByKey(null);
  const r = await sql`SELECT template_key FROM report WHERE group_id = ${groupId} LIMIT 1`;
  return templateByKey((r.rows[0]?.template_key as string | undefined) ?? null);
}

// ---------------------------------------------------------------------------
// Grounding context
// ---------------------------------------------------------------------------

type ReportContext = {
  extractedContent: string;
  files: string[];
};

async function buildReportContext(groupId: string): Promise<ReportContext> {
  const m = (await fetchGroupMetadata(groupId)) as
    | (Record<string, unknown> & { files?: Array<{ name?: string }>; geminiProcessing?: { extractedContent?: string } })
    | null;
  return {
    extractedContent: m?.geminiProcessing?.extractedContent ?? "",
    files: (m?.files ?? []).map((f) => f.name ?? "").filter(Boolean),
  };
}

function sourcesBlock(ctx: ReportContext): string {
  return `SOURCE FILES: ${ctx.files.length ? ctx.files.join(", ") : "(none)"}

SOURCE TEXT (excerpt):
${ctx.extractedContent.slice(0, MAX_EVIDENCE) || "(no extracted text)"}`;
}

const OUTPUT_RULES =
  "Return Markdown for the section BODY only (no top-level heading, no code fences). Use short paragraphs, bullet lists, and GitHub-style Markdown tables where they help.";

async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("no model configured");
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: { temperature: 0.3, maxOutputTokens: 8192 },
  });
  return (response.text || "").replace(/```(?:markdown)?/gi, "").replace(/```/g, "").trim();
}

// ---------------------------------------------------------------------------
// Model draft for the narrative sections
// ---------------------------------------------------------------------------

async function draftNarrativeSection(template: ReportTemplate, spec: ReportSectionSpec, ctx: ReportContext): Promise<string> {
  const fallback = `_This section is a placeholder. Add the ${spec.heading.toLowerCase()} here._`;
  if (!process.env.GEMINI_API_KEY) return fallback;

  const prompt = `${template.preamble}

You are drafting the "${spec.heading}" section of a ${template.title}.
${spec.guidance}

${OUTPUT_RULES}

${sourcesBlock(ctx)}`;

  try {
    const text = await callGemini(prompt);
    return text.length >= 10 ? text : fallback;
  } catch (error) {
    console.error(`[report] narrative draft failed for ${spec.key}:`, error);
    return fallback;
  }
}

/** The persisted doc for a section: narrative sections are drafted; static ones carry their guidance text. */
async function buildSectionDoc(template: ReportTemplate, spec: ReportSectionSpec, ctx: ReportContext): Promise<PMDoc> {
  if (spec.kind === "narrative") return markdownToTiptap(await draftNarrativeSection(template, spec, ctx));
  return markdownToTiptap(spec.guidance);
}

async function persistDoc(groupId: string, sectionKey: string, doc: PMDoc, auth: Auth): Promise<void> {
  const text = tiptapToText(doc);
  await sql`
    UPDATE report_section
    SET content_json = ${JSON.stringify(doc)}::jsonb, content_text = ${text}, status = 'ready', source = 'ai', updated_by = ${auth.agent}, updated_at = now()
    WHERE group_id = ${groupId} AND section_key = ${sectionKey}
  `;
}

// ---------------------------------------------------------------------------
// Public generation API
// ---------------------------------------------------------------------------

/** Generate (or regenerate) a single section. */
export async function generateSection(groupId: string, sectionKey: string, opts: { auth?: Auth; audit?: AuditSink } = {}): Promise<{ ok: true } | { error: string }> {
  const auth = opts.auth ?? REPORTER;
  const audit = opts.audit ?? defaultAuditSink();
  if (!can(auth, WRITE_PERMISSION)) return { error: `permission denied: requires '${WRITE_PERMISSION}'` };

  const ensured = await ensureReport(groupId, { auth });
  if ("error" in ensured) return ensured;
  const spec = ensured.template.sections.find((s) => s.key === sectionKey);
  if (!spec) return { error: `unknown section '${sectionKey}'` };

  const ctx = await buildReportContext(groupId);
  const doc = await buildSectionDoc(ensured.template, spec, ctx);
  await persistDoc(groupId, sectionKey, doc, auth);
  await audit.write({ agent: auth.agent, action: "generate_report_section", args: { group_id: groupId, section: sectionKey }, result: { ok: true }, allowed: true, groupId });
  return { ok: true };
}

/** Generate all sections concurrently. Skips reviewed sections unless force. */
export async function generateAll(
  groupId: string,
  opts: { auth?: Auth; audit?: AuditSink; force?: boolean; templateKey?: string } = {},
): Promise<{ generated: number } | { error: string }> {
  const auth = opts.auth ?? REPORTER;
  const audit = opts.audit ?? defaultAuditSink();
  if (!can(auth, WRITE_PERMISSION)) return { error: `permission denied: requires '${WRITE_PERMISSION}'` };

  const ensured = await ensureReport(groupId, { auth, templateKey: opts.templateKey });
  if ("error" in ensured) return ensured;

  const existing = await getReport(groupId);
  const reviewed = new Set((existing?.sections ?? []).filter((s) => s.status === "reviewed").map((s) => s.section_key));

  const ctx = await buildReportContext(groupId);
  const template = ensured.template;
  const targets = template.sections.filter((s) => opts.force || !reviewed.has(s.key));

  let generated = 0;
  for (let i = 0; i < targets.length; i += GEN_CONCURRENCY) {
    const batch = targets.slice(i, i + GEN_CONCURRENCY);
    await Promise.all(
      batch.map(async (spec) => {
        try {
          const doc = await buildSectionDoc(template, spec, ctx);
          await persistDoc(groupId, spec.key, doc, auth);
          generated++;
        } catch (error) {
          console.error(`[report] generateAll failed for ${spec.key}:`, error);
        }
      }),
    );
  }

  await audit.write({ agent: auth.agent, action: "generate_report", args: { group_id: groupId, force: !!opts.force, template: template.key }, result: { generated }, allowed: true, groupId });
  return { generated };
}

// ---------------------------------------------------------------------------
// Review state and rewrite presets (model transforms of an existing narrative section)
// ---------------------------------------------------------------------------

/** Mark a section reviewed (or clear it back to editable). Audited. */
export async function setSectionReviewed(
  groupId: string,
  sectionKey: string,
  reviewed: boolean,
  opts: { auth?: Auth; audit?: AuditSink } = {},
): Promise<{ ok: true } | { error: string }> {
  const auth = opts.auth ?? REPORTER;
  const audit = opts.audit ?? defaultAuditSink();
  if (!can(auth, WRITE_PERMISSION)) return { error: `permission denied: requires '${WRITE_PERMISSION}'` };
  if (!process.env.POSTGRES_URL) return { error: "no database configured" };

  const { rowCount } = reviewed
    ? await sql`
        UPDATE report_section
        SET status = 'reviewed', reviewed_by = ${auth.agent}, updated_by = ${auth.agent}, updated_at = now()
        WHERE group_id = ${groupId} AND section_key = ${sectionKey}
      `
    : await sql`
        UPDATE report_section
        SET status = 'ready', reviewed_by = NULL, updated_by = ${auth.agent}, updated_at = now()
        WHERE group_id = ${groupId} AND section_key = ${sectionKey}
      `;
  if (!rowCount) return { error: `unknown section '${sectionKey}'` };
  await audit.write({ agent: auth.agent, action: reviewed ? "mark_report_section_reviewed" : "unmark_report_section_reviewed", args: { group_id: groupId, section: sectionKey }, result: { ok: true }, allowed: true, groupId });
  return { ok: true };
}

/** Rewrite one narrative section with a preset or freeform instruction, grounded in the sources. Audited. */
export async function rewriteSection(
  groupId: string,
  sectionKey: string,
  opts: { preset?: string; instruction?: string; auth?: Auth; audit?: AuditSink } = {},
): Promise<{ ok: true } | { error: string }> {
  const auth = opts.auth ?? REPORTER;
  const audit = opts.audit ?? defaultAuditSink();
  if (!can(auth, WRITE_PERMISSION)) return { error: `permission denied: requires '${WRITE_PERMISSION}'` };
  if (!process.env.POSTGRES_URL) return { error: "no database configured" };

  const template = await reportTemplate(groupId);
  const spec = template.sections.find((s) => s.key === sectionKey);
  if (!spec) return { error: `unknown section '${sectionKey}'` };
  if (!isRewritable(spec)) return { error: "this section can't be rewritten; use Regenerate instead" };

  const preset = opts.preset ? REWRITE_PRESETS[opts.preset] : undefined;
  const instruction = (preset?.instruction ?? opts.instruction ?? "").trim();
  if (!instruction) return { error: "a rewrite preset or instruction is required" };

  const existing = await getReport(groupId);
  const current = existing?.sections.find((s) => s.section_key === sectionKey);
  const currentText = current?.content_text?.trim() ?? "";
  if (!currentText) return { error: "this section has no content to rewrite yet; generate it first" };

  if (!process.env.GEMINI_API_KEY) return { error: "no model configured" };

  const ctx = await buildReportContext(groupId);
  const prompt = `${template.preamble}

You are revising the "${spec.heading}" section of a ${template.title}.

REVISION REQUEST: ${instruction}

Apply the revision to the CURRENT DRAFT below. Do not add facts that are not in the draft or the sources. ${OUTPUT_RULES}

CURRENT DRAFT:
${currentText}

${sourcesBlock(ctx)}`;

  let markdown: string;
  try {
    const text = await callGemini(prompt);
    if (text.length < 10) return { error: "the rewrite came back empty; please try again" };
    markdown = text;
  } catch (error) {
    console.error(`[report] rewrite failed for ${sectionKey}:`, error);
    return { error: "the rewrite request failed; please try again" };
  }

  await persistDoc(groupId, sectionKey, markdownToTiptap(markdown), auth);
  await audit.write({ agent: auth.agent, action: "rewrite_report_section", args: { group_id: groupId, section: sectionKey, preset: opts.preset ?? null, instruction }, result: { ok: true }, allowed: true, groupId });
  return { ok: true };
}

/** Persist a human edit of one section (autosave). Marks it edited. */
export async function updateSection(
  groupId: string,
  sectionKey: string,
  contentJson: PMDoc,
  opts: { auth?: Auth; audit?: AuditSink } = {},
): Promise<{ ok: true } | { error: string }> {
  const auth = opts.auth ?? REPORTER;
  const audit = opts.audit ?? defaultAuditSink();
  if (!can(auth, WRITE_PERMISSION)) return { error: `permission denied: requires '${WRITE_PERMISSION}'` };
  if (!process.env.POSTGRES_URL) return { error: "no database configured" };
  if (!contentJson || contentJson.type !== "doc") return { error: "invalid content" };

  const text = tiptapToText(contentJson);
  const { rowCount } = await sql`
    UPDATE report_section
    SET content_json = ${JSON.stringify(contentJson)}::jsonb, content_text = ${text},
        status = 'editing', source = 'edited', updated_by = ${auth.agent}, updated_at = now()
    WHERE group_id = ${groupId} AND section_key = ${sectionKey}
  `;
  if (!rowCount) return { error: `unknown section '${sectionKey}'` };
  await audit.write({ agent: auth.agent, action: "edit_report_section", args: { group_id: groupId, section: sectionKey }, result: { ok: true }, allowed: true, note: "autosave", groupId });
  return { ok: true };
}
