"use client";

// The editor's Document Gallery (redesign2-spec.md §3.2): every type the team
// can use, with the document's own state on top — its current type, "No type
// (freeform)", "Save outline as type…" and the classifier's suggestion
// (ClassifierSuggestion). Opened from the header button, the empty-state
// helper's "document type", the outline card's "Choose a type", and the tell-me
// flow when it couldn't pick a type. The grid is TypeGallery's.

import { useRef, type RefObject } from "react";
import type { DocumentTypeSummary } from "@/catalog/schema";
import type { ChipSuggestion } from "@/lib/classifier/contract";
import { ClassifierSuggestion } from "./classifier-chip";
import { TypeGallery } from "./type-picker";

const smallButton =
  "inline-flex min-h-11 items-center rounded-lg border border-[var(--doc-field-line)] px-3 text-sm font-medium hover:bg-[var(--go-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] sm:min-h-8";

export function DocumentGalleryDialog({
  open,
  onOpenChange,
  types,
  loading,
  error,
  typeKey,
  current,
  onChoose,
  onFreeform,
  onSaveOutline,
  suggestion,
  applyLabel,
  onApplySuggestion,
  onRestructure,
  onDismissSuggestion,
  returnFocusRef,
  onFocusDocument,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  types: DocumentTypeSummary[];
  loading?: boolean;
  error?: string | null;
  /** The document's stored type key (it may name a type the team no longer has). */
  typeKey: string | null;
  /** The type that key names, when the team has it. */
  current: DocumentTypeSummary | null;
  /** A card was chosen. Resolves to an error message to show, or nothing (the caller closes the dialog). */
  onChoose: (t: DocumentTypeSummary) => Promise<string | void> | string | void;
  /** "No type (freeform)": the dialog closes first, then focus goes to the document. */
  onFreeform: () => void;
  /** "Save outline as type…": the dialog closes and SaveOutlineDialog opens. */
  onSaveOutline: () => void;
  suggestion: ChipSuggestion | null;
  /** "Apply outline" on an untyped document, "Restructure?" on a typed one. */
  applyLabel: string;
  /** The suggestion's Apply (or an alternative): the dialog closes first. */
  onApplySuggestion: (key: string) => void;
  /** "Restructure…": the dialog closes first, then the Workflows tab opens. */
  onRestructure: (key: string) => void;
  onDismissSuggestion: (key: string) => void;
  /** The header's Document Gallery button: focus goes there when the opener is gone. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** After a close that changed the type (a card, Apply, No type): focus the document instead of the opener. */
  onFocusDocument?: () => void;
}) {
  // Set when another dialog takes over from this one (Save outline, the Workflows tab): it handles focus, not us.
  const handoff = useRef(false);
  const handOver = (next: () => void) => {
    handoff.current = true;
    onOpenChange(false);
    next();
  };
  // Set when the close follows a type change: the person writes next, so focus goes to the document.
  const chosen = useRef(false);
  const closeChosen = (next: () => void) => {
    chosen.current = true;
    onOpenChange(false);
    next();
  };
  const currentTitle = current?.title ?? (typeKey ? "Custom type" : null);

  const top = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-sm">
          {currentTitle ? (
            <>
              Current type: <strong className="font-semibold">{currentTitle}</strong>
            </>
          ) : (
            "No type yet: freeform"
          )}
        </p>
        {typeKey && (
          <button
            type="button"
            onClick={() => closeChosen(onFreeform)}
            className={smallButton}
          >
            No type (freeform)
          </button>
        )}
        <button type="button" onClick={() => handOver(onSaveOutline)} className={smallButton}>
          Save outline as type…
        </button>
      </div>
      {suggestion && (
        <ClassifierSuggestion
          suggestion={suggestion}
          applyLabel={applyLabel}
          onApply={(key) => closeChosen(() => onApplySuggestion(key))}
          onRestructure={(key) => handOver(() => onRestructure(key))}
          onDismiss={onDismissSuggestion}
        />
      )}
    </div>
  );

  return (
    <TypeGallery
      open={open}
      onOpenChange={onOpenChange}
      types={types}
      loading={loading}
      error={error}
      current={current?.key ?? null}
      title="Document Gallery"
      description="Each type gives the document an outline and tells Sasha how to write each section."
      top={top}
      returnFocusRef={returnFocusRef}
      onCloseAutoFocus={(e) => {
        if (chosen.current) {
          chosen.current = false;
          e.preventDefault();
          // The focus trap has let go by now (this runs as the dialog unmounts).
          onFocusDocument?.();
          return;
        }
        if (!handoff.current) return;
        handoff.current = false;
        e.preventDefault();
      }}
      onChoose={async (t) => {
        // Set before the caller closes the dialog; cleared again if the choice failed and it stays open.
        chosen.current = true;
        try {
          const err = await onChoose(t);
          if (err) chosen.current = false;
          return err;
        } catch (e) {
          chosen.current = false;
          throw e;
        }
      }}
    />
  );
}
