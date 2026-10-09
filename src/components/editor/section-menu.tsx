"use client";

// The section menu the heading gutter opens (PLAN §4.5): Draft / Draft again,
// Rewrite with a preset (either direction) or a custom instruction, Section
// notes, Check against rubric (the Check panel, scoped to the section) and
// Cite sources (a rewrite that keeps the wording and adds citations).
// Anchored to the gutter button's rectangle; the custom instruction opens a
// small popover in the same place.

import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { PencilLine, SectionNotesIcon, SparkleIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import type { DocumentTypeSummary } from "@/catalog/schema";
import { CITE_SOURCES_INSTRUCTION } from "@/lib/citations/contract";
import { REWRITE_PRESET_ORDER, REWRITE_PRESETS } from "@/lib/report/rewrite-presets";
import { sectionBodyRange } from "./tracked-range";
import type { GenerationRequest } from "./use-section-generation";

export type SectionMenuTarget = { sectionId: string; anchor: DOMRect };

/** Menu labels for the "less" direction of each preset; others read "Less <chip label>". */
const LESS_LABELS: Record<string, string> = {
  concise: "Expand with more detail",
  plain_language: "More technical",
  strengths: "Lead with concerns",
  summarize: "Restore full detail",
};

export function rewriteItems(): Array<{ key: string; label: string; direction: "more" | "less" }> {
  const out: Array<{ key: string; label: string; direction: "more" | "less" }> = [];
  for (const key of REWRITE_PRESET_ORDER) {
    const p = REWRITE_PRESETS[key];
    out.push({ key, label: p.label, direction: "more" });
    if (p.lessInstruction) out.push({ key, label: LESS_LABELS[key] ?? `Less ${p.chipLabel ?? p.label.toLowerCase()}`, direction: "less" });
  }
  return out;
}

function Anchor({ rect }: { rect: DOMRect }) {
  return <span aria-hidden="true" style={{ position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height, pointerEvents: "none" }} />;
}

/**
 * Back to the section's gutter button (the visible one: the margin copy from
 * sm up, the inline copy on phones) after Esc or a choice that left focus
 * nowhere. A choice that moved focus (Section notes, the custom instruction)
 * keeps it.
 */
function focusGutter(sectionId: string | null) {
  const active = document.activeElement;
  if (!sectionId || (active && active !== document.body && !active.closest('[role="menu"]'))) return;
  const buttons = document.querySelectorAll<HTMLElement>(`.section-gutter[data-section-id="${CSS.escape(sectionId)}"]`);
  Array.from(buttons).find((b) => b.getClientRects().length > 0)?.focus({ preventScroll: true });
}

export function SectionMenu({
  editor,
  target,
  type,
  busy,
  onClose,
  onRun,
  onNotes,
  onCheck,
}: {
  editor: Editor;
  target: SectionMenuTarget | null;
  type: DocumentTypeSummary | null;
  busy: ReadonlySet<string>;
  onClose: () => void;
  onRun: (req: GenerationRequest) => void;
  onNotes: (sectionId: string) => void;
  /** Check against rubric: open the Check panel on this section. */
  onCheck: (sectionId: string) => void;
}) {
  const [custom, setCustom] = useState<SectionMenuTarget | null>(null);
  const [instruction, setInstruction] = useState("");
  useEffect(() => {
    if (custom) setInstruction("");
  }, [custom]);
  // The section the menu was last opened for: focus goes back to its gutter button on close.
  const lastSection = useRef<string | null>(null);
  useEffect(() => {
    if (target) lastSection.current = target.sectionId;
  }, [target]);

  const section = target ? sectionBodyRange(editor.state.doc, target.sectionId) : null;
  const spec = section?.specKey ? type?.sections.find((s) => s.key === section.specKey) : undefined;
  const isStatic = spec?.renderer === "static";
  const hasBody = !!section?.bodyText.trim();
  const hasHeading = !!section?.heading.trim();
  const isBusy = !!target && busy.has(target.sectionId);

  return (
    <>
      <DropdownMenu open={!!target && !!section} onOpenChange={(o) => !o && onClose()} modal={false}>
        <DropdownMenuTrigger asChild>{target ? <Anchor rect={target.anchor} /> : <span hidden />}</DropdownMenuTrigger>
        {target && section && (
          <DropdownMenuContent align="start" className="min-w-60" onCloseAutoFocus={(e) => {
            e.preventDefault();
            focusGutter(lastSection.current);
          }}>
            <DropdownMenuLabel className="max-w-72 truncate text-xs font-semibold text-[var(--doc-muted)]">{section.heading || "Untitled section"}</DropdownMenuLabel>
            {isBusy ? (
              <DropdownMenuItem disabled>Claude is writing this section…</DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem disabled={isStatic || !hasHeading} onSelect={() => onRun({ sectionId: target.sectionId, mode: "draft" })}>
                  <SparkleIcon className="h-4 w-4" />
                  {hasBody ? "Draft again" : "Draft"}
                  {isStatic ? (
                    <span className="ml-auto pl-3 text-[11px] text-[var(--doc-muted)]">Fixed text</span>
                  ) : (
                    !hasHeading && <span className="ml-auto pl-3 text-[11px] text-[var(--doc-muted)]">Add a heading first</span>
                  )}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={!hasBody || !hasHeading} className="gap-2">
                    <PencilLine className="h-4 w-4" /> Rewrite
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-56">
                    {rewriteItems().map((item) => (
                      <DropdownMenuItem key={`${item.key}-${item.direction}`} onSelect={() => onRun({ sectionId: target.sectionId, mode: "rewrite", preset: item.key, direction: item.direction })}>
                        {item.label}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setCustom(target)}>Custom instruction…</DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
            <DropdownMenuItem onSelect={() => onNotes(target.sectionId)}>
              <SectionNotesIcon className="h-4 w-4" /> Section notes
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!hasBody} onSelect={() => onCheck(target.sectionId)}>
              Check against rubric
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!hasBody || !hasHeading || isStatic || isBusy} onSelect={() => onRun({ sectionId: target.sectionId, mode: "rewrite", instruction: CITE_SOURCES_INSTRUCTION })}>
              Cite sources
            </DropdownMenuItem>
          </DropdownMenuContent>
        )}
      </DropdownMenu>

      <Popover open={!!custom} onOpenChange={(o) => !o && setCustom(null)}>
        <PopoverAnchor asChild>{custom ? <Anchor rect={custom.anchor} /> : <span hidden />}</PopoverAnchor>
        <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] rounded-xl">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!custom || !instruction.trim()) return;
              onRun({ sectionId: custom.sectionId, mode: "rewrite", instruction: instruction.trim() });
              setCustom(null);
            }}
            className="space-y-2"
          >
            <label htmlFor="section-instruction" className="text-sm font-medium">
              How should Claude rewrite this section?
            </label>
            <textarea
              id="section-instruction"
              autoFocus
              rows={3}
              value={instruction}
              maxLength={2000}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
              }}
              placeholder="e.g. “make this more formal and cut it to one paragraph”"
              className="w-full resize-y rounded-md border border-[var(--doc-field-line)] bg-transparent px-2.5 py-2 text-sm outline-none focus:border-[var(--doc-accent)] focus-visible:ring-2 focus-visible:ring-[var(--doc-accent)]"
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCustom(null)} className="rounded-md px-2.5 py-1 text-sm text-[var(--doc-muted)] hover:text-[var(--doc-ink)]">
                Cancel
              </button>
              <button type="submit" disabled={!instruction.trim()} className="rounded-md bg-[var(--doc-accent)] px-3 py-1 text-sm font-semibold text-[var(--doc-on-accent)] disabled:opacity-50">
                Rewrite
              </button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </>
  );
}
