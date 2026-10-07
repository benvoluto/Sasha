'use client';

import { CaseNav } from '@/components/case-nav';
import { WorkflowCanvas } from '@/components/workflow/workflow-canvas';

export default function WorkflowsPage() {
  return (
    <div className="min-h-screen bg-zinc-100 font-sans dark:bg-zinc-950">
      <CaseNav />
      <main className="mx-auto max-w-[1600px] px-4 py-6">
        <WorkflowCanvas />
      </main>
    </div>
  );
}
