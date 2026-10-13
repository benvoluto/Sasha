"use client";

// The app frame, rendered once by the root layout around every page
// (redesign3-spec.md §4): the page itself, plus Sasha the dog at the bottom
// left of the overview, a new or open document and Activity. Because it lives
// in the layout, the dog stays put while moving between those pages.

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Dog } from "./dog";
import { showsDog } from "./shell-paths";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <>
      {children}
      {showsDog(pathname) && <Dog />}
    </>
  );
}
