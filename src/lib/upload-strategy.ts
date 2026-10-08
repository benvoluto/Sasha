// What can be uploaded as a source, and how. Files always go straight from the
// browser to Vercel Blob (presign, then `upload()` through /api/upload/direct,
// then /api/upload/complete), which sidesteps the 4.5MB request-body limit on
// Vercel functions. There is no server-side multipart path any more.
//
// Imported by client components, so keep this free of Node-only imports.

export type UploadStrategy = 'direct';

/** Kept for callers that still ask; every environment uploads directly. */
export function getClientUploadStrategy(): UploadStrategy {
  return 'direct';
}

/** The file types a source can be, by extension, with the canonical MIME type stored for each. */
export const SOURCE_FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Read as text directly, without Gemini. */
export const TEXT_MIME_TYPES = ['text/plain', 'text/markdown', 'text/csv'];

const ALLOWED_MIMES = new Set(Object.values(SOURCE_FILE_TYPES));
// Browsers report some types inconsistently (an .md file is often "" and a .csv
// on Windows is "application/vnd.ms-excel"); for those the extension decides.
const VAGUE_MIMES = new Set(['', 'application/octet-stream', 'application/vnd.ms-excel', 'text/x-markdown']);

/**
 * The canonical MIME type for an uploaded file, or null when the type isn't
 * allowed. A specific type from the browser must agree with the extension; a
 * vague one defers to the extension.
 */
export function resolveUploadType(name: string, type: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const byExt = SOURCE_FILE_TYPES[ext] ?? null;
  const t = (type || '').toLowerCase().split(';')[0].trim();
  if (VAGUE_MIMES.has(t)) return byExt;
  if (!ALLOWED_MIMES.has(t)) return null;
  if (!byExt || byExt === t) return t;
  // Some browsers call any text file text/plain.
  if (t === 'text/plain' && TEXT_MIME_TYPES.includes(byExt)) return byExt;
  return null;
}

export interface DirectUploadConfig {
  maxFileSize: number;
  maxFiles: number;
  allowedTypes: string[];
  /** The accept list for a file input or dropzone. */
  accept: Record<string, string[]>;
}

export const DIRECT_UPLOAD_CONFIG: DirectUploadConfig = {
  maxFileSize: 50 * 1024 * 1024, // 50MB per file
  maxFiles: 20,
  allowedTypes: [...ALLOWED_MIMES],
  accept: Object.entries(SOURCE_FILE_TYPES).reduce<Record<string, string[]>>((acc, [ext, mime]) => {
    (acc[mime] ??= []).push(`.${ext}`);
    return acc;
  }, {}),
};
