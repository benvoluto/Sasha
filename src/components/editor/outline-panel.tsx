"use client";

// The living outline (PLAN §6.2), the left-hand panel. With a document type it
// lists the type's sections in order with a status for each (done, partial,
// missing), the required elements Claude found or didn't, a notes marker, and
// Add for a section the document lacks; headings that aren't part of the type
// are listed under "Other sections". Without a type it is the plain list of
// headings. Presence is read live from the editor; element statuses come from
// the server (use-outline-status.ts). The merging itself is outline-model.ts.

import type { Editor } from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, CircleDashedIcon, CircleHalfIcon, CircleIcon, Plus, SectionNotesIcon, TypesIcon } from "@/components/icons";
import { sectionNodes } from "@/catalog/outline";
import type { DocumentTypeSummary } from "@/catalog/schema";
import type { ElementStatus, OutlineStatusResponse } from "@/lib/sections/contract";
import { newSectionId } from "./extensions";
import { buildOutline, missingSectionInsertPos, readHeadings, type LiveHeading, type OutlineRow, type RowStatus } from "./outline-model";
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
  if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: "smooth", block: "start" });
}

const STATUS_LABEL: Record<RowStatus, string> = { done: "Done", partial: "In progress", missing: "Missing" };

function StatusDot({ status }: { status: RowStatus }) {
  return <span aria-hidden="true" className={`outline-dot outline-dot-${status}`} />;
}

const ELEMENT_LABEL: Record<ElementStatus, string> = { done: "covered", partial: "partly covered", missing: "missing", unknown: "not checked yet" };

function ElementIcon({ status }: { status: ElementStatus }) {
  const cls = "mt-0.5 h-3.5 w-3.5 shrink-0";
  if (status === "done") return <CheckCircle2 className={`${cls} text-emerald-600 dark:text-emerald-400`} weight="fill" />;
  if (status === "partial") return <CircleHalfIcon className={`${cls} text-amber-600 dark:text-amber-400`} weight="fill" />;
  if (status === "unknown") return <CircleDashedIcon className={`${cls} text-[var(--doc-muted)]`} />;
  return <CircleIcon className={`${cls} text-[var(--doc-muted)]`} />;
}

export function OutlinePanel({
  editor,
  type,
  status,
  statusError,
  notes,
  onChooseType,
  onClose,
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
}) {
  const headings = useHeadings(editor);
  const model = useMemo(
    () => (type ? buildOutline({ sections: type.sections, headings, status, typeKey: type.key, notes }) : null),
    [type, headings, status, notes],
  );
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
    if (!type) return;
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

  return (
    <aside aria-label="Outline" className="flex h-full flex-col">
      <PanelHeader title="Outline" onClose={onClose} />
      {!model ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          {headings.length === 0 ? (
            <p className="px-2 text-sm text-[var(--doc-muted)]">Headings appear here as you add them.</p>
          ) : (
            <nav>
              <ol className="space-y-0.5">
                {headings.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      onClick={() => go(h.id, h.pos)}
                      style={{ paddingLeft: `${0.5 + (h.level - minLevel) * 0.9}rem` }}
                      className={`w-full truncate rounded-md py-1.5 pr-2 text-left text-sm hover:bg-[var(--doc-accent-soft)] ${h.level === minLevel ? "font-medium" : "text-[var(--doc-muted)]"}`}
                    >
                      {h.text || "Untitled section"}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          <button
            type="button"
            onClick={onChooseType}
            className="mx-2 mt-4 flex items-center gap-1.5 rounded-md border border-[var(--doc-line)] px-2.5 py-1.5 text-sm font-medium text-[var(--doc-accent)] hover:border-[var(--doc-accent)]"
          >
            <TypesIcon className="h-4 w-4" /> Choose a type
          </button>
          <p className="mx-2 mt-2 text-xs text-[var(--doc-muted)]">A type gives the document an outline and tracks what each section needs.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
          <p className="mb-2 px-2 text-xs text-[var(--doc-muted)]">
            {type!.title}
            {statusError ? ` · ${statusError}` : status && status.typeKey === type!.key && !status.model ? " · element checks unavailable" : ""}
          </p>
          <ol className="space-y-0.5">
            {model.rows.map((row) => {
              const expanded = open.has(row.key);
              return (
                <li key={row.key} style={{ paddingLeft: `${(row.level - Math.min(...type!.sections.map((s) => s.level))) * 0.9}rem` }}>
                  <div className="group flex items-center gap-1 rounded-md hover:bg-[var(--doc-accent-soft)]">
                    <button
                      type="button"
                      onClick={() => toggle(row.key)}
                      disabled={row.elements.length === 0}
                      aria-expanded={row.elements.length ? expanded : undefined}
                      aria-label={`${expanded ? "Hide" : "Show"} what “${row.heading}” needs`}
                      className="grid h-7 w-5 shrink-0 place-items-center text-[var(--doc-muted)] disabled:invisible"
                    >
                      {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    </button>
                    <StatusDot status={row.status} />
                    <button
                      type="button"
                      onClick={() => (row.present ? go(row.sectionId, row.pos) : undefined)}
                      disabled={!row.present}
                      title={row.liveText ? `In the document as “${row.liveText}”` : undefined}
                      className={`min-w-0 flex-1 truncate py-1.5 text-left text-sm ${row.present ? "" : "cursor-default text-[var(--doc-muted)]"} ${row.level === minLevel ? "font-medium" : ""}`}
                    >
                      {row.heading}
                      <span className="sr-only">, {STATUS_LABEL[row.status]}</span>
                    </button>
                    {row.hasNotes && <SectionNotesIcon className="h-3.5 w-3.5 shrink-0 text-[var(--doc-accent)]" aria-label="Has notes" />}
                    {row.required && row.status !== "done" && <span className="shrink-0 text-[11px] font-medium text-amber-700 dark:text-amber-400">Required</span>}
                    {!row.present && (
                      <button
                        type="button"
                        onClick={() => add(row)}
                        aria-label={`Add “${row.heading}”`}
                        className="mr-1 flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-semibold text-[var(--doc-accent)] hover:bg-[var(--doc-surface)]"
                      >
                        <Plus className="h-3 w-3" /> Add
                      </button>
                    )}
                  </div>
                  {expanded && row.elements.length > 0 && (
                    <ul className="mb-1.5 ml-7 space-y-1 pr-2">
                      {row.elements.map((e) => (
                        <li key={e.element} className="flex items-start gap-1.5 text-xs">
                          <ElementIcon status={e.status} />
                          <span className={e.status === "done" ? "" : "text-[var(--doc-muted)]"}>
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
              <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-[var(--doc-muted)]">Other sections</h3>
              <ol className="space-y-0.5">
                {model.other.map((h) => (
                  <li key={h.id}>
                    <button type="button" onClick={() => go(h.id, h.pos)} className="w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--doc-accent-soft)]">
                      {h.text || "Untitled section"}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 text-[11px] text-[var(--doc-muted)]">
            {(["done", "partial", "missing"] as const).map((s) => (
              <span key={s} className="flex items-center gap-1">
                <StatusDot status={s} /> {STATUS_LABEL[s]}
              </span>
            ))}
          </p>
        </div>
      )}
    </aside>
  );
}
