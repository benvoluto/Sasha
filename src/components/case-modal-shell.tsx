"use client";

// A very large modal that takes up most of the viewport, used by the intercepting
// route to show a document over the list. Closes (backdrop click / Esc) by navigating
// back, which returns to the list with its scroll + filters preserved.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function CaseModalShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.back();
    };
    document.addEventListener("keydown", onKey);
    // Lock background scroll while the modal is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [router]);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/40 p-4 sm:p-6 md:p-8 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) router.back();
      }}
    >
      {/* Stretches to the viewport height (minus the padding above). The child
          document view is a flex column whose body scrolls internally. */}
      <div className="flex w-full max-w-[min(95vw,1400px)] min-h-0">{children}</div>
    </div>
  );
}
