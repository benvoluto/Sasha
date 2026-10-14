import { Suspense } from "react";
import { Overview } from "@/components/overview/overview";

// The documents overview (redesign3-spec.md §2): the team's documents, folders
// and notes. It reads its tab and view from the address (useSearchParams), so
// it renders inside Suspense. A new blank document is /new.
export default function Home() {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-[var(--page-bg)]" />}>
      <Overview />
    </Suspense>
  );
}
