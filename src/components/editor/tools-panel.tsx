"use client";

// The Agents card (redesign3-spec.md §14), the olive card in the editor's
// right column. "Rewrite as…" acts on the selection, else the caret's
// section, else the caret's paragraph (tools-panel-model.ts rewriteTarget). A
// selection or paragraph goes through /rewrite here and lands as one
// transaction; a section goes through useSectionGeneration's run, which
// snapshots, shows the gutter busy state and makes one undo step. "Run
// workflow…" picks one of the document's workflows: one without params starts
// here and shows its progress, one that needs a form opens the Workflows tab.
// Then draft the caret's section, check the document and open Section notes.
// "Custom request" is the darker bar along the bottom of the card, as in the
// mockup.

import type { Editor, JSONContent } from "@tiptap/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useReducer, useState } from "react";
import { AlertCircle, CaretUpDown, CustomRequestIcon, ListChecks, Loader2, PencilLine, RunWorkflowIcon, SectionNotesIcon, Send, SparkleIcon, X } from "@/components/icons";
import { api, errorText } from "@/components/sources/shared";
import type { DocumentTypeSummary } from "@/catalog/schema";
import type { CitationReport } from "@/lib/citations/contract";
import { markCitations } from "@/lib/citations/marks";
import { markdownToTiptap } from "@/lib/report/markdown-to-tiptap";
import { REWRITE_PRESETS, TOOLS_PRESETS } from "@/lib/report/rewrite-presets";
import { stripCitationMarkers } from "@/lib/sections/content";
import type { AvailableWorkflow, DocumentWorkflowsResponse, RunResponse, WorkflowRunView } from "@/lib/workflow/contract";
import { textWithMarkers } from "./citation-layer-model";
import { AGENTS_HEADING_ID } from "./right-column-model";
import { PanelHeader } from "./side-panels";
import {
  DEFAULT_START_FORM,
  draftRow,
  rewriteInsertion,
  rewriteTarget,
  rewriteTargetLine,
  runProgress,
  wordCount,
  workflowChoice,
  workflowOptionGroups,
  workflowOptionText,
  type RewriteTarget,
} from "./tools-panel-model";
import { trackRange } from "./tracked-range";
import { droppedNotice, type GenerationRequest } from "./use-section-generation";
import { pollDelay, startRequest } from "./workflows-pane-model";

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

const docWorkflows = (id: string) => `/api/documents/${encodeURIComponent(id)}/workflows`;
const runUrl = (id: string) => `/api/workflow-runs/runs/${encodeURIComponent(id)}`;

/**
 * The document's workflows for the picker (GET …/workflows `available`),
 * reloaded when the document gets its id or changes type. Null while loading
 * or before the first save.
 */
function useAvailableWorkflows(documentId: string | null, typeKey: string | null) {
  const [available, setAvailable] = useState<AvailableWorkflow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!documentId) {
      setAvailable(null);
      return;
    }
    let live = true;
    setError(null);
    api<DocumentWorkflowsResponse>(docWorkflows(documentId))
      .then((r) => live && setAvailable(r.available))
      .catch((e) => live && setError(errorText(e, "Couldn't load the workflows.")));
    return () => {
      live = false;
    };
  }, [documentId, typeKey]);
  return { available, error };
}

/** The run started from the card, polled on the Workflows tab's schedule (pollDelay) until it settles. */
function useRunProgress(runId: string | null) {
  const [run, setRun] = useState<WorkflowRunView | null>(null);
  const [failures, setFailures] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setRun(null);
    setFailures(0);
  }, [runId]);
  useEffect(() => {
    if (!runId) return;
    let live = true;
    api<RunResponse>(runUrl(runId))
      .then((r) => {
        if (!live) return;
        setRun(r.run);
        setFailures(0);
      })
      .catch(() => live && setFailures((n) => n + 1));
    return () => {
      live = false;
    };
  }, [runId, tick]);
  const delay = run ? pollDelay(run.status, failures) : runId ? pollDelay("running", failures) : null;
  useEffect(() => {
    if (delay === null) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), delay);
    return () => window.clearTimeout(t);
  }, [delay, run, failures]);
  return run;
}

/** ToolsPanel's props (redesign3-spec.md §14); document-screen passes all of them. */
export type ToolsPanelProps = {
  editor: Editor;
  documentId: string | null;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  /** The document's type, for the Draft row (a static section can't be drafted) and the "For <Type>" workflows. */
  type: DocumentTypeSummary | null;
  /** The section the caret is in (useCaretSectionId): the target of Rewrite with no selection, Draft and Section notes. */
  caretSectionId: string | null;
  /** useSectionGeneration's run and busy set: section rewrite and draft go through them (snapshot, one undo, gutter busy state). */
  run: (req: GenerationRequest) => Promise<string | null>;
  busy: ReadonlySet<string>;
  /** Why nothing here may change the document now ("tell me" is drafting it), or null. */
  locked?: string | null;
  onClose: () => void;
  /** Check the whole document against its rubric (opens the Check panel in this place). */
  onCheckDocument: () => void;
  /** Open Section notes for the caret's section (takes this place; its X brings the Agents button back). */
  onSectionNotes: () => void;
  /** The run started from "Run workflow…" (kept by the screen, so it outlasts the card closing), or null. */
  runId: string | null;
  onRunIdChange: (runId: string | null) => void;
  /** A workflow that needs a form: the Workflows tab, on that workflow's form. */
  onWorkflowForm: (w: AvailableWorkflow) => void;
  /** "Open run" / "Review": the Workflows tab on the run. */
  onOpenRun: (runId: string) => void;
};

