"use client";

// The panels that open from the toolbar: the outline on the left and the
// writing tools on the right.

import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { Loader2, SparkleIcon, X } from "@/components/icons";
import { markdownToTiptap } from "@/lib/report/markdown-to-tiptap";
import { REWRITE_PRESET_ORDER, REWRITE_PRESETS } from "@/lib/report/rewrite-presets";

type HeadingItem = { pos: number; level: number; text: string; id: string };

function useHeadings(editor: Editor): HeadingItem[] {
  const [items, setItems] = useState<HeadingItem[]>([]);
  useEffect(() => {
    const read = () => {
      const out: HeadingItem[] = [];
      editor.state.doc.forEach((node, pos) => {
        if (node.type.name === "heading") out.push({ pos, level: Number(node.attrs.level), text: node.textContent, id: String(node.attrs.sectionId ?? pos) });
      });
      setItems(out);
    };
    read();
    editor.on("update", read);
    return () => {
      editor.off("update", read);
    };
  }, [editor]);
  return items;
}

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-5 pb-2 pt-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--doc-muted)]">{title}</h2>
      <button type="button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} className="rounded-md p-1 text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)]">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function OutlinePanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const headings = useHeadings(editor);
  const minLevel = Math.min(...headings.map((h) => h.level), 3);
  const go = (pos: number) => {
    editor.chain().focus().setTextSelection(pos + 1).run();
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <aside aria-label="Outline" className="flex h-full flex-col">
      <PanelHeader title="Outline" onClose={onClose} />
      {headings.length === 0 ? (
        <p className="px-5 text-sm text-[var(--doc-muted)]">Headings appear here as you add them. Choose a document type to start from an outline.</p>
      ) : (
        <nav className="overflow-y-auto px-3 pb-4">
          <ol className="space-y-0.5">
            {headings.map((h) => (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => go(h.pos)}
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
    </aside>
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
}: {
  editor: Editor;
  documentId: string | null;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  onClose: () => void;
}) {
  const selection = useSelectionText(editor);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const words = editor.state.doc.textContent.trim().match(/\S+/g)?.length ?? 0;

  const rewrite = async (body: { preset?: string; direction?: "more" | "less"; instruction?: string }, label: string) => {
    if (!selection) return;
    const target = selection;
    setBusy(label);
    setError(null);
    try {
      const id = documentId ?? (await ensureSaved());
      if (!id) throw new Error("Save the document first.");
      await fetch(`/api/documents/${id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: `Before rewrite: ${label}` }),
      });
      const res = await fetch(`/api/documents/${id}/rewrite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: target.text, ...body }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? "The rewrite failed.");
      const parsed = markdownToTiptap(String(out.markdown ?? ""));
      // One paragraph back for an inline selection: insert its text, not a new block.
      const single = parsed.content.length === 1 && parsed.content[0].type === "paragraph";
      const content = single ? (parsed.content[0].content ?? []) : parsed.content;
      editor.chain().focus().insertContentAt({ from: target.from, to: target.to }, content).run();
      setInstruction("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The rewrite failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside aria-label="Tools" className="flex h-full flex-col">
      <PanelHeader title="Tools" onClose={onClose} />
      <div className="space-y-5 overflow-y-auto px-5 pb-6">
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
              className="flex items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              {busy === "Custom" && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Rewrite
            </button>
          </form>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <p className="text-xs text-[var(--doc-muted)]">A snapshot is saved before each rewrite, and Undo reverses it.</p>
        </section>
        <section className="border-t border-[var(--doc-line)] pt-4 text-sm text-[var(--doc-muted)]">
          <span className="tabular-nums">{words.toLocaleString()}</span> words
        </section>
      </div>
    </aside>
  );
}
