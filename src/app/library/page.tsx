"use client";

import { Suspense } from "react";
import { Loader2 } from "@/components/icons";
import { SourceLibrary } from "@/components/sources/source-library";

export default function Library() {
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
