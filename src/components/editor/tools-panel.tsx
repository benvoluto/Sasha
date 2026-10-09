"use client";

// The Tools card (redesign2-spec.md §4.2–4.3), the olive card in the upper slot
// of the editor's right column. "Rewrite as…" acts on the selection, else the
// caret's section, else the caret's paragraph (tools-panel-model.ts
// rewriteTarget). A selection or paragraph goes through /rewrite here and
// lands as one transaction; a section goes through useSectionGeneration's run,
// which snapshots, shows the gutter busy state and makes one undo step. Below
// that: draft the caret's section, check the document, open Section notes.

import type { Editor, JSONContent } from "@tiptap/react";
import { useEffect, useReducer, useState } from "react";
import { AlertCircle, CustomRequestIcon, ListChecks, Loader2, Pencil, SectionNotesIcon, SparkleIcon } from "@/components/icons";
import type { DocumentTypeSummary } from "@/catalog/schema";
import type { CitationReport } from "@/lib/citations/contract";
import { markCitations } from "@/lib/citations/marks";
import { markdownToTiptap } from "@/lib/report/markdown-to-tiptap";
import { REWRITE_PRESETS, TOOLS_PRESETS } from "@/lib/report/rewrite-presets";
import { stripCitationMarkers } from "@/lib/sections/content";
import { textWithMarkers } from "./citation-layer-model";
import { PanelHeader } from "./side-panels";
import { draftRow, rewriteInsertion, rewriteTarget, rewriteTargetLine, wordCount, type RewriteTarget } from "./tools-panel-model";
import { trackRange } from "./tracked-range";
import { droppedNotice, type GenerationRequest } from "./use-section-generation";

const CUSTOM_MAX = 2000;

/** Re-renders on every selection change and edit, so the target line and rows follow the caret. */
function useEditorTick(editor: Editor) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    editor.on("selectionUpdate", tick);
    editor.on("update", tick);
    return () => {
      editor.off("selectionUpdate", tick);
      editor.off("update", tick);
    };
  }, [editor]);
}

/** ToolsPanel's props (redesign2-spec.md §4.2); document-screen passes all of them. */
export type ToolsPanelProps = {
  editor: Editor;
  documentId: string | null;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  /** The document's type, for the Draft row (a static section can't be drafted). */
  type: DocumentTypeSummary | null;
  /** The section the caret is in (useCaretSectionId): the target of Rewrite with no selection, Draft and Section notes. */
  caretSectionId: string | null;
  /** useSectionGeneration's run and busy set: section rewrite and draft go through them (snapshot, one undo, gutter busy state). */
  run: (req: GenerationRequest) => Promise<string | null>;
  busy: ReadonlySet<string>;
  /** Why nothing here may change the document now ("tell me" is drafting it), or null. */
  locked?: string | null;
  onClose: () => void;
  /** Check the whole document against its rubric (opens the Check panel in this slot). */
  onCheckDocument: () => void;
  /** Open Section notes for the caret's section (takes this slot; its X brings the Tools button back). */
  onSectionNotes: () => void;
};

// Shared looks inside the olive card. Disabled controls keep their text at
// full contrast on the card (a dashed outline instead of a fill) and say why.
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tools-focus)]";
const filled =
  "bg-[var(--tools-chip)] hover:bg-[var(--tools-chip-hover)] aria-disabled:cursor-not-allowed aria-disabled:border aria-disabled:border-dashed aria-disabled:border-[var(--tools-ink)] aria-disabled:bg-transparent";

type Busy = { key: string; sectionId: string | null } | null;

