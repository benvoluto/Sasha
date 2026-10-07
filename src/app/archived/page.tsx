'use client';

import { CaseNav } from '@/components/case-nav';
import { ArchivedList } from '@/components/archived-list';

export default function ArchivedPage() {
  return (
    <div className="min-h-screen bg-zinc-100 font-sans dark:bg-zinc-950">
      <CaseNav />
      <main className="container mx-auto max-w-7xl space-y-6 px-4 py-6">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Archived</h1>
        <ArchivedList />
      </main>
      <footer className="mt-16 py-8" />
    </div>
  );
}
