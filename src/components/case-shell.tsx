"use client";

// Shared chrome for the document workspace: the Info / Report mode switcher and the
// Close control. Both modes render it so switching never moves the control the
// user is about to click.

import { BookOpen, CircleX, FolderOpen } from "@/components/icons";

export type CaseMode = "case" | "report";

export function ModeSwitch({
  mode,
  onMode,
  onClose,
  trailing,
}: {
  mode: CaseMode;
  onMode: (m: CaseMode) => void;
  onClose: () => void;
  /** Rendered between the switcher and Close — the document's title in report mode. */
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3">
      <div className="flex items-center gap-1 rounded-full bg-white/70 p-1 dark:bg-zinc-800/70">
        <Tab active={mode === "case"} onClick={() => onMode("case")} tone="case" Icon={FolderOpen} label="Info" />
        <Tab active={mode === "report"} onClick={() => onMode("report")} tone="report" Icon={BookOpen} label="Report" />
      </div>
      {trailing}
      <button
        onClick={onClose}
        className="ml-auto flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[15px] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        <CircleX className="h-5 w-5" />
        Close
      </button>
    </div>
  );
}

function Tab({
  active, onClick, tone, Icon, label,
}: {
  active: boolean;
  onClick: () => void;
  tone: "case" | "report";
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  const color = tone === "case" ? "text-fuchsia-600 dark:text-fuchsia-400" : "text-blue-600 dark:text-blue-400";
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2 rounded-full px-4 py-2 text-[15px] font-medium transition-colors ${
        active ? `bg-white shadow-sm dark:bg-zinc-900 ${color}` : `${color} opacity-60 hover:opacity-100`
      }`}
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}