export function ToolsPanel({ editor, documentId, ensureSaved, type, caretSectionId, run, busy: generating, locked = null, onClose, onCheckDocument, onSectionNotes }: ToolsPanelProps) {
  useEditorTick(editor);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const target = rewriteTarget(editor.state, caretSectionId);
  const row = draftRow(editor.state.doc, type?.sections, caretSectionId, generating);
  const draft = locked && !row.disabledReason ? { ...row, disabledReason: "Sasha is drafting…" } : row;
  const words = wordCount(editor.state.doc);
  const sectionRunning = target.kind === "section" && generating.has(target.sectionId);
  const blocked = target.kind === "none" || !!busy || sectionRunning || !!locked;
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  /** The selection path (unchanged from before redesign 2): a range of the document through /rewrite. */
  const rewriteRange = async (range: { from: number; to: number; text: string }, body: { preset?: string; direction?: "more"; instruction?: string }, label: string) => {
    // The call can take a while and the person may keep writing: follow the
    // range through their edits so the result replaces the right text.
    const tracked = trackRange(editor, range);
    // Citations in the range go as [[p:ID]] markers, so the rewrite keeps them.
    const sent = textWithMarkers(editor.state.doc, range.from, range.to).trim() || range.text;
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
      const now = tracked.current();
      if (!now) throw new Error("The text changed while the rewrite was running, so it wasn't applied. Select it again to retry.");
      // Verified markers become citation marks; a server without a report gets its markers stripped.
      const citations = (out.citations ?? null) as CitationReport | null;
      const markdown = String(out.markdown ?? "");
      const parsed = markdownToTiptap(citations ? markdown : stripCitationMarkers(markdown));
      const blocks = citations ? markCitations(parsed.content, citations) : parsed.content;
      const { from, to, content } = rewriteInsertion(editor.state.doc, now, blocks);
      editor.chain().focus().insertContentAt({ from, to }, content as JSONContent[]).run();
      setNote(droppedNotice(citations) || null);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "The rewrite failed.");
      return false;
    } finally {
      tracked.stop();
    }
  };

  /** Runs a preset (key) or the custom request on the current target. True when it went through. */
  const rewrite = async (to: RewriteTarget, body: { preset?: string; instruction?: string }, key: string, label: string) => {
    if (to.kind === "none" || busy || locked) return false;
    setBusy({ key, sectionId: to.kind === "section" ? to.sectionId : null });
    setError(null);
    setNote(null);
    try {
      if (to.kind === "section") {
        // run reports its own failures (a notice); it returns the message, or null when it applied.
        const failed = await run(
          body.instruction ? { sectionId: to.sectionId, mode: "rewrite", instruction: body.instruction } : { sectionId: to.sectionId, mode: "rewrite", preset: body.preset, direction: "more" },
        );
        return failed === null;
      }
      return await rewriteRange(to, body.instruction ? { instruction: body.instruction } : { preset: body.preset, direction: "more" }, label);
    } finally {
      setBusy(null);
    }
  };

  const submitCustom = async () => {
    const text = instruction.trim();
    if (!text || blocked) return;
    if (await rewrite(target, { instruction: text }, "custom", "Custom request")) setInstruction("");
  };

  const reasonFor = (reason: string | null) => (reason ? <span className="ml-auto pl-2 text-right text-[13px] font-normal">{reason}</span> : null);
  const checkReason = words === 0 ? "Nothing to check yet" : null;
  const notesReason = caretSectionId ? null : "Put the cursor in a section";

  return (
    <aside aria-label="Tools" className="flex h-full flex-col rounded-[20px] bg-[var(--tools-bg)] text-[var(--tools-ink)] shadow-md">
      <PanelHeader title="Tools" variant="tools" onClose={onClose} />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        <section aria-labelledby="tools-rewrite-as" className="space-y-2.5">
          <div className="space-y-1 px-1">
            <h3 id="tools-rewrite-as" className="flex items-center gap-2 text-[18px] font-medium">
              <Pencil className="h-5 w-5 shrink-0" aria-hidden /> Rewrite as…
            </h3>
            <p id="tools-target" className="text-sm">
              {locked ?? (sectionRunning && target.kind === "section" ? `Claude is writing “${target.heading.trim() || "Untitled section"}”…` : rewriteTargetLine(target))}
            </p>
          </div>
          <div role="group" aria-labelledby="tools-rewrite-as" aria-describedby="tools-target" className="grid grid-cols-2 gap-2.5">
            {TOOLS_PRESETS.map((key) => {
              const label = REWRITE_PRESETS[key].toolsLabel ?? REWRITE_PRESETS[key].label;
              const running = busy?.key === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-disabled={blocked || undefined}
                  aria-busy={running || undefined}
                  onClick={() => void rewrite(target, { preset: key }, key, label)}
                  className={`flex min-h-11 items-center justify-center gap-1.5 rounded-full px-3 text-center text-[15px] leading-tight sm:min-h-9 ${filled} ${focusRing}`}
                >
                  {running && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />}
                  {label}
                </button>
              );
            })}
          </div>
        </section>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitCustom();
          }}
          className="space-y-2"
        >
          <label htmlFor="tools-custom" className="flex items-center gap-2 px-1 text-[18px] font-medium">
            <CustomRequestIcon className="h-5 w-5 shrink-0" aria-hidden /> Custom request
          </label>
          <textarea
            id="tools-custom"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submitCustom();
              }
            }}
            rows={4}
            maxLength={CUSTOM_MAX}
            placeholder="Try any prompt…"
            aria-describedby="tools-target tools-custom-hint"
            className="block w-full resize-y rounded-xl bg-[var(--tools-field)] px-3.5 py-3 text-[15px] text-[var(--tools-ink)] outline-none placeholder:text-[var(--tools-placeholder)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tools-focus)]"
          />
          <div className="flex items-center justify-between gap-3 px-1">
            <span id="tools-custom-hint" className="text-[13px]">
              {isMac ? "⌘↵ to run" : "Ctrl+Enter to run"}
            </span>
            <button
              type="submit"
              aria-disabled={!instruction.trim() || blocked || undefined}
              aria-busy={busy?.key === "custom" || undefined}
              className={`flex min-h-11 items-center gap-1.5 rounded-full bg-[var(--tools-ink)] px-4 text-[15px] font-semibold text-[var(--tools-bg)] aria-disabled:cursor-not-allowed aria-disabled:border aria-disabled:border-dashed aria-disabled:border-[var(--tools-ink)] aria-disabled:bg-transparent aria-disabled:text-[var(--tools-ink)] sm:min-h-8 ${focusRing}`}
            >
              {busy?.key === "custom" && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Rewrite
            </button>
          </div>
        </form>

        {error && (
          <p role="alert" className="flex items-start gap-2 px-1 text-sm font-medium">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {error}
          </p>
        )}
        {note && (
          <p role="status" className="px-1 text-sm">
            {note}
          </p>
        )}

        <div className="space-y-2">
          <button
            type="button"
            aria-disabled={!!draft.disabledReason || undefined}
            onClick={() => {
              if (draft.disabledReason || !draft.sectionId) return;
              void run({ sectionId: draft.sectionId, mode: "draft" });
            }}
            className={`flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[15px] font-medium sm:min-h-10 ${filled} ${focusRing}`}
          >
            {draft.disabledReason === "Claude is writing…" ? <Loader2 className="h-5 w-5 shrink-0 animate-spin" aria-hidden /> : <SparkleIcon className="h-5 w-5 shrink-0" aria-hidden />}
            {draft.label}
            {reasonFor(draft.disabledReason)}
          </button>
          <button
            type="button"
            aria-disabled={!!checkReason || undefined}
            onClick={() => !checkReason && onCheckDocument()}
            className={`flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[15px] font-medium sm:min-h-10 ${filled} ${focusRing}`}
          >
            <ListChecks className="h-5 w-5 shrink-0" aria-hidden />
            Check document
            {reasonFor(checkReason)}
          </button>
          <button
            type="button"
            aria-disabled={!!notesReason || undefined}
            onClick={() => !notesReason && onSectionNotes()}
            className={`flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[15px] font-medium sm:min-h-10 ${filled} ${focusRing}`}
          >
            <SectionNotesIcon className="h-5 w-5 shrink-0" aria-hidden />
            Section notes
            {reasonFor(notesReason)}
          </button>
        </div>

        <footer className="space-y-1 px-1 text-xs">
          <p>
            <span className="tabular-nums">{words.toLocaleString()}</span> {words === 1 ? "word" : "words"}
          </p>
          <p>A snapshot is saved before each rewrite, and Undo reverses it.</p>
        </footer>
      </div>
    </aside>
  );
}
