"use client";

// The header of the pages off the overview (redesign3-spec.md §1, §9): a round
// back button (to the overview, or to the document the page was opened from),
// the page's h1 and the account menu. Used by Activity, the library, the
// catalog, usage and the workflow canvas.

import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeft } from "@/components/icons";
import { UserMenu } from "./user-menu";

export function BackButton({ href = "/", label = "Back to documents" }: { href?: string; label?: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--back-bg)] text-[var(--action)] hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)] dark:hover:brightness-125 sm:h-12 sm:w-12"
    >
      <ChevronLeft className="h-5 w-5" aria-hidden />
    </Link>
  );
}

export function PageHeader({ title, backHref, backLabel, children }: { title: string; backHref?: string; backLabel?: string; /** Extra controls before the account menu. */ children?: ReactNode }) {
  return (
    <header className="flex items-center gap-3 px-4 pb-6 pt-4 sm:gap-4 sm:px-10 sm:pt-8">
      <BackButton href={backHref} label={backLabel} />
      <h1 className="min-w-0 flex-1 truncate text-[22px] font-semibold tracking-tight sm:text-[26px]">{title}</h1>
      {children}
      <UserMenu />
    </header>
  );
}
