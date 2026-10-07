import { Suspense } from "react";
import { CaseModalShell } from "@/components/case-modal-shell";
import { CaseDetailView } from "@/components/case-detail-view";

// Intercepting route: when the document list soft-navigates to /cases/[groupId], show
// the detail as a large modal over the list. A hard load of the same URL bypasses
// this and renders the full page instead.
export default async function CaseModalPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  return (
    <CaseModalShell>
      <Suspense fallback={<div className="rounded-3xl bg-white dark:bg-zinc-950 p-6 text-sm text-zinc-500">Loading document…</div>}>
        <CaseDetailView groupId={groupId} variant="modal" />
      </Suspense>
    </CaseModalShell>
  );
}
