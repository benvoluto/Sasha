'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAtomValue } from 'jotai';
import { CaseNav } from "@/components/case-nav";
import { FileDropzone } from "@/components/file-dropzone";
import { UploadGroupsList } from "@/components/upload-groups-list";
import { uploadGroupsAtom } from '@/lib/atoms';
import { takeCaseToOpen } from '@/lib/open-case';

export default function Home() {
  const groups = useAtomValue(uploadGroupsAtom);
  const router = useRouter();
  // "Open" elsewhere (the workflow canvas) asks for the list with that document
  // open in the modal. It leaves the id for this tab and comes here; opening
  // it with a soft navigation from the list is what the modal route intercepts.
  useEffect(() => {
    const id = takeCaseToOpen();
    if (id) router.push(`/cases/${encodeURIComponent(id)}`, { scroll: false });
  }, [router]);
  return (
    <div className="font-sans min-h-screen bg-zinc-100 dark:bg-zinc-950">
      <CaseNav counts={{ cases: groups.length }} />
      <main className="container mx-auto max-w-7xl px-4 py-6 space-y-5">
        <div id="create-case" className="scroll-mt-20">
          <FileDropzone />
        </div>
        <UploadGroupsList />
      </main>
      <footer className="mt-16 py-8" />
    </div>
  );
}
