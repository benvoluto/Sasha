// How the workflow views name an upload group (a run's subject): by its files.

export type UploadGroupBrief = { id: string; files?: Array<{ name?: string }> };

export const fallbackSourceLabel = (id: string) => `Upload ${id.slice(0, 8)}`;

/** "report.pdf", "report.pdf + 2 more", or "Upload 1a2b3c4d" when it has no named files. */
export function sourceLabel(g: UploadGroupBrief): string {
  const names = (g.files ?? []).map((f) => f.name).filter((n): n is string => !!n);
  if (!names.length) return fallbackSourceLabel(g.id);
  return names.length === 1 ? names[0] : `${names[0]} + ${names.length - 1} more`;
}
