"use client";

// The living outline (PLAN §6.2), the blue Outline card in the editor's right
// column (redesign3-spec.md §15). On top, "Document Type": a "See all" pill
// to the Doc Gallery and a native select of every type by family, with the
// classifier's suggestion under it. Changing the type in an empty editor
// applies the outline at once; with text it asks first, inline (Apply outline,
// Restructure, Just set type, Cancel). Then, with a document type, the type's
// sections in order with a status for each (done, partial, missing), the
// required elements Claude found or didn't, a notes marker, and Add for a
// section the document lacks; headings that aren't part of the type are listed
// under "Other sections". Without a type it is the plain list of headings.
// Presence is read live from the editor; element statuses come from the server
// (use-outline-status.ts). The merging itself is outline-model.ts.

import type { Editor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CaretUpDown, ChevronRight, CircleDashedIcon, CircleHalfIcon, CircleIcon, GalleryIcon, Plus, SectionDoneIcon, SectionNotesIcon } from "@/components/icons";
import { sectionNodes } from "@/catalog/outline";
import type { DocumentTypeSummary } from "@/catalog/schema";
import type { ChipSuggestion } from "@/lib/classifier/contract";
import type { ElementStatus, OutlineStatusResponse } from "@/lib/sections/contract";
import { newSectionId } from "./extensions";
import {
  buildOutline,
  missingSectionInsertPos,
  readHeadings,
  rowDisplayStatus,
  suggestionUseAction,
  typeChangeAction,
  type LiveHeading,
  type OutlineRow,
  type RowDisplayStatus,
} from "./outline-model";
import { OUTLINE_HEADING_ID } from "./right-column-model";
import { PanelHeader } from "./side-panels";
import { findType, groupByFamily } from "./type-picker";

/** The type select's id: the empty-state helper's "document type" focuses it. */
export const OUTLINE_TYPE_SELECT_ID = "outline-type-select";

export function useHeadings(editor: Editor): LiveHeading[] {
  const [items, setItems] = useState<LiveHeading[]>(() => readHeadings(editor.state.doc));
  useEffect(() => {
    const read = () => setItems(readHeadings(editor.state.doc));
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor]);
  return items;
}

/** Move the caret into a heading and bring it into view. */
export function goToHeading(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos);
  editor
    .chain()
    .focus()
    .setTextSelection(pos + 1 + (node?.content.size ?? 0))
    .run();
  const dom = editor.view.nodeDOM(pos);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

/** The sr-only status after each row's title (the icon is aria-hidden). */
const STATUS_TEXT: Record<RowDisplayStatus, string> = { done: "done", partial: "partly done", unknown: "written, not checked yet", missing: "not started" };
const LEGEND: Record<RowDisplayStatus, string> = { done: "Done", partial: "Partly done", unknown: "Not checked yet", missing: "Not started" };

/** The row's status icon, in the card's blue ink. */
function StatusIcon({ status, className = "h-[18px] w-[18px] shrink-0" }: { status: RowDisplayStatus | ElementStatus; className?: string }) {
  if (status === "done") return <SectionDoneIcon className={className} weight="regular" aria-hidden />;
  if (status === "partial") return <CircleHalfIcon className={className} weight="regular" aria-hidden />;
  if (status === "unknown") return <CircleDashedIcon className={className} weight="regular" aria-hidden />;
  return <CircleIcon className={className} weight="regular" aria-hidden />;
}

const ELEMENT_LABEL: Record<ElementStatus, string> = { done: "covered", partial: "partly covered", missing: "missing", unknown: "not checked yet" };

// Shared looks inside the blue card. Rows keep a transparent 2px border so the
// current row's outline doesn't shift the text. The border colour is set once
// per row (rowBorder): two border-colour utilities on one element resolve by
// stylesheet order, not class order, and the transparent one won.
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--outline-ink)]";
const rowClass = "flex min-h-11 items-center gap-3 rounded-full border-2 text-[16px] font-medium hover:bg-[var(--outline-hover)] sm:min-h-10";
/** The current row is the mockup's white pill with a blue outline. */
const rowBorder = (current: boolean) => (current ? "border-[var(--outline-current)] bg-[var(--editor-bg)]" : "border-transparent");
const pill = `inline-flex min-h-11 shrink-0 items-center rounded-full border border-[var(--outline-current)] px-3.5 text-[14px] font-medium hover:bg-[var(--outline-hover)] sm:min-h-8 ${focusRing}`;
const choice = `inline-flex min-h-11 items-center rounded-full border border-[var(--outline-current)] bg-[var(--editor-bg)] px-3 text-[14px] font-medium hover:bg-[var(--outline-hover)] sm:min-h-9 ${focusRing}`;

