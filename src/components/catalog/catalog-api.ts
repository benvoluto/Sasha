// Client helpers for the /catalog admin page: fetch with the routes' `{error,
// issues}` errors kept (a successful write also invalidates the editor's cached
// type list), and the cleanup applied to a definition edited in the form
// before it is sent.

import type { DocumentTypeDefinition, DocumentTypeInput, Family } from "@/catalog/schema";
import { invalidateDocumentTypes } from "@/components/editor/document-types-store";

export class CatalogApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

export async function catalogApi<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "Content-Type": "application/json" } } : {}),
  });
  const body = await res.json().catch(() => ({}));
  // A write changed the team's catalog: the editor's cached type list is out of date.
  if (res.ok && (rest.method ?? "GET").toUpperCase() !== "GET") invalidateDocumentTypes();
  if (!res.ok) throw new CatalogApiError(body.error ?? `Request failed (${res.status}).`, res.status, Array.isArray(body.issues) ? body.issues : []);
  return body as T;
}

export const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
export const errorIssues = (e: unknown) => (e instanceof CatalogApiError ? e.issues : []);

export const FAMILY_LABELS: Record<Family, string> = {
  grant: "Grants",
  business: "Business",
  academic: "Academic",
  technical: "Technical",
  policy: "Policy",
  clinical: "Clinical",
  career: "Career",
  legal: "Legal",
  general: "General",
  other: "Other",
};

const lines = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);

/** Trim list fields and drop an empty length hint, so form edits (one item per line) validate. */
export function cleanDefinition(d: DocumentTypeDefinition): DocumentTypeInput {
  return {
    ...d,
    signals: lines(d.signals),
    sections: d.sections.map((s) => ({
      ...s,
      lengthHint: s.lengthHint?.trim() ? s.lengthHint.trim() : undefined,
      elements: lines(s.elements),
      sourcesNeeded: lines(s.sourcesNeeded),
      dataNeeded: lines(s.dataNeeded),
    })),
  };
}

/** The "New type" editor's starting point: the smallest definition that validates. */
export function newTypeTemplate(): DocumentTypeInput {
  return {
    key: "my-team-type",
    version: 1,
    title: "My team type",
    family: "general",
    summary: "What this document is and when to use it, in two or three sentences.",
    signals: [],
    audience: "Who reads it.",
    tone: "Plain, neutral, professional.",
    preamble: "You are an experienced writer drafting this document for its readers.",
    aliases: [],
    sections: [
      {
        key: "introduction",
        heading: "Introduction",
        level: 2,
        order: 10,
        required: true,
        guidance: "What this section should say.",
        elements: [],
        sourcesNeeded: [],
        dataNeeded: [],
      },
    ],
    rubric: [],
    provenance: { source: "Team", url: "", license: "Team", retrieved: new Date().toISOString().slice(0, 10) },
  };
}
