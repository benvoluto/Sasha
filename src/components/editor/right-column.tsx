"use client";

// The editor's right column (redesign3-spec.md §13): a stack at the top right
// of the editor card, role="group" "Document panels". First the Sources pill
// (it opens the document modal on Sources), then Agents, then Outline: each a
// button while closed and its card in the same place while open. Section notes
// and Check take the Agents place. Where it sits depends on the room
// (right-column-model.ts rightColumnMode):
// - inline: in the body row beside the text, sticky under the toolbar, the
//   Sources pill fixed at its top and the cards below it scrolling on their
//   own when they are taller than the window;
// - drawer: the buttons stay at the top right and open cards overlay the text
//   from the right, over a scrim;
// - sheet (phones): a compact fixed row of the three buttons at the bottom
//   right, clear of Sasha, and open cards in a full-width bottom sheet.
// The drawer and sheet are modal: focus is trapped inside, and Esc or the
// scrim closes them (the editing screen then focuses the button in place).

import { type ComponentType, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { CustomRequestIcon, OutlineTreeIcon, SourcesBookIcon } from "@/components/icons";
import { AGENTS_SLOT_ID, OUTLINE_SLOT_ID, type ColumnSlot, type RightColumnMode } from "./right-column-model";

type IconType = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

type Look = "sources" | "agents" | "outline";

const LOOK: Record<Look, string> = {
  sources: "bg-[var(--sources-bg)] text-[var(--sources-ink)] focus-visible:outline-[var(--sources-ink)]",
  agents: "bg-[var(--tools-bg)] text-[var(--tools-ink)] hover:bg-[var(--tools-chip)] focus-visible:outline-[var(--tools-ring)]",
  outline: "border border-[var(--outline-card-line)] bg-[var(--outline-card-bg)] text-[var(--outline-ink)] hover:bg-[var(--outline-hover)] focus-visible:outline-[var(--outline-ink)]",
};

function StackButton({
  look,
  icon: Icon,
  label,
  onClick,
  buttonRef,
  compact,
  expanded,
  controls,
  dialog = false,
}: {
  look: Look;
  icon: IconType;
  label: string;
  onClick: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  /** The phone row: smaller labels so all three fit beside Sasha. */
  compact: boolean;
  expanded: boolean;
  /** The open card's slot (only while expanded: a closed panel has nothing to point at). */
  controls?: string;
  /** Sources opens a dialog; Agents and Outline disclose a card. */
  dialog?: boolean;
}) {
  const size = compact
    ? "min-h-11 gap-1 rounded-xl px-2.5 text-[14px] shadow-md"
    : "min-h-11 gap-2 rounded-2xl px-4 text-[18px] sm:min-h-12";
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-haspopup={dialog ? "dialog" : undefined}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      className={`inline-flex shrink-0 items-center font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 motion-reduce:transition-none ${size} ${LOOK[look]}`}
    >
      <Icon className={compact ? "h-[18px] w-[18px] shrink-0" : "h-6 w-6 shrink-0"} aria-hidden />
      {label}
    </button>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab inside `el` (the drawer or sheet), wrapping at either end. Every
 * Tab is placed by hand: focus often rests on a card's heading (tabIndex -1),
 * where the browser's own Shift+Tab could leave the dialog.
 */
function trapTab(e: KeyboardEvent<HTMLElement>, el: HTMLElement) {
  const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
  e.preventDefault();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const at = active instanceof HTMLElement ? items.indexOf(active) : -1;
  let next: HTMLElement;
  if (at >= 0) next = items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length];
  else if (!(active instanceof HTMLElement) || !el.contains(active)) next = e.shiftKey ? last : first;
  else if (e.shiftKey) next = [...items].reverse().find((x) => active.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_PRECEDING) ?? last;
  else next = items.find((x) => active.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) ?? first;
  next.focus();
}

export type RightColumnProps = {
  mode: RightColumnMode;
  /** Agents, Section notes or Check (the Agents place), or null while closed. */
  lower: ReactNode | null;
  /** The Outline card, or null while closed. */
  outline: ReactNode | null;
  onOpen: (slot: ColumnSlot) => void;
  /** Esc or the scrim in the drawer or sheet: close everything. */
  onDismiss: () => void;
  onSources: () => void;
  /** The document modal is open (the Sources pill's aria-expanded). */
  sourcesOpen: boolean;
  /** The buttons, so focus can return to them when a card closes (and the modal to Sources). */
  sourcesRef: RefObject<HTMLButtonElement | null>;
  agentsRef: RefObject<HTMLButtonElement | null>;
  outlineRef: RefObject<HTMLButtonElement | null>;
};

export function RightColumn({ mode, lower, outline, onOpen, onDismiss, onSources, sourcesOpen, sourcesRef, agentsRef, outlineRef }: RightColumnProps) {
  const compact = mode === "sheet";
  const inline = mode === "inline";
  const lowerSlot = lower ? (
    <div id={AGENTS_SLOT_ID} className="min-w-0">
      {lower}
    </div>
  ) : null;
  const outlineSlot = outline ? (
    <div id={OUTLINE_SLOT_ID} className="min-w-0">
      {outline}
    </div>
  ) : null;

  const sources = <StackButton look="sources" icon={SourcesBookIcon} label="Sources" onClick={onSources} buttonRef={sourcesRef} compact={compact} expanded={sourcesOpen} dialog />;
  const agentsButton = (
    <StackButton look="agents" icon={CustomRequestIcon} label="Agents" onClick={() => onOpen("lower")} buttonRef={agentsRef} compact={compact} expanded={!!lower} controls={AGENTS_SLOT_ID} />
  );
  const outlineButton = (
    <StackButton look="outline" icon={OutlineTreeIcon} label="Outline" onClick={() => onOpen("outline")} buttonRef={outlineRef} compact={compact} expanded={!!outline} controls={OUTLINE_SLOT_ID} />
  );

  if (inline) {
    return (
      <div
        role="group"
        aria-label="Document panels"
        className="sticky top-[var(--toolbar-h,0px)] flex max-h-[calc(100dvh-var(--column-top,var(--toolbar-h,0px)))] w-[min(410px,32vw)] shrink-0 flex-col items-end gap-2 self-start pb-6 pt-4 pl-5 pr-5 lg:pr-10"
      >
        {/* Sources stays in view; only the cards below it scroll. */}
        {sources}
        <div className="-mx-2 flex min-h-0 w-[calc(100%+1rem)] flex-col items-end gap-4 overflow-y-auto overscroll-contain px-2 py-2 [&>div]:w-full">
          {lowerSlot ?? agentsButton}
          {outlineSlot ?? outlineButton}
        </div>
      </div>
    );
  }

  const open = !!lower || !!outline;
  const onOverlayKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Keys from portalled menus and dialogs bubble here through React; leave those to them.
    if (!e.currentTarget.contains(target) || target.closest('[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]')) return;
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      onDismiss();
    } else if (e.key === "Tab") trapTab(e, e.currentTarget);
  };

  return (
    <>
      <div
        role="group"
        aria-label="Document panels"
        className={
          compact
            ? "fixed bottom-[calc(0.75rem+env(safe-area-inset-bottom,0px))] right-3 z-[20] flex gap-1.5"
            : "sticky top-[var(--toolbar-h,0px)] flex shrink-0 flex-col items-end gap-3 self-start px-5 pt-4"
        }
      >
        {sources}
        {agentsButton}
        {outlineButton}
      </div>
      {open && (
        <>
          {/* The scrim closes the cards; it is decorative for assistive tech (Esc and each card's × do the same). */}
          <div aria-hidden className="fixed inset-0 z-[42] bg-[var(--scrim)]" onClick={onDismiss} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={lower && outline ? "Panels" : outline ? "Outline panel" : "Agents panel"}
            onKeyDown={onOverlayKeyDown}
            className={
              compact
                ? "fixed inset-x-0 bottom-0 z-[45] flex max-h-[85dvh] flex-col gap-3 overflow-y-auto overscroll-contain rounded-t-[24px] bg-[var(--editor-bg)] px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] pt-2 text-[var(--doc-ink)] shadow-[0_-6px_20px_rgb(0_0_0/0.18)]"
                : "fixed bottom-0 right-0 top-[var(--column-top,var(--toolbar-h,0px))] z-[45] flex w-[min(410px,90vw)] flex-col gap-3 overflow-y-auto overscroll-contain p-3 text-[var(--doc-ink)]"
            }
          >
            {compact && <div aria-hidden className="mx-auto mb-1 h-1.5 w-10 shrink-0 rounded-full bg-[var(--doc-line)]" />}
            {lowerSlot}
            {outlineSlot}
          </div>
        </>
      )}
    </>
  );
}
