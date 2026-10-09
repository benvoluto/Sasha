// Rewrite presets for narrative sections. Kept in a client-safe module so both
// the service (server) and the editor UI (client) share one list.
//
// Each preset carries a direction and its opposite. The section tools show one
// chip per quality with a + and a − : "more concise" and "less concise" are both
// things writers actually ask for, and pairing them halves the number of chips
// to read.

export type RewritePreset = {
  label: string;
  /** Short form used on the +/− chips. */
  chipLabel?: string;
  /** The Tools card's chip ("Rewrite as…"); set on the presets in TOOLS_PRESETS. */
  toolsLabel?: string;
  instruction: string;
  /** What "−" means for this quality. Presets without one are + only. */
  lessInstruction?: string;
};

export const REWRITE_PRESETS: Record<string, RewritePreset> = {
  concise: {
    label: "More concise",
    chipLabel: "concise",
    toolsLabel: "More concise",
    instruction: "Tighten this section. Remove redundancy and filler, but keep every fact, figure, and citation intact.",
    lessInstruction: "Expand this section with more detail and interpretation, strictly grounded in the sources provided. Do not invent figures, dates, or facts.",
  },
  plain_language: {
    label: "Plain language",
    chipLabel: "plain language",
    toolsLabel: "Simple language",
    instruction: "Rewrite for a general audience: warm, plain language with jargon defined in context. Preserve all facts and figures accurately.",
    lessInstruction: "Rewrite for a specialist audience: precise technical terminology and standard professional phrasing. Preserve all facts and figures accurately.",
  },
  strengths: {
    label: "Lead with strengths",
    chipLabel: "strengths",
    toolsLabel: "Strength-based",
    instruction: "Reframe to foreground strengths and positives where the sources support it, while retaining all concerns and data. Do not omit findings.",
    lessInstruction: "Reframe to foreground the problems and risks and the evidence for them, while retaining the documented strengths. Do not omit findings.",
  },
  summarize: {
    label: "Summarize",
    chipLabel: "summarize",
    instruction: "Condense this section to a brief 2–4 sentence summary of its key points.",
    lessInstruction: "Restore full detail to this section, covering each finding and its supporting evidence. Do not invent figures, dates, or facts.",
  },
  expand: {
    label: "Add detail",
    chipLabel: "detail",
    toolsLabel: "Add details",
    instruction: "Expand this section with more detail and interpretation, strictly grounded in the sources provided. Do not invent figures, dates, or facts.",
  },
};

export const REWRITE_PRESET_ORDER = ["concise", "plain_language", "strengths", "summarize", "expand"] as const;

/** The presets offered as +/− chips in the section tools panel. */
export const REWRITE_CHIP_ORDER = ["concise", "plain_language", "strengths", "summarize"] as const;

/** The Tools card's "Rewrite as…" chips, in their 2×2 order (always the "more" direction). */
export const TOOLS_PRESETS = ["concise", "plain_language", "strengths", "expand"] as const;
