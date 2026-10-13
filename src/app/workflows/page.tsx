'use client';

// The workflow canvas: build and version workflows, and run them on a
// document. Opened from a document (/workflows?document=<id>), its back button
// returns to that document; otherwise to the overview.

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { WorkflowCanvas } from '@/components/workflow/workflow-canvas';

function WorkflowsHeader() {
  const document = useSearchParams().get('document');
  return document ? <PageHeader title="Workflows" backHref={`/d/${encodeURIComponent(document)}`} backLabel="Back to document" /> : <PageHeader title="Workflows" />;
}

export default function WorkflowsPage() {
  return (
    <div className="min-h-dvh bg-zinc-100 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <Suspense fallback={<PageHeader title="Workflows" />}>
        <WorkflowsHeader />
      </Suspense>
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1600px] px-4 pb-6 outline-none">
        <WorkflowCanvas />
      </main>
    </div>
  );
}
