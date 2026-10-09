import type { Metadata } from "next";
import { UsageDashboard } from "@/components/usage/usage-dashboard";

export const metadata: Metadata = { title: "Usage · Sasha" };

/** /usage — the team's model calls, tokens and estimated cost over a date range. */
export default function UsagePage() {
  return <UsageDashboard />;
}
