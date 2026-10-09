"use client";

// The living outline (PLAN §6.2), the cream Outline card in the editor's right
// column (redesign2-spec.md §4.4). With a document type it
// lists the type's sections in order with a status for each (done, partial,
// missing), the required elements Claude found or didn't, a notes marker, and
// Add for a section the document lacks; headings that aren't part of the type
// are listed under "Other sections". Without a type it is the plain list of
// headings. Presence is read live from the editor; element statuses come from
// the server (use-outline-status.ts). The merging itself is outline-model.ts.

import type { Editor } from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronRight, CircleDashedIcon, CircleHalfIcon, CircleIcon, Plus, SectionNotesIcon, TypesIcon } from "@/components/icons";
import { sectionNodes } from "@/catalog/outline";
import type { DocumentTypeSummary } from "@/catalog/schema";
import type { ElementStatus, OutlineStatusResponse } from "@/lib/sections/contract";
import { newSectionId } from "./extensions";
import { buildOutline, missingSectionInsertPos, readHeadings, rowDisplayStatus, type LiveHeading, type OutlineRow, type RowDisplayStatus } from "./outline-model";
import { PanelHeader } from "./side-panels";

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

/** The row's status icon, in the card's olive ink (redesign2-spec.md §4.4). */
function StatusIcon({ status, className = "h-[18px] w-[18px] shrink-0" }: { status: RowDisplayStatus | ElementStatus; className?: string }) {
  if (status === "done") return <CheckCircle2 className={className} weight="regular" aria-hidden />;
  if (status === "partial") return <CircleHalfIcon className={className} weight="regular" aria-hidden />;
  if (status === "unknown") return <CircleDashedIcon className={className} weight="regular" aria-hidden />;
  return <CircleIcon className={className} weight="regular" aria-hidden />;
}

const ELEMENT_LABEL: Record<ElementStatus, string> = { done: "covered", partial: "partly covered", missing: "missing", unknown: "not checked yet" };

// Shared looks inside the cream card.
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--outline-ink)]";
const rowClass = "flex min-h-11 items-center gap-3 rounded-full text-[16px] font-medium hover:bg-[var(--outline-hover)] sm:min-h-10";
const currentClass = "ring-[1.5px] ring-inset ring-[var(--outline-current)]";

export function OutlinePanel({
  editor,
  type,
  status,
  statusError,
  notes,
  onChooseType,
  onClose,
  currentSectionId = null,
  locked = null,
}: {
  editor: Editor;
  /** The document's type, when it has one the team can see. */
  type: DocumentTypeSummary | null;
  status: OutlineStatusResponse | null;
  statusError: string | null;
  /** Section notes by sectionId (for the notes marker). */
  notes: Record<string, string>;
  onChooseType: () => void;
  onClose: () => void;
  /** The section the caret is in (useCaretSectionId): its row gets the olive pill outline and aria-current="location". */
  currentSectionId?: string | null;
  /** Why the document can't change now ("tell me" is drafting it): Add says so and does nothing. */
  locked?: string | null;
}) {
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

  const minLevel = Math.min(...headings.map((h) => h.level), 3);
  const typeTop = type?.sections.length ? Math.min(...type.sections.map((s) => s.level)) : minLevel;

  /** A heading row of the untyped view and of "Other sections". */
  const headingRow = (h: LiveHeading, indentFrom: number) => {
    const current = !!currentSectionId && h.id === currentSectionId;
    return (
      <li key={h.id} style={{ paddingLeft: `${Math.max(0, h.level - indentFrom) * 0.9}rem` }}>
        <div className={`${rowClass} px-4 ${current ? currentClass : ""}`}>
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

  return (
    <aside aria-label="Outline" className="flex h-full flex-col rounded-[20px] border border-[var(--outline-card-line)] bg-[var(--outline-card-bg)] text-[var(--outline-ink)] shadow-md">
      <PanelHeader title="Outline" variant="outline" onClose={onClose} />
      {!model ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {headings.length === 0 ? (
            <p className="px-4 text-sm">Headings appear here as you add them.</p>
          ) : (
            <nav aria-label="Headings">
              <ol className="space-y-1">{headings.map((h) => headingRow(h, minLevel))}</ol>
            </nav>
          )}
          <button
            type="button"
            onClick={onChooseType}
            className={`mx-3 mt-4 flex min-h-11 items-center gap-2 rounded-full border border-[var(--outline-ink)] px-4 text-[15px] font-medium hover:bg-[var(--outline-hover)] sm:min-h-9 ${focusRing}`}
          >
            <TypesIcon className="h-[18px] w-[18px]" aria-hidden /> Choose a type
          </button>
          <p className="mx-3 mt-2 text-xs">A type gives the document an outline and tracks what each section needs.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <p className="mb-2 px-4 text-xs">
            {type!.title}
            {!someOptional && model.rows.length > 0 ? " · every section is required" : ""}
            {statusError ? ` · ${statusError}` : status && status.typeKey === type!.key && !status.model ? " · element checks unavailable" : ""}
          </p>
          <ol className="space-y-1">
            {model.rows.map((row) => {
              const expanded = open.has(row.key);
              const shown = rowDisplayStatus(row);
              const current = !!currentSectionId && row.sectionId === currentSectionId;
              return (
                <li key={row.key} style={{ paddingLeft: `${(row.level - typeTop) * 0.9}rem` }}>
                  <div className={`${rowClass} pl-1 pr-3 ${current ? currentClass : ""}`}>
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
              <h3 className="mb-1 px-4 text-xs font-semibold uppercase tracking-wider">Other sections</h3>
              <ol className="space-y-1">{model.other.map((h) => headingRow(h, h.level))}</ol>
            </div>
          )}
          <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 text-[11px]">
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
