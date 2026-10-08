"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Loader2 } from "@/components/icons";
import { SourceLibrary } from "@/components/sources/source-library";
import { takeCaseToOpen } from "@/lib/open-case";

export default function Library() {
  const router = useRouter();
  // "Open" on the workflow canvas still hands over a legacy upload group: it
  // leaves the id for this tab and comes here. Send it on to the case route
  // until workflows read sources (Phase 6).
  useEffect(() => {
    const id = takeCaseToOpen();
    if (id) router.push(`/cases/${encodeURIComponent(id)}`, { scroll: false });
  }, [router]);
  return (
    <Suspense
      fallback={
        <div className="doc-screen flex min-h-screen items-center justify-center gap-2 bg-[var(--doc-bg)] text-[var(--doc-muted)]">
          <Loader2 className="h-5 w-5 animate-spin" /> Opening the library…
        </div>
      }
    >
      <SourceLibrary />
    </Suspense>
  );
}
