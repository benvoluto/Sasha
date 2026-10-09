"use client";

// The writing tools panel, and the PanelHeader every side panel shares. Tools
// and Section notes (section-notes-panel.tsx) share the lower half of the
// editor's right column, under the outline (outline-panel.tsx); see
// right-column.tsx. The Sources panel is the body of the Sources dialog.

import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { Loader2, SparkleIcon, X } from "@/components/icons";
import type { CitationReport } from "@/lib/citations/contract";
import { markCitations } from "@/lib/citations/marks";
import { markdownToTiptap } from "@/lib/report/markdown-to-tiptap";
import { stripCitationMarkers } from "@/lib/sections/content";
import { textWithMarkers } from "./citation-layer-model";
import { REWRITE_PRESET_ORDER, REWRITE_PRESETS } from "@/lib/report/rewrite-presets";
import { trackRange } from "./tracked-range";
import { droppedNotice } from "./use-section-generation";

export function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-5 pb-2 pt-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--doc-muted)]">{title}</h2>
      <button type="button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} className="grid h-8 w-8 place-items-center rounded-md text-[var(--doc-muted)] hover:bg-[var(--action-soft)] hover:text-[var(--action)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)]">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

type Selection = { from: number; to: number; text: string };

function useSelectionText(editor: Editor): Selection | null {
  const [sel, setSel] = useState<Selection | null>(null);
  useEffect(() => {
    const read = () => {
      const { from, to, empty } = editor.state.selection;
      setSel(empty ? null : { from, to, text: editor.state.doc.textBetween(from, to, "\n\n").trim() });
    };
    read();
    editor.on("selectionUpdate", read);
    editor.on("update", read);
    return () => {
      editor.off("selectionUpdate", read);
      editor.off("update", read);
    };
  }, [editor]);
  return sel && sel.text ? sel : null;
}

export function ToolsPanel({
  editor,
  documentId,
  ensureSaved,
  onClose,
  onCheckDocument,
}: {
  editor: Editor;
  documentId: string | null;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  onClose: () => void;
  /** Check the whole document against its rubric (opens the Check panel in this slot). */
  onCheckDocument: () => void;
}) {
  const selection = useSelectionText(editor);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const words = editor.state.doc.textContent.trim().match(/\S+/g)?.length ?? 0;

  const rewrite = async (body: { preset?: string; direction?: "more" | "less"; instruction?: string }, label: string) => {
    if (!selection) return;
    const target = selection;
    // The call can take a while and the person may keep writing: follow the
    // selection through their edits so the result replaces the right text.
    const tracked = trackRange(editor, target);
    // Citations in the selection go as [[p:ID]] markers, so the rewrite keeps them.
    const sent = textWithMarkers(editor.state.doc, target.from, target.to).trim() || target.text;
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      const id = documentId || (await ensureSaved());
      if (!id) throw new Error("Save the document first.");
      await fetch(`/api/documents/${id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: `Before rewrite: ${label}` }),
      });
      const res = await fetch(`/api/documents/${id}/rewrite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sent, ...body }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? "The rewrite failed.");
      const range = tracked.current();
      if (!range) throw new Error("The selected text changed while the rewrite was running, so it wasn't applied. Select it again to retry.");
      // Verified markers become citation marks; a server without a report gets its markers stripped.
      const citations = (out.citations ?? null) as CitationReport | null;
      const markdown = String(out.markdown ?? "");
      const parsed = markdownToTiptap(citations ? markdown : stripCitationMarkers(markdown));
      const blocks = citations ? markCitations(parsed.content, citations) : parsed.content;
      // One paragraph back for an inline selection: insert its text, not a new block.
      const single = blocks.length === 1 && blocks[0].type === "paragraph";
      const content = single ? (blocks[0].content ?? []) : blocks;
      editor.chain().focus().insertContentAt(range, content).run();
      setInstruction("");
      setNote(droppedNotice(citations) || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The rewrite failed.");
    } finally {
      tracked.stop();
      setBusy(null);
    }
  };

  return (
    <aside aria-label="Tools" className="flex h-full flex-col">
      <PanelHeader title="Tools" onClose={onClose} />
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-6">
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <SparkleIcon className="h-4 w-4 text-[var(--doc-accent)]" /> Rewrite selection
          </h3>
          {!selection ? (
            <p className="text-sm text-[var(--doc-muted)]">Select text in the document to rewrite it.</p>
          ) : (
            <p className="line-clamp-3 rounded-md bg-[var(--doc-accent-soft)] px-2.5 py-2 text-xs text-[var(--doc-ink)]">{selection.text}</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {REWRITE_PRESET_ORDER.map((key) => {
              const p = REWRITE_PRESETS[key];
              return (
                <button
                  key={key}
                  type="button"
                  disabled={!selection || !!busy}
                  onClick={() => rewrite({ preset: key, direction: "more" }, p.label)}
                  className="rounded-full border border-[var(--doc-line)] px-2.5 py-1 text-xs hover:border-[var(--doc-accent)] hover:text-[var(--doc-accent)] disabled:opacity-40"
                >
                  {busy === p.label ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} {p.label}
                </button>
              );
            })}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (instruction.trim()) void rewrite({ instruction }, "Custom");
            }}
            className="space-y-2"
          >
            <label htmlFor="rewrite-instruction" className="sr-only">
              Rewrite instruction
            </label>
            <textarea
              id="rewrite-instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              placeholder="Or describe the change, e.g. “make this more formal”"
              className="w-full resize-y rounded-md border border-[var(--doc-line)] bg-transparent px-2.5 py-2 text-sm outline-none focus:border-[var(--doc-accent)]"
            />
            <button
              type="submit"
              disabled={!selection || !instruction.trim() || !!busy}
              className="flex items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--doc-on-accent)] disabled:opacity-40"
            >
              {busy === "Custom" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Rewrite
            </button>
          </form>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          {note && (
            <p role="status" className="text-sm text-[var(--doc-muted)]">
              {note}
            </p>
          )}
          <p className="text-xs text-[var(--doc-muted)]">A snapshot is saved before each rewrite, and Undo reverses it.</p>
        </section>
        <section className="space-y-2 border-t border-[var(--doc-line)] pt-4">
          <h3 className="text-sm font-semibold">Check against rubric</h3>
          <p className="text-sm text-[var(--doc-muted)]">Score the document on its type&apos;s rubric, with evidence and a fix for each criterion.</p>
          <button
            type="button"
            onClick={onCheckDocument}
            disabled={words === 0}
            className="rounded-md border border-[var(--doc-line)] px-3 py-1.5 text-sm font-semibold hover:border-[var(--doc-accent)] hover:text-[var(--doc-accent)] disabled:opacity-40"
          >
            Check document
          </button>
        </section>
        <section className="border-t border-[var(--doc-line)] pt-4 text-sm text-[var(--doc-muted)]">
          <span className="tabular-nums">{words.toLocaleString()}</span> words
        </section>
      </div>
    </aside>
  );
}