export type OutlinePanelProps = {
  editor: Editor;
  /** The document's type, when it has one the team can see. */
  type: DocumentTypeSummary | null;
  /** The document's stored type key (it may name a type the team no longer has). */
  typeKey: string | null;
  /** Every type the team can use, for the select. */
  types: DocumentTypeSummary[];
  status: OutlineStatusResponse | null;
  statusError: string | null;
  /** Section notes by sectionId (for the notes marker). */
  notes: Record<string, string>;
  onClose: () => void;
  /** The section the caret is in (useCaretSectionId): its row gets the pill outline and aria-current="location". */
  currentSectionId?: string | null;
  /** Why the document can't change now ("tell me" is drafting it): the select and Add say so and do nothing. */
  locked?: string | null;
  /** "See all": the Doc Gallery dialog. Focus returns to the pill (seeAllRef). */
  onSeeAll: () => void;
  seeAllRef: RefObject<HTMLButtonElement | null>;
  /** Apply a type's outline (document-screen's chooseType: merge into text, or lay it out in an empty editor). */
  onApplyType: (t: DocumentTypeSummary, source: "user" | "classifier") => void;
  /** "No type": freeform. */
  onNoType: () => void;
  /** "Restructure": the restructure workflow, to this type. */
  onRestructure: (key: string) => void;
  /** "Just set type": the type only, no change to the text. */
  onJustSetType: (t: DocumentTypeSummary) => void;
  /** The classifier's suggestion, shown under the select while it differs from the type. */
  suggestion: ChipSuggestion | null;
  onDismissSuggestion: (key: string) => void;
};

