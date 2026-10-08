"use client";

// The floating buttons at the bottom right of the editing screen: Outline and
// Tools toggle the panels in the right column, Sources opens the sources
// dialog. Below sm they shrink to icon-only squares. While mounted the bar
// publishes its height as --fab-clearance on <html>, so the notices and the
// processing tracker (also bottom-anchored) sit above it instead of under it.

import { forwardRef, useEffect, type ComponentType, type Ref } from "react";
import { OutlineTreeIcon, SourcesBookIcon, SparkleIcon } from "@/components/icons";

type IconType = ComponentType<{ className?: string }>;

/** Bar height (3.5rem) + its bottom offset (1.25rem) + a little air. */
const FAB_CLEARANCE = "5.5rem";

const Pill = forwardRef<
  HTMLButtonElement,
  { icon: IconType; label: string; pressed?: boolean; onClick: () => void } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick">
>(function Pill({ icon: Icon, label, pressed, onClick, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      {...rest}
      className={`flex h-12 w-12 items-center justify-center gap-2.5 rounded-2xl text-[19px] font-medium text-[var(--go)] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] motion-reduce:transition-none sm:h-14 sm:w-auto sm:px-6 ${
        pressed ? "bg-[var(--go-soft-strong)] shadow-inner" : "bg-[var(--go-soft)] shadow-sm hover:bg-[var(--go-soft-strong)]"
      } ${className ?? ""}`}
    >
      <Icon className="h-6 w-6 shrink-0 sm:h-[26px] sm:w-[26px]" />
      <span className="sr-only sm:not-sr-only">{label}</span>
    </button>
  );
});

export const FloatingActions = forwardRef<
  HTMLButtonElement,
  {
    outlineOpen: boolean;
    toolsOpen: boolean;
    sourcesOpen: boolean;
    onOutline: () => void;
    onTools: () => void;
    onSources: () => void;
    /** The Outline and Tools buttons, so focus can return to them when their panel closes. */
    outlineRef?: Ref<HTMLButtonElement>;
    toolsRef?: Ref<HTMLButtonElement>;
  }
>(function FloatingActions({ outlineOpen, toolsOpen, sourcesOpen, onOutline, onTools, onSources, outlineRef, toolsRef }, sourcesRef) {
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--fab-clearance", FAB_CLEARANCE);
    return () => {
      root.style.removeProperty("--fab-clearance");
    };
  }, []);

  return (
    <div
      role="group"
      aria-label="Document panels"
      className="fixed bottom-[calc(1.25rem+env(safe-area-inset-bottom,0px))] right-3 z-[19] flex gap-2 sm:right-5 sm:gap-3"
    >
      <Pill ref={outlineRef} icon={OutlineTreeIcon} label="Outline" pressed={outlineOpen} onClick={onOutline} />
      <Pill ref={toolsRef} icon={SparkleIcon} label="Tools" pressed={toolsOpen} onClick={onTools} />
      <Pill ref={sourcesRef} icon={SourcesBookIcon} label="Sources" aria-haspopup="dialog" aria-expanded={sourcesOpen} onClick={onSources} />
    </div>
  );
});
