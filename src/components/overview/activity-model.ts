// Pure logic behind the Activity page (activity-page.tsx, redesign3-spec.md
// §9): which runs wait on someone, each row's sentence, and the relative time.
// Tested directly (activity-model.test.ts).

import { runStatusText } from "@/components/editor/workflows-pane-model";
import type { ActivityItem } from "@/lib/activity/contract";
import type { RunStatus } from "@/lib/workflow/contract";

/** A run waiting on a person: listed under "Needs you". */
export function isWaiting(status: RunStatus): boolean {
  return status === "awaiting_review" || status === "paused";
}

/** The "Needs you" group (waiting runs) and everything else, each still newest first. */
export function splitActivity(items: readonly ActivityItem[]): { needsYou: ActivityItem[]; rest: ActivityItem[] } {
  const needsYou = items.filter((i) => i.kind === "run" && isWaiting(i.status));
  return { needsYou, rest: items.filter((i) => !needsYou.includes(i)) };
}

const docName = (title: string) => `“${title.trim() || "Untitled"}”`;

/**
 * The row's sentence: `<workflow> on “<doc>”: <status>` for a run (a waiting
 * run reads "Waiting for review"), `<actor> created/edited “<doc>”` for a document.
 */
export function activitySentence(item: ActivityItem): string {
  if (item.kind === "run") return `${item.workflow_name} on ${docName(item.document_title)}: ${isWaiting(item.status) ? "Waiting for review" : runStatusText(item.status)}`;
  return `${item.actor} ${item.action} ${docName(item.document_title)}`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date ("Mar 4", with the year when it isn't this one). */
export function timeAgo(at: string, now: number): string {
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86_400);
  if (days < 7) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}
