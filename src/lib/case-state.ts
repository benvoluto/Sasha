// The single source of truth for "what state is this document's upload in",
// derived from the extraction record. Use this everywhere a status is shown so
// the list card and the detail header always agree.

import type { UploadGroup } from "@/lib/atoms";

export type CaseStateKey = "uploading" | "extracting" | "ready" | "error";

export type CaseState = {
  key: CaseStateKey;
  label: string;
  className: string;
  detail?: string;
};

const STALL_AFTER_MS = 7 * 60 * 1000;

export const STATE_LABEL: Record<CaseStateKey, string> = {
  uploading: "Uploading",
  extracting: "Extracting",
  ready: "Ready",
  error: "Needs attention",
};

export const STATE_STYLE: Record<CaseStateKey, string> = {
  uploading: "bg-slate-50 text-slate-700 dark:bg-slate-900/20 dark:text-slate-300",
  extracting: "bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300",
  ready: "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300",
  error: "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300",
};

function make(key: CaseStateKey, detail?: string): CaseState {
  return { key, label: STATE_LABEL[key], className: STATE_STYLE[key], detail };
}

/** Derive the one state an upload group is in. Precedence: error → extracting → ready; no record yet is uploading. */
export function deriveCaseState(group: Pick<UploadGroup, "geminiProcessing" | "uploadDate">): CaseState {
  const g = group.geminiProcessing;
  if (!g) return make("uploading", "Uploading files");
  if (g.status === "error") return make("error", g.error || "Processing failed");
  if (g.status === "partial") return make("error", "Some files were not fully read");
  if (g.status === "processing") {
    const ageMs = Date.now() - new Date(g.processedAt || group.uploadDate).getTime();
    if (ageMs > STALL_AFTER_MS) return make("error", "Processing appears to have stalled");
    return make("extracting", "Extracting text from the files");
  }
  return make("ready");
}

/** A document's display title until documents have their own: the first uploaded file's name, without its extension. */
export function documentTitle(group: Pick<UploadGroup, "files"> | null | undefined): string | undefined {
  const first = group?.files?.find((f) => f.name)?.name;
  return first ? first.replace(/\.[^.]+$/, "") : undefined;
}
