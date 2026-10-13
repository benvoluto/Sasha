// The team's recent activity for the Activity page (redesign3-spec.md §9):
// workflow runs and documents created or edited, merged newest first. Read
// only; every query is scoped to the team. Shapes in ./contract.ts.

import { getDocument, listDocuments, type DocumentSummary } from "@/lib/documents/store";
import { recentRunSummaries } from "@/lib/workflow/store";
import { runHref, type ActivityItem } from "./contract";

/** Most extra document lookups for runs whose document isn't among the recent documents. */
const MAX_RUN_DOC_LOOKUPS = 20;

export type ActivityFeedOptions = {
  limit: number;
  /** False leaves runs out (the caller can't read workflows). */
  includeRuns: boolean;
};

function documentItem(doc: DocumentSummary): ActivityItem {
  const created = doc.created_at === doc.updated_at;
  return {
    kind: "document",
    id: `doc:${doc.id}`,
    document_id: doc.id,
    document_title: doc.title,
    type_key: doc.type_key,
    action: created ? "created" : "edited",
    actor: created ? doc.created_by : doc.updated_by,
    at: doc.updated_at,
    href: `/d/${doc.id}`,
  };
}

export async function activityFeed(teamId: string, { limit, includeRuns }: ActivityFeedOptions): Promise<ActivityItem[]> {
  const [docs, runs] = await Promise.all([listDocuments(teamId, { limit }), includeRuns ? recentRunSummaries(teamId, limit) : Promise.resolve([])]);
  const items: ActivityItem[] = docs.map(documentItem);

  // A run's document title comes from the recent documents; the rest are read
  // one by one (at most MAX_RUN_DOC_LOOKUPS), and a run whose document is gone
  // is left out.
  const titles = new Map<string, string>(docs.map((d) => [d.id, d.title]));
  const missing = [...new Set(runs.map((r) => r.document_id).filter((id) => !titles.has(id)))].slice(0, MAX_RUN_DOC_LOOKUPS);
  const found = await Promise.all(missing.map((id) => getDocument(teamId, id)));
  found.forEach((doc) => {
    if (doc) titles.set(doc.id, doc.title);
  });

  for (const run of runs) {
    const title = titles.get(run.document_id);
    if (title === undefined) continue;
    items.push({
      kind: "run",
      id: `run:${run.id}`,
      run_id: run.id,
      document_id: run.document_id,
      document_title: title,
      workflow_name: run.workflow_name,
      status: run.status,
      actor: run.requested_by,
      at: run.updated_at,
      href: runHref(run.document_id, run.id),
    });
  }

  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
