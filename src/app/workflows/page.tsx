'use client';

// The workflow canvas, inside the app frame (rail and documents panel): build
// and version workflows, and run them on a document.

import { WorkflowCanvas } from '@/components/workflow/workflow-canvas';

export default function WorkflowsPage() {
  return (
    <div className="min-h-dvh bg-zinc-100 font-sans dark:bg-zinc-950">
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-[1600px] px-4 py-6 outline-none">
        <WorkflowCanvas />
      </main>
    </div>
  );
}
