"use client";

// Drafting and rewriting one section with Claude, for the heading gutter and
// the section notes panel. A run saves the document, takes a version snapshot,
// asks the server for the section body, then puts the result back where the
// section is now: the person may keep writing while Claude works (a draft can
// take a minute or two), so the section is found again by its id, and the
// result is only applied directly when the section still reads as it did. The
// insert is one transaction, so a single Undo takes it back.

import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SectionGenerateRequest, SectionGenerateResponse, SectionMode } from "@/lib/sections/contract";
import { sectionBlocksFromMarkdown } from "@/lib/sections/content";
import { setBusySections } from "./extensions";
import type { Notify } from "./notice";
import { sectionBodyRange, type SectionBody } from "./tracked-range";

export type GenerationRequest = {
  sectionId: string;
  mode: SectionMode;
  preset?: string;
  direction?: "more" | "less";
  instruction?: string;
  notes?: string;
};

export type ApplyDecision = "apply" | "changed" | "deleted";

/**
 * What to do with a result: apply it, ask first because the section changed
 * while Claude was writing, or give up because the section is gone. A draft
 * expects the body still empty and a rewrite the same text it sent, which is
 * one rule: the body must read as it did when the request went out.
 */
export function applyDecision(sentBody: string, current: Pick<SectionBody, "bodyText"> | null): ApplyDecision {
  if (!current) return "deleted";
  return current.bodyText.trim() === sentBody.trim() ? "apply" : "changed";
}

const isRewrite = (mode: SectionMode) => mode === "rewrite" || mode === "rewrite_from_notes";

/** A readable message for a failed generate call. */
export function generationError(status: number, body: { error?: unknown }): string {
  if (typeof body.error === "string" && body.error) return body.error;
  if (status === 404) return "Section drafting isn't available yet.";
  if (status === 503) return "Claude is not configured.";
  if (status === 422) return "Claude couldn't write this section. Try again, or change the request.";
  return `Claude couldn't write this section (${status}).`;
}

/** What the editor's live region says while sections are being written ("" when none). */
export function busyAnnouncement(headings: string[]): string {
  if (!headings.length) return "";
  if (headings.length > 1) return `Claude is writing ${headings.length} sections.`;
  return `Claude is writing “${headings[0].trim() || "Untitled section"}”.`;
}

/** Why a run can't start, before anything is sent; null when it can. */
export function preflightError(target: Pick<SectionBody, "heading" | "bodyText"> | null, mode: SectionMode, alreadyRunning: boolean): string | null {
  if (alreadyRunning) return "Claude is already writing this section.";
  if (!target) return "That section no longer exists.";
  if (!target.heading.trim()) return "Give the section a heading first.";
  if (isRewrite(mode) && !target.bodyText.trim()) return "Nothing to rewrite: the section is empty.";
  return null;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function useSectionGeneration({
  editor,
  ensureSaved,
  notify,
}: {
  editor: Editor | null;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  notify: Notify;
}) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  // The ref guards against a double run before React re-renders.
  const running = useRef(new Set<string>());

  useEffect(() => {
    if (editor && !editor.isDestroyed) setBusySections(editor.view, busy);
  }, [editor, busy]);

  const mark = useCallback((sectionId: string, on: boolean) => {
    if (on) running.current.add(sectionId);
    else running.current.delete(sectionId);
    setBusy(new Set(running.current));
  }, []);

  /** Replace the section's body with the result, as one undoable step. */
  const insert = useCallback(
    (sectionId: string, markdown: string, mode: SectionMode, lineBreaks = false): boolean => {
      if (!editor || editor.isDestroyed) return false;
      const current = sectionBodyRange(editor.state.doc, sectionId);
      if (!current) {
        notify({ text: "That section was deleted while Claude was writing.", tone: "error" });
        return false;
      }
      const blocks = sectionBlocksFromMarkdown(markdown, current.level, { lineBreaks });
      editor.chain().insertContentAt({ from: current.from, to: current.to }, blocks, { updateSelection: false }).run();
      notify({
        text: `${isRewrite(mode) ? "Rewrote" : "Drafted"} “${current.heading || "Untitled section"}”.`,
        actions: [{ label: "Undo", run: () => editor.chain().focus().undo().run() }],
      });
      return true;
    },
    [editor, notify],
  );

  /**
   * Run one generation. Every failure, including a request that can't start,
   * is shown as a notice (callers such as the gutter menu have no other place
   * to show it) and also returned, or null when it succeeded (or is waiting on
   * the person's choice).
   */
  const run = useCallback(
    async (req: GenerationRequest): Promise<string | null> => {
      const fail = (message: string) => {
        notify({ text: message, tone: "error" });
        return message;
      };
      if (!editor || editor.isDestroyed) return fail("The editor isn't ready.");
      const target = sectionBodyRange(editor.state.doc, req.sectionId);
      const blocked = preflightError(target, req.mode, running.current.has(req.sectionId));
      if (blocked || !target) return fail(blocked ?? "That section no longer exists.");

      mark(req.sectionId, true);
      try {
        const id = await ensureSaved();
        if (!id) return fail("Save the document first.");
        // A version to go back to, taken after the save so it holds the latest text.
        await postJson(`/api/documents/${id}/versions`, { reason: `Before ${isRewrite(req.mode) ? "rewrite" : "draft"}: ${target.heading}` }).catch(() => null);
        const body: SectionGenerateRequest = {
          mode: req.mode,
          heading: target.heading,
          level: target.level,
          specKey: target.specKey,
          body: target.bodyText,
          ...(req.preset ? { preset: req.preset } : {}),
          ...(req.direction ? { direction: req.direction } : {}),
          ...(req.instruction?.trim() ? { instruction: req.instruction.trim() } : {}),
          ...(req.notes !== undefined ? { notes: req.notes } : {}),
        };
        let res: Response;
        try {
          res = await postJson(`/api/documents/${id}/sections/${encodeURIComponent(req.sectionId)}/generate`, body);
        } catch {
          return fail("Couldn't reach the server. Check your connection and try again.");
        }
        const out = (await res.json().catch(() => ({}))) as Partial<SectionGenerateResponse> & { error?: unknown };
        if (!res.ok) return fail(generationError(res.status, out));
        const markdown = String(out.markdown ?? "");
        const lineBreaks = out.lineBreaks === true;
        if (editor.isDestroyed) return null;

        const decision = applyDecision(target.bodyText, sectionBodyRange(editor.state.doc, req.sectionId));
        if (decision === "deleted") return fail("That section was deleted while Claude was writing.");
        if (decision === "changed") {
          notify({
            text: `“${target.heading}” changed while Claude was writing.`,
            // Holds the result until the person chooses; other notices queue around it, and a newer result for this section replaces it.
            sticky: true,
            key: `changed:${req.sectionId}`,
            actions: [
              { label: "Replace anyway", run: () => void insert(req.sectionId, markdown, req.mode, lineBreaks) },
              { label: "Discard", run: () => {} },
            ],
          });
          return null;
        }
        insert(req.sectionId, markdown, req.mode, lineBreaks);
        return null;
      } finally {
        mark(req.sectionId, false);
      }
    },
    [editor, ensureSaved, insert, mark, notify],
  );

  return { run, busy };
}
