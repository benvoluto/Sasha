// Activity (redesign3-spec.md §9): the team's recent activity on the overview's
// Activity page, newest first. Two sources, merged on the server:
//   - workflow runs (src/lib/workflow/store.ts recentRunSummaries), with the
//     document's title joined in;
//   - documents created or edited (listDocuments, sorted by updated_at).
// Read-only, team-scoped (documentRead; runs are left out without
// workflowRead). Client-safe.
//
// CONTRACT (redesign 3 foundation): implemented by the shell-overview track
// (src/app/api/activity/route.ts, src/lib/activity/feed.ts).

import type { RunStatus } from "@/lib/workflow/contract";

/** Most items GET /api/activity returns (default 50). */
export const ACTIVITY_LIMIT_MAX = 100;

export type ActivityItem =
  | {
      kind: "run";
      /** `run:<runId>` (React key). */
      id: string;
      run_id: string;
      document_id: string;
      /** "" when the document is gone or untitled (the UI shows "Untitled"). */
      document_title: string;
      workflow_name: string;
      status: RunStatus;
      /** Who started it. */
      actor: string;
      /** The run's updated_at. */
      at: string;
      /** Where the item opens: /d/<document>?run=<runId> (the modal's Workflows tab on that run). */
      href: string;
    }
  | {
      kind: "document";
      /** `doc:<documentId>`. */
      id: string;
      document_id: string;
      document_title: string;
      type_key: string | null;
      /** "created" when created_at equals updated_at, else "edited". */
      action: "created" | "edited";
      /** updated_by. */
      actor: string;
      at: string;
      href: string;
    };

// --- GET /api/activity?limit= ------------------------------------------------------
export type ActivityResponse = { items: ActivityItem[] };

/** The deep link to one run of a document (document-screen opens the Workflows tab on it). */
export function runHref(documentId: string, runId: string): string {
  return `/d/${documentId}?run=${encodeURIComponent(runId)}`;
}
