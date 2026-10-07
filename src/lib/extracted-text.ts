// Whether an extraction actually read anything. Extracted content carries
// markers the code adds itself ("=== Document: name ===", "--- Page N ---"), so
// a reply that came back empty still leaves a non-empty string behind. Checking
// `extractedContent.trim()` let a header-only result pass as a finished case:
// no name, an empty review, and nothing telling anyone the read failed.

/** Fewer characters than this, once the markers are removed, counts as nothing read. */
export const MIN_READABLE_CHARS = 20;

const MARKER = /^\s*(===\s*(Document:.*|Additional documents.*)===|---\s*Page\s+\S+\s*---)\s*$/gim;

/** The extracted text with the app's own document and page markers removed. */
export function readableText(content: string | null | undefined): string {
  return (content ?? "").replace(MARKER, "").trim();
}

export function hasReadableText(content: string | null | undefined): boolean {
  return readableText(content).length >= MIN_READABLE_CHARS;
}

/** Per document: its name and whether its section has readable text. */
export function documentSections(content: string | null | undefined): Array<{ name: string; readable: boolean }> {
  const out: Array<{ name: string; readable: boolean }> = [];
  const re = /^\s*===\s*Document:\s*(.*?)\s*===\s*$/gim;
  const text = content ?? "";
  const heads = [...text.matchAll(re)];
  heads.forEach((m, i) => {
    const body = text.slice(m.index! + m[0].length, heads[i + 1]?.index ?? text.length);
    out.push({ name: m[1], readable: hasReadableText(body) });
  });
  return out;
}

const list = (names: string[]) => names.map((n) => `"${n}"`).join(", ");

const STOP_REASONS: Record<string, string> = {
  MAX_TOKENS: "the AI service ran out of room for its reply",
  SAFETY: "the AI service's safety filter blocked the reply",
  PROHIBITED_CONTENT: "the AI service's content filter blocked the reply",
  RECITATION: "the AI service declined to reproduce the text",
  OTHER: "the AI service stopped without saying why",
};

/** Why the model stopped, in words; undefined for a normal stop. */
export function describeStop(reason?: string): string | undefined {
  if (!reason || reason === "STOP") return undefined;
  return STOP_REASONS[reason] ?? `the AI service stopped with ${reason}`;
}

/** The user-facing message when nothing could be read from `names`; `reason` is the model's finish or block reason. */
export function emptyExtractionMessage(names: string[], reason?: string): string {
  const why = describeStop(reason);
  return (
    `No text could be read from ${names.length ? list(names) : "the uploaded documents"}` +
    (why ? ` (${why})` : "") +
    ". Try uploading the file again. If it fails again, check that it opens, is not password-protected, and is not blank."
  );
}

type Extraction = { extractedContent: string; status: "success" | "error" | "partial"; error?: string; fileCount: number };

/**
 * Downgrade an extraction that read nothing to an error, and one where some
 * documents came back empty to partial, naming them. Applied to every
 * extraction backend's result, so none can report an empty read as a success.
 */
export function checkExtraction<T extends Extraction>(result: T, files: Array<{ name: string }>): T {
  if (result.status === "error") return result;
  if (!hasReadableText(result.extractedContent)) {
    const names = files.map((f) => f.name);
    console.error(`[Extraction] no readable text from ${names.join(", ")} (${result.extractedContent.length} chars incl. markers)`);
    return { ...result, status: "error", fileCount: 0, error: emptyExtractionMessage(names) };
  }
  const empty = documentSections(result.extractedContent).filter((d) => !d.readable).map((d) => d.name);
  if (!empty.length) return result;
  console.warn(`[Extraction] no readable text from ${empty.join(", ")}`);
  const message = emptyExtractionMessage(empty);
  return { ...result, status: "partial", error: result.error ? `${result.error}. ${message}` : message };
}
