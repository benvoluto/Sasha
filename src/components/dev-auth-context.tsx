"use client";

// Whether the server is running with the local-development auth bypass
// (SASHA_DEV_AUTH_BYPASS=1, never in production; see src/lib/dev-auth.ts). The
// root layout reads it on the server and hands it down, so client components
// can skip Clerk's organization hooks and components: with no signed-in user
// (and, in keyless mode, no organizations feature) they open Clerk's
// "Organizations feature required" modal, which makes the page inert.

import { createContext, useContext } from "react";

const DevAuthBypassContext = createContext(false);

export function DevAuthBypassProvider({ value, children }: { value: boolean; children: React.ReactNode }) {
  return <DevAuthBypassContext.Provider value={value}>{children}</DevAuthBypassContext.Provider>;
}

/** True only in a non-production server running with SASHA_DEV_AUTH_BYPASS=1. */
export function useDevAuthBypass(): boolean {
  return useContext(DevAuthBypassContext);
}