// Shared looks inside the olive card. Disabled controls keep their text at
// full contrast on the card (a dashed outline instead of a fill) and say why.
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--tools-focus)]";
const filled =
  "bg-[var(--tools-chip)] hover:bg-[var(--tools-chip-hover)] aria-disabled:cursor-not-allowed aria-disabled:border aria-disabled:border-dashed aria-disabled:border-[var(--tools-ink)] aria-disabled:bg-transparent";
const outlinePill = `inline-flex min-h-11 shrink-0 items-center rounded-full border border-[var(--tools-ink)] px-3.5 text-[14px] font-medium hover:bg-[var(--tools-chip)] sm:min-h-8 ${focusRing}`;
const sectionTitle = "flex items-center gap-2 text-[18px] font-medium";

type Busy = { key: string; sectionId: string | null } | null;

export function ToolsPanel({
  editor,
  documentId,
  ensureSaved,
  type,
  caretSectionId,
  run,
  busy: generating,
  locked = null,
  onClose,
  onCheckDocument,
  onSectionNotes,
  runId,
  onRunIdChange,
  onWorkflowForm,
  onOpenRun,
}: ToolsPanelProps) {
  useEditorTick(editor);
  const router = useRouter();
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const workflows = useAvailableWorkflows(documentId, type?.key ?? null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const started = useRunProgress(runId);
  const progress = started && started.id === runId ? runProgress(started) : null;

  const target = rewriteTarget(editor.state, caretSectionId);
  const row = draftRow(editor.state.doc, type?.sections, caretSectionId, generating);
  const draft = locked && !row.disabledReason ? { ...row, disabledReason: "Sasha is drafting…" } : row;
  const words = wordCount(editor.state.doc);
  const sectionRunning = target.kind === "section" && generating.has(target.sectionId);
  const blocked = target.kind === "none" || !!busy || sectionRunning || !!locked;
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

  /** The picker's choice: start it here, or hand over to the Workflows tab's form. The select goes back to its placeholder either way. */
  const chooseWorkflow = async (id: string) => {
    const w = workflows.available?.find((a) => a.id === id);
    if (!w || starting) return;
    const choice = workflowChoice(w);
    if (choice === "unavailable") return;
    if (choice === "form") return onWorkflowForm(w);
    setStarting(true);
    setStartError(null);
    try {
      const docId = await ensureSaved();
      if (!docId) throw new Error("Save the document before running a workflow.");
      const { run: begun } = await api<RunResponse>(docWorkflows(docId), { method: "POST", json: startRequest(w, DEFAULT_START_FORM) });
      onRunIdChange(begun.id);
    } catch (e) {
      setStartError(errorText(e, "Couldn't start the workflow."));
    } finally {
      setStarting(false);
    }
  };

  /** "See all" before the first save: save, then go (the page needs the document's id). */
  const seeAllUnsaved = async () => {
    const id = await ensureSaved();
    router.push(id ? `/workflows?document=${encodeURIComponent(id)}` : "/workflows");
  };

  const reasonFor = (reason: string | null) => (reason ? <span className="ml-auto pl-2 text-right text-[13px] font-normal">{reason}</span> : null);
  const checkReason = words === 0 ? "Nothing to check yet" : null;
  const notesReason = caretSectionId ? null : "Put the cursor in a section";
  const groups = workflows.available ? workflowOptionGroups(workflows.available, type?.title ?? null) : [];

  return (
    <aside aria-label="Agents" className="flex flex-col overflow-hidden rounded-[22px] bg-[var(--tools-bg)] text-[var(--tools-ink)] shadow-md">
      <div className="space-y-6 px-6 pb-4 pt-6">
        <PanelHeader title="Agents" variant="tools" onClose={onClose} headingId={AGENTS_HEADING_ID} />

        <section aria-labelledby="agents-rewrite-as" className="space-y-3">
          <div className="space-y-1">
            <h3 id="agents-rewrite-as" className={sectionTitle}>
              <PencilLine className="h-5 w-5 shrink-0" aria-hidden /> Rewrite as…
            </h3>
            <p id="agents-target" className="text-sm">
              {locked ?? (sectionRunning && target.kind === "section" ? `Claude is writing “${target.heading.trim() || "Untitled section"}”…` : rewriteTargetLine(target))}
            </p>
          </div>
          <div role="group" aria-labelledby="agents-rewrite-as" aria-describedby="agents-target" className="grid grid-cols-2 gap-3">
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
                  className={`flex h-11 items-center justify-center gap-1.5 rounded-full px-3 text-center text-[15px] leading-tight sm:h-12 ${filled} ${focusRing}`}
                >
                  {running && <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />}
                  {label}
                </button>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="agents-run-workflow" className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 id="agents-run-workflow" className={sectionTitle}>
              <RunWorkflowIcon className="h-5 w-5 shrink-0" aria-hidden /> Run workflow…
            </h3>
            <Link
              href={documentId ? `/workflows?document=${encodeURIComponent(documentId)}` : "/workflows"}
              aria-label="See all workflows"
              onClick={(e) => {
                if (documentId) return;
                e.preventDefault();
                void seeAllUnsaved();
              }}
              className={outlinePill}
            >
              See all
            </Link>
          </div>
          <div className="relative">
            <select
              aria-label="Select workflow"
              aria-describedby={!documentId || workflows.error ? "agents-workflow-hint" : undefined}
              value=""
              disabled={!groups.length}
              aria-busy={starting || undefined}
              onChange={(e) => void chooseWorkflow(e.target.value)}
              className={`block min-h-11 w-full appearance-none rounded-xl border border-[var(--tools-ink)] bg-[var(--tools-chip)] pl-3 pr-10 text-[16px] text-[var(--tools-ink)] disabled:cursor-not-allowed sm:min-h-10 ${focusRing}`}
            >
              <option value="">{starting ? "Starting…" : "Select workflow"}</option>
              {groups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.items.map((w) => (
                    <option key={w.id} value={w.id} disabled={workflowChoice(w) === "unavailable"}>
                      {workflowOptionText(w)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <CaretUpDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-[var(--tools-ink)]" />
          </div>
          {(!documentId || workflows.error) && (
            <p id="agents-workflow-hint" className="text-[13px]">
              {workflows.error ?? "Workflows appear once the document is saved."}
            </p>
          )}
          {startError && (
            <p role="alert" className="flex items-start gap-2 text-sm font-medium">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {startError}
            </p>
          )}
          {runId && (
            <div role="status" className="space-y-2 rounded-xl bg-[var(--tools-chip)] px-3.5 py-3 text-sm">
              {progress ? (
                <>
                  <div className="flex items-start gap-2">
                    {!progress.finished && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
                    <p className="min-w-0 flex-1">
                      <span className="block font-semibold">{progress.name}</span>
                      {progress.statusLine} · {progress.stepsLine}
                    </p>
                    {progress.finished && (
                      <button
                        type="button"
                        onClick={() => onRunIdChange(null)}
                        aria-label={`Dismiss ${progress.name}`}
                        className={`-mr-1.5 -mt-1 grid min-h-11 min-w-11 shrink-0 place-items-center rounded-full hover:bg-[var(--tools-chip-hover)] sm:min-h-8 sm:min-w-8 ${focusRing}`}
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    )}
                  </div>
                  <button type="button" onClick={() => onOpenRun(runId)} className={outlinePill}>
                    {progress.action}
                  </button>
                </>
              ) : (
                <p className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> Starting the workflow…
                </p>
              )}
            </div>
          )}
        </section>

        <div className="space-y-3">
          {error && (
            <p role="alert" className="flex items-start gap-2 text-sm font-medium">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          {note && (
            <p role="status" className="text-sm">
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

          <footer className="space-y-1 text-xs">
            <p>
              <span className="tabular-nums">{words.toLocaleString()}</span> {words === 1 ? "word" : "words"}
            </p>
            <p>A snapshot is saved before each rewrite, and Undo reverses it.</p>
          </footer>
        </div>

        <label htmlFor="agents-custom" className={sectionTitle}>
          <CustomRequestIcon className="h-5 w-5 shrink-0" aria-hidden /> Custom request
        </label>
      </div>

      {/* The darker bar along the bottom of the card (the mockup's "Try any prompt…"): Enter sends, Shift+Enter starts a new line. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submitCustom();
        }}
        className="flex items-end gap-2 bg-[var(--tools-field)] py-2 pl-6 pr-3"
      >
        <textarea
          id="agents-custom"
          aria-label="Custom request"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submitCustom();
            }
          }}
          rows={2}
          maxLength={CUSTOM_MAX}
          placeholder="Try any prompt…"
          aria-describedby="agents-target agents-custom-hint"
          className="block min-h-11 min-w-0 flex-1 resize-none rounded-lg bg-transparent py-2 text-[16px] text-[var(--tools-ink)] outline-none placeholder:text-[var(--tools-placeholder)] focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-[var(--tools-focus)]"
        />
        <span id="agents-custom-hint" className="sr-only">
          Enter to run, Shift+Enter for a new line.
        </span>
        <button
          type="submit"
          aria-disabled={!instruction.trim() || blocked || undefined}
          aria-busy={busy?.key === "custom" || undefined}
          className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-full bg-[var(--tools-ink)] px-4 text-[15px] font-semibold text-[var(--tools-bg)] aria-disabled:cursor-not-allowed aria-disabled:border aria-disabled:border-dashed aria-disabled:border-[var(--tools-ink)] aria-disabled:bg-transparent aria-disabled:text-[var(--tools-ink)] sm:min-h-9 ${focusRing}`}
        >
          {busy?.key === "custom" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />} Rewrite
        </button>
      </form>
    </aside>
  );
}