export function OutlinePanel({
  editor,
  type,
  typeKey,
  types,
  status,
  statusError,
  notes,
  onClose,
  currentSectionId = null,
  locked = null,
  onSeeAll,
  seeAllRef,
  onApplyType,
  onNoType,
  onRestructure,
  onJustSetType,
  suggestion,
  onDismissSuggestion,
}: OutlinePanelProps) {
  const headings = useHeadings(editor);
  const model = useMemo(
    () => (type ? buildOutline({ sections: type.sections, headings, status, typeKey: type.key, notes }) : null),
    [type, headings, status, notes],
  );
  // When every section is required (most types), one line under the type says
  // so instead of a "Required" tag on every row.
  const someOptional = !!model?.rows.some((r) => !r.required);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const go = (id: string | null, fallbackPos: number | null) => {
    const live = readHeadings(editor.state.doc);
    const h = (id && live.find((x) => x.id === id)) || null;
    const pos = h?.pos ?? fallbackPos;
    if (pos !== null && pos !== undefined) goToHeading(editor, pos);
  };

  const add = (row: OutlineRow) => {
    if (!type || locked) return;
    const spec = type.sections.find((s) => s.key === row.key);
    if (!spec) return;
    const doc = editor.state.doc;
    const at = missingSectionInsertPos(type.sections, row.key, readHeadings(doc), doc.content.size);
    // A document that is one empty paragraph: replace it rather than leave it above the section.
    const blank = doc.childCount === 1 && doc.firstChild?.type.name === "paragraph" && doc.firstChild.content.size === 0;
    const nodes = sectionNodes(spec, newSectionId);
    if (blank) editor.chain().insertContentAt({ from: 0, to: doc.content.size }, nodes).run();
    else editor.chain().insertContentAt(at, nodes).run();
    goToHeading(editor, blank ? 0 : at);
  };

  // --- Document Type ---------------------------------------------------------------
  const currentKey = type?.key ?? typeKey;
  /** A type chosen over a document with text: the inline "Change to <Type>" prompt asks what to do. */
  const [pending, setPending] = useState<{ type: DocumentTypeSummary; source: "user" | "classifier" } | null>(null);
  /** The select was changed while tell me is locked: say why instead. */
  const [lockedNote, setLockedNote] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const families = useMemo(() => groupByFamily(types), [types]);
  // The prompt is for a different type than the one the document now has; once they match, it has done its job.
  const shownPending = pending && pending.type.key !== currentKey ? pending : null;
  useEffect(() => {
    if (!locked) setLockedNote(false);
  }, [locked]);
  useEffect(() => {
    // The prompt opens with focus on its first choice.
    if (pending) requestAnimationFrame(() => promptRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
  }, [pending]);

  /** Focus the select before a choice that unmounts the prompt (the focused button would drop focus to <body>). */
  const settle = () => {
    setPending(null);
    selectRef.current?.focus();
  };

  const onSelect = (value: string) => {
    const action = typeChangeAction({ value, currentKey, editorEmpty: editor.isEmpty, locked: !!locked });
    setLockedNote(action === "locked");
    if (action === "none" || action === "locked") return setPending(null);
    if (action === "no_type") {
      setPending(null);
      return onNoType();
    }
    const t = findType(types, value);
    if (!t) return;
    if (action === "apply") {
      setPending(null);
      return onApplyType(t, "user");
    }
    setPending({ type: t, source: "user" });
  };

  const suggested = suggestion && suggestion.key !== currentKey ? suggestion : null;
  const useSuggestion = () => {
    const t = suggested ? findType(types, suggested.key) : null;
    if (!t) return;
    const action = suggestionUseAction({ typeKey: currentKey, editorEmpty: editor.isEmpty, locked: !!locked });
    setLockedNote(action === "locked");
    if (action === "locked") return;
    if (action === "apply") {
      settle();
      return onApplyType(t, "classifier");
    }
    if (action === "restructure") {
      settle();
      return onRestructure(t.key);
    }
    setPending({ type: t, source: "classifier" });
  };

  const minLevel = Math.min(...headings.map((h) => h.level), 3);
  const typeTop = type?.sections.length ? Math.min(...type.sections.map((s) => s.level)) : minLevel;

  /** A heading row of the untyped view and of "Other sections". */
  const headingRow = (h: LiveHeading, indentFrom: number) => {
    const current = !!currentSectionId && h.id === currentSectionId;
    return (
      <li key={h.id} style={{ paddingLeft: `${Math.max(0, h.level - indentFrom) * 0.9}rem` }}>
        <div className={`${rowClass} px-4 ${rowBorder(current)}`}>
          <button
            type="button"
            onClick={() => go(h.id, h.pos)}
            aria-current={current ? "location" : undefined}
            className={`min-w-0 flex-1 truncate rounded-full py-1.5 text-left ${h.level === indentFrom ? "" : "font-normal"} ${focusRing}`}
          >
            {h.text || "Untitled section"}
          </button>
        </div>
      </li>
    );
  };

  // One line above the rows: every section required, and why element checks are missing.
  const statusLine = model
    ? [
        !someOptional && model.rows.length > 0 ? "Every section is required" : "",
        statusError ?? (status && type && status.typeKey === type.key && !status.model ? "Element checks unavailable" : ""),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const selectValue = shownPending?.type.key ?? currentKey ?? "";
  // A stored key the team no longer has still shows as selected rather than falling back to "No type".
  const orphan = currentKey && !findType(types, currentKey) ? currentKey : null;

  return (
    <aside aria-label="Outline" className="flex flex-col rounded-[22px] border border-[var(--outline-card-line)] bg-[var(--outline-card-bg)] p-6 text-[var(--outline-ink)] shadow-md">
      <PanelHeader title="Outline" variant="outline" onClose={onClose} headingId={OUTLINE_HEADING_ID} />
      <div className="space-y-3 pb-4">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-[18px] font-medium">
            <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 border-current">
              <GalleryIcon className="h-4 w-4" />
            </span>
            Document Type
          </p>
          <button ref={seeAllRef} type="button" onClick={onSeeAll} aria-haspopup="dialog" aria-label="See all document types" className={pill}>
            See all
          </button>
        </div>
        <div className="relative">
          <select
            ref={selectRef}
            id={OUTLINE_TYPE_SELECT_ID}
            aria-label="Document type"
            aria-describedby={lockedNote && locked ? "outline-type-locked" : undefined}
            value={selectValue}
            onChange={(e) => onSelect(e.target.value)}
            className={`block min-h-11 w-full appearance-none rounded-xl border border-[var(--outline-current)] bg-[var(--editor-bg)] pl-3 pr-10 text-[17px] text-[var(--outline-ink)] sm:min-h-11 ${focusRing}`}
          >
            <option value="">No type</option>
            {orphan && <option value={orphan}>Custom type</option>}
            {families.map((f) => (
              <optgroup key={f.family} label={f.label}>
                {f.types.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <CaretUpDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--outline-ink)]" />
        </div>
        {lockedNote && locked && (
          <p id="outline-type-locked" role="status" className="text-sm">
            {locked}
          </p>
        )}
        {shownPending && (
          <div ref={promptRef} role="group" aria-label={`Change to ${shownPending.type.title}`} className="space-y-2 rounded-2xl border border-[var(--outline-card-line)] bg-[var(--outline-hover)] p-3">
            <p className="text-sm">
              Change to <strong className="font-semibold">{shownPending.type.title}</strong>?
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const { type: t, source } = shownPending;
                  settle();
                  onApplyType(t, source);
                }}
                title="Add the type's sections to your document"
                className={choice}
              >
                Apply outline
              </button>
              <button
                type="button"
                onClick={() => {
                  const key = shownPending.type.key;
                  settle();
                  onRestructure(key);
                }}
                title="Map your text onto the type's outline"
                className={choice}
              >
                Restructure
              </button>
              <button
                type="button"
                onClick={() => {
                  const t = shownPending.type;
                  settle();
                  onJustSetType(t);
                }}
                title="Change the type and leave the text as it is"
                className={choice}
              >
                Just set type
              </button>
              <button type="button" onClick={settle} className={choice}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {suggested && !shownPending && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="mr-auto">
              Sasha suggests <strong className="font-semibold">{suggested.title}</strong>
            </span>
            <button type="button" onClick={useSuggestion} title={suggested.why || undefined} className={pill}>
              Use it
            </button>
            <button type="button" onClick={() => onDismissSuggestion(suggested.key)} className={pill}>
              Dismiss
            </button>
          </div>
        )}
      </div>
      {!model ? (
        <div className="-mx-2">
          {headings.length === 0 ? (
            <p className="px-2 text-sm">Headings appear here as you add them. A type gives the document an outline and tracks what each section needs.</p>
          ) : (
            <nav aria-label="Headings">
              <ol className="space-y-1">{headings.map((h) => headingRow(h, minLevel))}</ol>
            </nav>
          )}
        </div>
      ) : (
        <div className="-mx-2">
          {statusLine && <p className="mb-2 px-2 text-xs">{statusLine}</p>}
          <ol className="space-y-1">
            {model.rows.map((row) => {
              const expanded = open.has(row.key);
              const shown = rowDisplayStatus(row);
              const current = !!currentSectionId && row.sectionId === currentSectionId;
              return (
                <li key={row.key} style={{ paddingLeft: `${(row.level - typeTop) * 0.9}rem` }}>
                  <div className={`${rowClass} pl-1 pr-3 ${rowBorder(current)}`}>
                    {row.elements.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => toggle(row.key)}
                        aria-expanded={expanded}
                        aria-label={`Show elements of ${row.heading}`}
                        className={`grid min-h-11 min-w-8 shrink-0 place-items-center rounded-full sm:min-h-8 ${focusRing}`}
                      >
                        <ChevronRight className={`h-4 w-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} aria-hidden />
                      </button>
                    ) : (
                      <span aria-hidden className="w-8 shrink-0" />
                    )}
                    <StatusIcon status={shown} />
                    {row.present ? (
                      <button
                        type="button"
                        onClick={() => go(row.sectionId, row.pos)}
                        aria-current={current ? "location" : undefined}
                        title={row.liveText ? `In the document as “${row.liveText}”` : undefined}
                        className={`min-w-0 flex-1 truncate rounded-full py-1.5 text-left ${row.level === typeTop ? "" : "font-normal"} ${focusRing}`}
                      >
                        {row.heading}
                        <span className="sr-only"> ({STATUS_TEXT[shown]})</span>
                      </button>
                    ) : (
                      <span className={`min-w-0 flex-1 truncate py-1.5 ${row.level === typeTop ? "" : "font-normal"}`}>
                        {row.heading}
                        <span className="sr-only"> (not in the document)</span>
                      </span>
                    )}
                    {row.hasNotes && <SectionNotesIcon className="h-4 w-4 shrink-0" role="img" aria-label="Has notes" />}
                    {row.required && someOptional && row.status !== "done" && (
                      <span className="shrink-0 rounded-full border border-[var(--outline-ink)] px-1.5 text-[11px] font-semibold leading-4">Required</span>
                    )}
                    {!row.present && (
                      <button
                        type="button"
                        onClick={() => add(row)}
                        aria-label={`Add “${row.heading}”`}
                        // aria-disabled, not disabled: a focused button that turns disabled drops focus to <body>.
                        aria-disabled={!!locked || undefined}
                        title={locked ?? undefined}
                        className={`flex min-h-11 shrink-0 items-center rounded-full aria-disabled:cursor-not-allowed aria-disabled:opacity-60 sm:min-h-7 ${focusRing}`}
                      >
                        <span className="flex items-center gap-0.5 rounded-full bg-[var(--outline-hover)] px-2 py-0.5 text-xs font-semibold">
                          <Plus className="h-3 w-3" aria-hidden /> Add
                        </span>
                      </button>
                    )}
                  </div>
                  {expanded && row.elements.length > 0 && (
                    <ul className="mb-1.5 ml-14 mt-1 space-y-1 pr-3">
                      {row.elements.map((e) => (
                        <li key={e.element} className="flex items-start gap-1.5 text-xs">
                          <StatusIcon status={e.status} className="mt-px h-3.5 w-3.5 shrink-0" />
                          <span>
                            {e.element}
                            <span className="sr-only">: {ELEMENT_LABEL[e.status]}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
          {model.other.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider">Other sections</h3>
              <ol className="space-y-1">{model.other.map((h) => headingRow(h, h.level))}</ol>
            </div>
          )}
          <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[11px]">
            {(["done", "partial", "unknown", "missing"] as const).map((s) => (
              <span key={s} className="flex items-center gap-1">
                <StatusIcon status={s} className="h-3.5 w-3.5 shrink-0" /> {LEGEND[s]}
              </span>
            ))}
          </p>
        </div>
      )}
    </aside>
  );
}
