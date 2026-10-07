"use client";

// The document overview: one card per section, and the drill-in frame they
// open into. A card can summarize its section on the overview itself, so the
// document tells you where to go before you click.

import type { ComponentType, ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "@/components/icons";

export type SectionKey = "documents" | "suggestions";

export type SectionTone = "documents" | "suggestions";

const TONE: Record<SectionTone, { card: string; stroke: string; badge: string; title: string; icon: string; chevron: string }> = {
  documents: {
    card: "bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800/70",
    stroke: "border-slate-200 dark:border-slate-700",
    badge: "bg-slate-500 text-white",
    title: "text-slate-800 dark:text-slate-100",
    icon: "text-slate-600 dark:text-slate-300",
    chevron: "text-slate-400",
  },
  suggestions: {
    card: "bg-fuchsia-50/80 dark:bg-fuchsia-950/30 hover:bg-fuchsia-50 dark:hover:bg-fuchsia-950/50",
    stroke: "border-fuchsia-200 dark:border-fuchsia-900",
    badge: "bg-fuchsia-600 text-white",
    title: "text-fuchsia-700 dark:text-fuchsia-300",
    icon: "text-fuchsia-600 dark:text-fuchsia-400",
    chevron: "text-fuchsia-500",
  },
};

/** One overview card. Clicking anywhere on it opens that section. */
export function SectionCard({
  tone, badge, title, Icon, onOpen, children, footer,
}: {
  tone: SectionTone;
  badge: string;
  title: string;
  Icon: ComponentType<{ className?: string }>;
  onOpen: () => void;
  /** The at-a-glance lines shown next to the title. */
  children?: ReactNode;
  /** Full-width content under the header. */
  footer?: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <section className={`rounded-2xl border transition-colors ${t.card} ${t.stroke}`}>
      <button onClick={onOpen} className="flex w-full items-start gap-5 px-6 py-5 text-left">
        <span className={`mt-1 shrink-0 rounded-full px-3 py-1 text-sm font-semibold tabular-nums ${t.badge}`}>{badge}</span>
        <Icon className={`mt-0.5 h-8 w-8 shrink-0 ${t.icon}`} />
        <h2 className={`w-40 shrink-0 text-2xl font-semibold leading-tight ${t.title}`}>{title}</h2>
        <div className="min-w-0 flex-1 text-[15px] leading-relaxed text-zinc-700 dark:text-zinc-300">{children}</div>
        <ChevronRight className={`mt-1 h-7 w-7 shrink-0 ${t.chevron}`} />
      </button>
      {footer ? <div className="px-6 pb-5">{footer}</div> : null}
    </section>
  );
}

/** The drill-in frame: Back, the same badge/icon/title, then the section body. */
export function SectionPanel({
  tone, badge, title, Icon, onBack, children,
}: {
  tone: SectionTone;
  badge?: string;
  title: string;
  Icon: ComponentType<{ className?: string }>;
  onBack: () => void;
  children: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-4 px-6 pb-4 pt-5 sm:px-8">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-[17px] font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
        >
          <ChevronLeft className="h-5 w-5" />
          Back
        </button>
        {badge ? <span className={`rounded-full px-3 py-1 text-sm font-semibold tabular-nums ${t.badge}`}>{badge}</span> : null}
        <Icon className={`h-7 w-7 ${t.icon}`} />
        <h2 className={`text-2xl font-semibold ${t.title}`}>{title}</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 sm:px-8">{children}</div>
    </div>
  );
}
