// Report templates: a small, DocumentType-shaped definition of an outline plus
// the drafting instructions for each section. The template is data; the
// generation logic lives in the report service.
//
// Section kinds:
//   - "static"    scaffold text / headings, no model call.
//   - "narrative" model-drafted prose grounded in the uploaded sources.
//
// This is the seed of the document-type catalog (PLAN §4.4); later phases move
// these definitions into zod-validated catalog files.

export type SectionKind = "static" | "narrative";

export type ReportSectionSpec = {
  key: string;
  heading: string;
  order: number;
  kind: SectionKind;
  /** Drafting guidance for the model (narrative) or the scaffold text (static). */
  guidance: string;
};

export type ReportTemplate = {
  key: string;
  title: string;
  /** Who the model is writing as, for whom, and the rules every section follows. */
  preamble: string;
  sections: ReportSectionSpec[];
};

/** Sections a person may rewrite with a model (presets / freeform instruction). */
export const isRewritable = (spec: Pick<ReportSectionSpec, "kind">) => spec.kind === "narrative";

export const GENERAL_REPORT_TEMPLATE_KEY = "general_report";
export const FIE_TEMPLATE_KEY = "fie_basic";

const SHARED_RULES =
  "Ground every statement in the sources provided. Do NOT invent figures, dates, names, or facts; when the sources are silent, say so briefly rather than guessing.";

export const GENERAL_REPORT_TEMPLATE: ReportTemplate = {
  key: GENERAL_REPORT_TEMPLATE_KEY,
  title: "General Report",
  preamble: `You are an experienced writer drafting a clear, well-organized report for a general professional audience. Write in plain, neutral prose with short paragraphs. ${SHARED_RULES}`,
  sections: [
    { key: "introduction", heading: "Introduction", order: 10, kind: "narrative", guidance: "State the purpose and scope of the report and what the reader will find in it." },
    { key: "background", heading: "Background", order: 20, kind: "narrative", guidance: "Summarize the context the reader needs: relevant history, prior work, and the situation the report addresses." },
    { key: "findings", heading: "Findings", order: 30, kind: "narrative", guidance: "Present the main findings from the sources, organized by theme. Use a Markdown table when comparing several figures." },
    { key: "discussion", heading: "Discussion", order: 40, kind: "narrative", guidance: "Interpret the findings: what they mean, how they relate to each other, and their limitations." },
    { key: "recommendations", heading: "Recommendations", order: 50, kind: "narrative", guidance: "Recommended next steps that follow from the findings, framed as recommendations for the reader to consider." },
  ],
};

export const FIE_TEMPLATE: ReportTemplate = {
  key: FIE_TEMPLATE_KEY,
  title: "Full and Individual Evaluation",
  preamble: `You are drafting a section of a Full and Individual Evaluation (FIE) report for a professional team. Write in professional, neutral prose. ${SHARED_RULES} Do not state a final determination; that is the team's decision. When you report several numeric scores, present them in a Markdown table and interpret the pattern in prose around it.`,
  sections: [
    { key: "student_background", heading: "Student Background", order: 10, kind: "narrative", guidance: "Summarize the background: identifying information, history, and relevant context present in the sources. Neutral, factual." },
    { key: "reason_for_referral", heading: "Reason for Referral", order: 20, kind: "narrative", guidance: "State who requested the evaluation and why, the presenting concerns, prior interventions and their outcome, and the questions the evaluation will consider." },
    { key: "assessment_procedures", heading: "Assessment Procedures", order: 30, kind: "narrative", guidance: "List the instruments and procedures used and the records reviewed, as found in the sources." },
    { key: "cognitive_functioning", heading: "Cognitive Functioning", order: 40, kind: "narrative", guidance: "Describe cognitive results grounded in the reported scores; interpret in plain language." },
    { key: "academic_functioning", heading: "Academic Functioning", order: 50, kind: "narrative", guidance: "Describe academic achievement results (reading, writing, math) grounded in the reported scores." },
    { key: "social_emotional_behavioral", heading: "Social, Emotional & Behavioral", order: 60, kind: "narrative", guidance: "Describe social, emotional and behavioral findings (rating scales, observations, interviews) present in the sources." },
    { key: "exclusionary_factors", heading: "Consideration of Exclusionary Factors", order: 70, kind: "narrative", guidance: "Describe the other factors the sources show were considered as possible explanations for the concerns, and what the sources say about each." },
    { key: "eligibility_determination", heading: "Eligibility Determination", order: 80, kind: "narrative", guidance: "Summarize the evidence the team will weigh. Present it as a draft basis for the team's discussion; do not state a conclusion." },
    { key: "recommendations", heading: "Recommendations", order: 90, kind: "narrative", guidance: "Recommended next steps and supports for the team to consider, grounded in the findings. Framed as recommendations, not decisions." },
  ],
};

export const REPORT_TEMPLATES: ReportTemplate[] = [GENERAL_REPORT_TEMPLATE, FIE_TEMPLATE];

/** The template for a key; unknown or missing keys fall back to the general report. */
export function templateByKey(key: string | null | undefined): ReportTemplate {
  return REPORT_TEMPLATES.find((t) => t.key === key) ?? GENERAL_REPORT_TEMPLATE;
}
