// A minimal valid definition for tests (not bundled; not imported by app code).

import type { DocumentTypeInput } from "./schema";

export function minimalType(over: Partial<DocumentTypeInput> = {}): DocumentTypeInput {
  return {
    key: "team-brief",
    version: 1,
    title: "Team brief",
    family: "business",
    summary: "A short brief.",
    audience: "Colleagues.",
    tone: "Plain.",
    preamble: "You write briefs.",
    sections: [
      { key: "context", heading: "Context", order: 20, guidance: "Say why." },
      { key: "ask", heading: "Ask", order: 10, guidance: "Say what." },
    ],
    provenance: { source: "Test", url: "", license: "Team", retrieved: "2026-10-07" },
    ...over,
  };
}
