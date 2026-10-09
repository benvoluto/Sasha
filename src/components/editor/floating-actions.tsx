"use client";

// The floating buttons at the bottom right of the editing screen: Outline and
// Tools open their cards in the right column. Redesign 2 (redesign2-spec.md
// §4.1): a button hides while its card shows and comes back when the card's X
// closes it; Sources moved to the header. There is no aria-pressed or
// aria-controls: a button is never shown with its card, and the column it
// would point at may not exist yet. Below sm they shrink to icon-only
// squares. While at least one button shows, the bar publishes its height as
// --fab-clearance on <html>, so the notices and the processing tracker (also
// bottom-anchored) sit above it instead of under it, and its measured width as
// --fab-width, so the empty-state helper beside it on the same line stops short
// of it (labelled pills from sm are much wider than the phone squares).

import { useEffect, useRef, type ComponentType, type Ref } from "react";
import { OutlineTreeIcon, SparkleIcon } from "@/components/icons";

type IconType = ComponentType<{ className?: string }>;

/** Bar height (3.5rem) + its bottom offset (1.25rem) + a little air. */
const FAB_CLEARANCE = "5.5rem";

function Pill({ icon: Icon, label, onClick, buttonRef }: { icon: IconType; label: string; onClick: () => void; buttonRef?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      title={label}
      onClick={onClick}
      className="flex h-12 w-12 items-center justify-center gap-2.5 rounded-2xl bg-[var(--go-soft)] text-[19px] font-medium text-[var(--go)] shadow-sm transition-colors hover:bg-[var(--go-soft-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] motion-reduce:transition-none sm:h-14 sm:w-auto sm:px-6"
    >
      <Icon className="h-6 w-6 shrink-0 sm:h-[26px] sm:w-[26px]" />
      <span className="sr-only sm:not-sr-only">{label}</span>
    </button>
  );
}

export function FloatingActions({
  showOutline,
  showTools,
  onOutline,
  onTools,
  outlineRef,
  toolsRef,
}: {
  /** False while the Outline card shows. */
  showOutline: boolean;
  /** False while the Tools slot shows anything (Tools, Section notes or Check). */
  showTools: boolean;
  onOutline: () => void;
  onTools: () => void;
  /** The buttons, so focus can return to them when their card closes. */
  outlineRef?: Ref<HTMLButtonElement>;
  toolsRef?: Ref<HTMLButtonElement>;
}) {
  const any = showOutline || showTools;
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!any) return;
    const root = document.documentElement;
    root.style.setProperty("--fab-clearance", FAB_CLEARANCE);
    const bar = barRef.current;
    const measure = () => {
      if (bar) root.style.setProperty("--fab-width", `${Math.ceil(bar.getBoundingClientRect().width)}px`);
    };
    measure();
    // The labels appear from sm and either button may hide: follow the bar's width.
    const ro = new ResizeObserver(measure);
    if (bar) ro.observe(bar);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--fab-clearance");
      root.style.removeProperty("--fab-width");
    };
  }, [any]);

  if (!any) return null;
  return (
    <div
      ref={barRef}
      role="group"
      aria-label="Document panels"
      className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom,0px))] right-3 z-[19] flex gap-2 sm:right-5 sm:gap-3"
    >
      {showOutline && <Pill buttonRef={outlineRef} icon={OutlineTreeIcon} label="Outline" onClick={onOutline} />}
      {showTools && <Pill buttonRef={toolsRef} icon={SparkleIcon} label="Tools" onClick={onTools} />}
    </div>
  );
}
