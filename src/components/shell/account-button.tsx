"use client";

// Clerk's account menu, rendered only after hydration (see useHydrated): with
// clerk-js cached, a reload could render its host <div> before hydration and
// fail it. The slot keeps its size, so nothing moves when the button appears.

import { UserButton } from "@clerk/nextjs";
import type { ComponentProps } from "react";
import { useHydrated } from "@/hooks/use-hydrated";

export function AccountButton(props: ComponentProps<typeof UserButton>) {
  return useHydrated() ? <UserButton {...props} /> : null;
}
