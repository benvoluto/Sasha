// The document types offered in the editor's type picker. Phase 3 replaces this
// with the zod-validated catalog (PLAN §5); until then the list is the report
// templates plus a few common outlines.

import { REPORT_TEMPLATES } from "@/lib/ontology/report/template";

export type DocumentTypeOption = {
  key: string;
  title: string;
  sections: Array<{ key: string; heading: string }>;
};

const OUTLINES: DocumentTypeOption[] = [
  {
    key: "proposal",
    title: "Proposal",
    sections: [
      { key: "summary", heading: "Summary" },
      { key: "reason", heading: "Reason for Proposal" },
      { key: "objectives", heading: "Objectives" },
      { key: "approach", heading: "Approach" },
      { key: "timeline", heading: "Timeline" },
      { key: "budget", heading: "Budget" },
      { key: "evaluation", heading: "Evaluation" },
    ],
  },
  {
    key: "memo",
    title: "Memo",
    sections: [
      { key: "purpose", heading: "Purpose" },
      { key: "background", heading: "Background" },
      { key: "options", heading: "Options" },
      { key: "recommendation", heading: "Recommendation" },
    ],
  },
];

export const DOCUMENT_TYPES: DocumentTypeOption[] = [
  ...OUTLINES,
  ...REPORT_TEMPLATES.map((t) => ({
    key: t.key,
    title: t.title,
    sections: [...t.sections].sort((a, b) => a.order - b.order).map((s) => ({ key: s.key, heading: s.heading })),
  })),
];

export function documentTypeByKey(key: string | null | undefined): DocumentTypeOption | null {
  return DOCUMENT_TYPES.find((t) => t.key === key) ?? null;
}
