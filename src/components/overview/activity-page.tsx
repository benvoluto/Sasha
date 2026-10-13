"use client";

// The Activity page (redesign3-spec.md §9): the team's recent workflow runs and
// document edits, newest first, with runs waiting on someone ("Needs you") at
// the top. Each row opens its document, a run row on that run
// (/d/<id>?run=<runId>, the document modal's Workflows tab).

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2, RunWorkflowIcon } from "@/components/icons";
import { findType, useDocumentTypes } from "@/components/editor/type-picker";
import { statusTone, type StatusTone } from "@/components/editor/workflows-pane-model";
import { PageHeader } from "@/components/shell/page-header";
import { TypeIcon } from "@/components/type-icon";
import type { DocumentTypeSummary } from "@/catalog/schema";
import type { ActivityItem, ActivityResponse } from "@/lib/activity/contract";
import { FOCUS_RING } from "./inline-edit";
import { activitySentence, isWaiting, splitActivity, timeAgo } from "./activity-model";
import { errorMessage } from "./overview-model";

const TONE: Record<StatusTone, string> = {
  busy: "bg-[var(--action-soft)] text-[var(--action)]",
  ok: "bg-[var(--sources-bg)] text-[var(--sources-ink)]",
  wait: "bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200",
  bad: "bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-300",
  quiet: "bg-[var(--page-bg)] text-[var(--card-sub)]",
};

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; items: ActivityItem[] };

function ActivityRow({ item, now, types }: { item: ActivityItem; now: number; types: DocumentTypeSummary[] }) {
  const type = item.kind === "document" ? findType(types, item.type_key) : null;
  const tone = item.kind === "run" ? statusTone(item.status) : null;
  return (
    <li>
      <Link href={item.href} className={`flex min-h-11 items-center gap-3 rounded-2xl border border-[var(--card-line)] bg-[var(--card-bg)] px-4 py-3 hover:border-[var(--card-sub)] ${FOCUS_RING}`}>
        {item.kind === "run" ? <RunWorkflowIcon className="h-6 w-6 shrink-0 text-[var(--action)]" aria-hidden /> : <TypeIcon icon={type?.icon} color={type?.color} className="h-6 w-6" />}
        <span className="min-w-0 flex-1 break-words text-[15px] text-[var(--card-title)] sm:text-[16px]">{activitySentence(item)}</span>
        {item.kind === "run" && tone && !isWaiting(item.status) && (
          <span aria-hidden className={`hidden shrink-0 rounded-full px-2 py-0.5 text-[12px] font-semibold sm:inline-flex ${TONE[tone]}`}>
            {tone === "ok" ? "Done" : tone === "bad" ? "Failed" : tone === "busy" ? "Running" : "Ended"}
          </span>
        )}
        {item.kind === "run" && isWaiting(item.status) && <span aria-hidden className={`hidden shrink-0 rounded-full px-2 py-0.5 text-[12px] font-semibold sm:inline-flex ${TONE.wait}`}>Needs you</span>}
        <time dateTime={item.at} className="shrink-0 text-[13px] text-[var(--card-sub)]">
          {timeAgo(item.at, now)}
        </time>
      </Link>
    </li>
  );
}

function Group({ id, title, items, now, types }: { id: string; title: string; items: ActivityItem[]; now: number; types: DocumentTypeSummary[] }) {
  return (
    <section aria-labelledby={id} className="mt-8 first:mt-0">
      <h2 id={id} className="mb-3 text-[18px] font-semibold text-[var(--card-title)]">
        {title}
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map((i) => (
          <ActivityRow key={i.id} item={i} now={now} types={types} />
        ))}
      </ul>
    </section>
  );
}

export function ActivityPage() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [now, setNow] = useState(0);
  const { types } = useDocumentTypes();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/activity", { cache: "no-store" });
        const body = (await res.json().catch(() => ({}))) as Partial<ActivityResponse> & { error?: string };
        if (!res.ok) throw new Error(body.error ?? "Couldn't load activity.");
        if (!cancelled) {
          setNow(Date.now());
          setLoad({ state: "ready", items: body.items ?? [] });
        }
      } catch (e) {
        if (!cancelled) setLoad({ state: "error", message: errorMessage(e, "Couldn't load activity.") });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep "5 min ago" honest while the page stays open.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const groups = load.state === "ready" ? splitActivity(load.items) : null;

  return (
    <div className="min-h-dvh bg-[var(--page-bg)] text-[var(--card-title)]">
      <PageHeader title="Activity" />
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-3xl px-4 pb-32 outline-none sm:px-8">
        {load.state === "loading" && (
          <p role="status" className="flex items-center gap-2 text-[15px] text-[var(--card-sub)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
          </p>
        )}
        {load.state === "error" && (
          <p role="alert" className="text-[15px] text-red-700 dark:text-red-400">
            {load.message}
          </p>
        )}
        {groups && groups.needsYou.length === 0 && groups.rest.length === 0 && <p className="text-[16px] text-[var(--card-sub)]">Nothing yet.</p>}
        {groups && groups.needsYou.length > 0 && <Group id="activity-needs-you" title="Needs you" items={groups.needsYou} now={now} types={types} />}
        {groups && groups.rest.length > 0 && <Group id="activity-recent" title="Recent" items={groups.rest} now={now} types={types} />}
      </main>
    </div>
  );
}
