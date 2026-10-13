import type { Metadata } from "next";
import { ActivityPage } from "@/components/overview/activity-page";

export const metadata: Metadata = { title: "Activity · Sasha" };

/** /activity — the team's recent workflow runs and document edits (redesign3-spec.md §9). */
export default function Activity() {
  return <ActivityPage />;
}
