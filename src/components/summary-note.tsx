"use client";

// The yellow sticky note: the document's plain-language summary and next steps.
//
// Generated automatically, but the person's own wording wins. Once they
// edit it, a later generation never replaces what they wrote — it only marks
// the note as out of date and offers to regenerate, leaving that call to them.

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Pencil, RefreshCw, Sparkles, X } from "@/components/icons";

export type NoteState = {
  /** The person's saved note, if they've written one. */
  note?: { text: string; basedOn?: string };
  /** The latest generated summary. */
  generated?: string;
  /** True while the files are being (re)read — the generated text is stale. */
  summarizing?: boolean;
};

export function SummaryNote({
  groupId,
  note,
  generated,
  summarizing,
  onSaved,
  className = "",
}: NoteState & { groupId: string; onSaved?: () => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const edited = !!note?.text;
  const text = edited ? note!.text : generated ?? "";
  // The generated summary has moved on since they wrote theirs.
  const stale = edited && !!generated && !!note!.basedOn && generated.trim() !== note!.basedOn.trim();

  useEffect(() => {
    if (editing) areaRef.current?.focus();
  }, [editing]);

  const save = async (value: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/upload-groups/${groupId}/flags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // basedOn pins the generated text this edit was made against, which is
        // the only way to later tell "still current" from "document has moved on".
        body: JSON.stringify({ summaryNote: value, basedOn: generated ?? "" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Could not save the note.");
        return;
      }
      setEditing(false);
      onSaved?.();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  };

  const base =
    "relative rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-900/50 shadow-[0_2px_8px_rgba(0,0,0,0.06)] px-4 py-3.5 text-[15px] leading-relaxed text-zinc-700 dark:text-amber-100/90";

  if (editing) {
    return (
      <div className={`${base} ${className}`}>
        <textarea
          ref={areaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={7}
          className="w-full resize-y bg-transparent outline-none placeholder:text-amber-800/40"
          placeholder="Summarize this document and its next steps…"
        />
        {error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => save(draft)}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-full bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
          </button>
          <button
            onClick={() => setEditing(false)}
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-amber-800/80 hover:bg-amber-100 dark:text-amber-300/80 dark:hover:bg-amber-900/40"
          >
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
          {edited ? (
            <button
              onClick={() => save(null)}
              disabled={saving}
              className="ml-auto text-xs text-amber-800/70 underline-offset-2 hover:underline dark:text-amber-300/70"
              title="Discard your edit and go back to the generated summary"
            >
              Use generated
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`group ${base} ${className}`}>
      {summarizing && !edited ? (
        <p className="flex items-center gap-1.5 italic text-amber-800/70 dark:text-amber-300/70">
          <Sparkles className="h-4 w-4 shrink-0 animate-pulse" /> Summarizing…
        </p>
      ) : text ? (
        <p className="whitespace-pre-wrap">{text}</p>
      ) : (
        <p className="italic text-amber-800/50 dark:text-amber-300/50">No summary yet.</p>
      )}

      {stale ? (
        <p className="mt-2.5 flex items-start gap-1.5 border-t border-amber-200/70 pt-2 text-xs text-amber-800/80 dark:border-amber-900/50 dark:text-amber-300/80">
          <RefreshCw className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            The document has changed since you edited this.{" "}
            <button onClick={() => save(null)} disabled={saving} className="font-medium underline underline-offset-2">
              Use the new summary
            </button>
          </span>
        </p>
      ) : null}

      <button
        onClick={() => {
          setDraft(text);
          setEditing(true);
        }}
        aria-label="Edit summary"
        title="Edit this summary"
        className="absolute right-2 top-2 rounded-full p-1.5 text-amber-700/50 opacity-0 transition-opacity hover:bg-amber-100 hover:text-amber-800 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-amber-900/40"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
