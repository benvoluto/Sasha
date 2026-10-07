import { Suspense } from "react";
import { CaseDetailView } from "@/components/case-detail-view";

// Full-page document detail — used on direct navigation / refresh / bookmark. In-app
// navigation from the list is intercepted and shown as a modal (app/@modal).
export default async function Page({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  return (
    <div className="min-h-screen bg-zinc-100 dark:bg-zinc-950 py-8">
      <div className="mx-auto max-w-[1400px] px-4">
        <Suspense fallback={<p className="text-sm text-zinc-500">Loading document…</p>}>
          <CaseDetailView groupId={groupId} variant="page" />
        </Suspense>
      </div>
    </div>
  );
}
