"use client";

// The Report tab: a section browser + a per-section Tiptap editor stack that
// reads as one document, a formatting toolbar acting on the focused section,
// debounced autosave, and the generate / regenerate / rewrite / mark-reviewed
// tools wired to the report routes.

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import { reportExtensions } from "@/lib/report/editor-extensions";
import { tiptapToHtml, type PMDoc } from "@/lib/report/markdown-to-tiptap";
import { REWRITE_CHIP_ORDER, REWRITE_PRESETS } from "@/lib/report/rewrite-presets";
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, List, ListOrdered, Link2, Table as TableIcon,
  AlignLeft, AlignCenter, AlignRight, Heading2, Undo2, Redo2, RefreshCw, Loader2, Download, Sparkles, FileText,
  CheckCircle2, CircleCheck, CirclePlus, CircleMinus, PencilLine, Send, Maximize, Minimize,
} from "@/components/icons";

type Section = {
  section_key: string;
  heading: string;
  sort_order: number;
  content_json: { type?: string } | null;
  content_text: string;
  status: string;
  source: string;
  /** From the server: whether the model may rewrite this section. */
  rewritable?: boolean;
};

type TemplateOption = { key: string; title: string };

function TB({ onClick, active, disabled, title, children }: { onClick: () => void; active?: boolean; disabled?: boolean; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      className={`grid h-8 w-8 place-items-center rounded-md text-sm ${active ? "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200" : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"} disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
  const d = !editor;
  const run = (fn: (e: Editor) => void) => () => editor && fn(editor);
  return (
    <div className="flex flex-wrap items-center gap-0.5">
      <TB title="Undo" disabled={d} onClick={run((e) => e.chain().focus().undo().run())}><Undo2 className="h-4 w-4" /></TB>
      <TB title="Redo" disabled={d} onClick={run((e) => e.chain().focus().redo().run())}><Redo2 className="h-4 w-4" /></TB>
      <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
      <TB title="Heading" disabled={d} active={editor?.isActive("heading", { level: 2 })} onClick={run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())}><Heading2 className="h-4 w-4" /></TB>
      <TB title="Bold" disabled={d} active={editor?.isActive("bold")} onClick={run((e) => e.chain().focus().toggleBold().run())}><Bold className="h-4 w-4" /></TB>
      <TB title="Italic" disabled={d} active={editor?.isActive("italic")} onClick={run((e) => e.chain().focus().toggleItalic().run())}><Italic className="h-4 w-4" /></TB>
      <TB title="Underline" disabled={d} active={editor?.isActive("underline")} onClick={run((e) => e.chain().focus().toggleUnderline().run())}><UnderlineIcon className="h-4 w-4" /></TB>
      <TB title="Strikethrough" disabled={d} active={editor?.isActive("strike")} onClick={run((e) => e.chain().focus().toggleStrike().run())}><Strikethrough className="h-4 w-4" /></TB>
      <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
      <TB title="Bullet list" disabled={d} active={editor?.isActive("bulletList")} onClick={run((e) => e.chain().focus().toggleBulletList().run())}><List className="h-4 w-4" /></TB>
      <TB title="Numbered list" disabled={d} active={editor?.isActive("orderedList")} onClick={run((e) => e.chain().focus().toggleOrderedList().run())}><ListOrdered className="h-4 w-4" /></TB>
      <TB title="Link" disabled={d} onClick={run((e) => { const url = window.prompt("Link URL"); if (url) e.chain().focus().setLink({ href: url }).run(); else e.chain().focus().unsetLink().run(); })}><Link2 className="h-4 w-4" /></TB>
      <TB title="Insert table" disabled={d} onClick={run((e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}><TableIcon className="h-4 w-4" /></TB>
      <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
      <TB title="Align left" disabled={d} onClick={run((e) => e.chain().focus().setTextAlign("left").run())}><AlignLeft className="h-4 w-4" /></TB>
      <TB title="Align center" disabled={d} onClick={run((e) => e.chain().focus().setTextAlign("center").run())}><AlignCenter className="h-4 w-4" /></TB>
      <TB title="Align right" disabled={d} onClick={run((e) => e.chain().focus().setTextAlign("right").run())}><AlignRight className="h-4 w-4" /></TB>
    </div>
  );
}

/**
 * The live Tiptap instance for ONE section. Split out so it can be mounted
 * lazily: a report has 9 sections, and constructing 9 ProseMirror EditorViews
 * on open was the heaviest thing in the app. Sections render as static HTML
 * until the user actually clicks into one.
 */
function LiveSectionEditor({
  section, onActive, onActivate, onSave, register,
}: {
  section: Section;
  onActive: (e: Editor | null) => void;
  onActivate: (key: string) => void;
  onSave: (key: string, json: object) => void;
  register: (key: string, e: Editor | null) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: reportExtensions,
    content: section.content_json && section.content_json.type === "doc" ? section.content_json : "",
    immediatelyRender: false,
    autofocus: "end",
    editorProps: { attributes: { class: "prose-report outline-none min-h-[3rem]" } },
    onFocus: ({ editor }) => { onActive(editor); onActivate(section.section_key); },
    onUpdate: ({ editor }) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => onSave(section.section_key, editor.getJSON()), 800);
    },
  });

  useEffect(() => {
    register(section.section_key, editor);
    return () => register(section.section_key, null);
  }, [editor, section.section_key, register]);

  // Hand the toolbar this editor as soon as it exists, so formatting buttons act
  // on the section the user just opened without needing a second click.
  useEffect(() => {
    if (editor) onActive(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Cancel any pending autosave on unmount. Without this, editing a section and
  // then regenerating it within the debounce window lets the stale timer fire
  // after the remount, PATCHing the pre-regeneration content over the new text.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return <EditorContent editor={editor} />;
}


/**
 * One section on the page. The page itself carries no controls — every tool
 * lives in the panel beside it, acting on whichever section has focus. A report
 * someone is going to sign should look like the report, not like a form.
 */
function SectionEditor({
  section, live, onMount, onActive, onActivate, onSave, register, busy,
}: {
  section: Section;
  live: boolean;
  /** The model is replacing this section's text — rewriting OR regenerating. */
  busy: boolean;
  onMount: () => void;
  onActive: (e: Editor | null) => void;
  onActivate: (key: string) => void;
  onSave: (key: string, json: object) => void;
  register: (key: string, e: Editor | null) => void;
}) {
  return (
    <section className="scroll-mt-24" id={`section-${section.section_key}`}>
      <h2 className="mb-2 text-[26px] font-bold text-zinc-900 dark:text-zinc-100">{section.heading}</h2>
      <div className={`rounded-lg text-[15px] leading-relaxed text-zinc-800 dark:text-zinc-200 transition-opacity ${busy ? "pointer-events-none opacity-50" : ""}`}>
        {live ? (
          <LiveSectionEditor section={section} onActive={onActive} onActivate={onActivate} onSave={onSave} register={register} />
        ) : (
          // Static render until the section is opened — same markup the editor
          // produces, so switching to the live editor is visually seamless.
          <div
            role="button"
            tabIndex={0}
            aria-label={`Edit ${section.heading}`}
            onClick={() => { onMount(); onActivate(section.section_key); }}
            onFocus={() => { onMount(); onActivate(section.section_key); }}
            className="prose-report min-h-[3rem] cursor-text outline-none"
            dangerouslySetInnerHTML={{ __html: tiptapToHtml(section.content_json as PMDoc | null) || "<p></p>" }}
          />
        )}
      </div>
    </section>
  );
}

/** Outline of the report. Icon carries the section's state; the active one is highlighted. */
function SectionsPanel({
  sections, activeKey, onJump,
}: {
  sections: Section[];
  activeKey: string | null;
  onJump: (key: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-col rounded-2xl bg-white shadow-sm dark:bg-zinc-900">
      <p className="shrink-0 px-5 pb-2 pt-4 text-xs font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Sections</p>
      <nav className="min-h-0 flex-1 overflow-y-auto pb-3">
        {sections.map((s) => {
          const done = s.status === "reviewed" || s.status === "ready";
          const active = activeKey === s.section_key;
          return (
            <button
              key={s.section_key}
              onClick={() => onJump(s.section_key)}
              className={`flex w-full items-center gap-3 px-5 py-2.5 text-left text-[17px] font-semibold transition-colors ${
                active ? "bg-amber-50 dark:bg-amber-950/30" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
              } ${done ? "text-zinc-700 dark:text-zinc-200" : "text-orange-600 dark:text-orange-400"}`}
            >
              {done ? (
                <CircleCheck className={`h-5 w-5 shrink-0 ${s.status === "reviewed" ? "text-green-600" : "text-zinc-400"}`} />
              ) : (
                <PencilLine className="h-5 w-5 shrink-0 text-orange-500" />
              )}
              <span className="truncate">{s.heading}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

const READY_LABEL: Record<string, { text: string; className: string }> = {
  reviewed: { text: "Reviewed", className: "text-green-600 dark:text-green-400" },
  ready: { text: "Ready", className: "text-green-600 dark:text-green-400" },
  editing: { text: "Edited", className: "text-amber-600 dark:text-amber-400" },
  generating: { text: "Generating…", className: "text-blue-600 dark:text-blue-400" },
  pending: { text: "Not generated", className: "text-zinc-400" },
};

/**
 * Everything you can do to the section you're in. Grouping the tools here rather
 * than repeating a control strip above each section is what lets the document
 * read as a document.
 */
function SectionTools({
  section, canRewrite, reviewing, rewriting, regenerating, onMarkReviewed, onRewrite, onRegenerate,
}: {
  section: Section | null;
  canRewrite: boolean;
  reviewing: boolean;
  rewriting: boolean;
  regenerating: boolean;
  onMarkReviewed: (reviewed: boolean) => void;
  onRewrite: (payload: { preset?: string; instruction?: string }) => void;
  onRegenerate: () => void;
}) {
  const [instr, setInstr] = useState("");
  const busy = reviewing || rewriting || regenerating;

  if (!section) {
    return (
      <div className="rounded-2xl bg-blue-50/70 p-5 text-sm text-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200/60">
        <p className="text-xs font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Section tools</p>
        <p className="mt-2">Select a section to review or revise it.</p>
      </div>
    );
  }

  const isReviewed = section.status === "reviewed";
  const ready = READY_LABEL[section.status] ?? READY_LABEL.pending;

  const submitFreeform = () => {
    const text = instr.trim();
    if (!text) return;
    onRewrite({ instruction: text });
    setInstr("");
  };

  return (
    <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto rounded-2xl bg-blue-50/70 p-5 dark:bg-blue-950/30">
      <p className="text-xs font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Section tools</p>

      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[17px] font-semibold text-zinc-800 dark:text-zinc-100">{section.heading}</h3>
        {/* While the model is replacing the text, the greyed-out section says
            something is happening but not what. Name it here, beside the section
            it applies to, so a slow regenerate doesn't read as a hang. */}
        {regenerating || rewriting ? (
          <span role="status" className="flex items-center gap-1.5 text-sm font-medium text-blue-600 dark:text-blue-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            {regenerating ? "Regenerating…" : "Rewriting…"}
          </span>
        ) : (
          <span className={`flex items-center gap-1 text-sm font-medium ${ready.className}`}>
            <CheckCircle2 className="h-4 w-4" /> {ready.text}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onMarkReviewed(!isReviewed)}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-sm font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:opacity-50 dark:bg-zinc-900 dark:text-zinc-200"
        >
          {reviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CircleCheck className={`h-4 w-4 ${isReviewed ? "text-green-600" : "text-zinc-400"}`} />}
          {isReviewed ? "Reviewed" : "Mark Reviewed"}
        </button>
        <button
          onClick={onRegenerate}
          disabled={busy}
          title="Regenerate this section from the sources"
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-zinc-500 hover:bg-white/70 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-900/60"
        >
          {regenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Regenerate
        </button>
      </div>

      {canRewrite ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">Rewrite suggestions</p>
          <div className="flex flex-wrap gap-2">
            {REWRITE_CHIP_ORDER.map((key) => {
              const preset = REWRITE_PRESETS[key];
              return (
                <span
                  key={key}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-1 text-sm text-zinc-700 shadow-sm dark:bg-zinc-900 dark:text-zinc-200"
                >
                  <button
                    onClick={() => onRewrite({ preset: key })}
                    disabled={busy}
                    title={`More ${preset.chipLabel ?? preset.label}`}
                    aria-label={`More ${preset.chipLabel ?? preset.label}`}
                    className="text-violet-500 hover:text-violet-700 disabled:opacity-40"
                  >
                    <CirclePlus className="h-4 w-4" />
                  </button>
                  {preset.chipLabel ?? preset.label}
                  <button
                    onClick={() => preset.lessInstruction && onRewrite({ instruction: preset.lessInstruction })}
                    disabled={busy || !preset.lessInstruction}
                    title={`Less ${preset.chipLabel ?? preset.label}`}
                    aria-label={`Less ${preset.chipLabel ?? preset.label}`}
                    className="text-violet-500 hover:text-violet-700 disabled:opacity-40"
                  >
                    <CircleMinus className="h-4 w-4" />
                  </button>
                </span>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 shadow-sm dark:bg-zinc-900">
            <PencilLine className="h-4 w-4 shrink-0 text-violet-500" />
            <input
              value={instr}
              onChange={(e) => setInstr(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitFreeform(); }}
              placeholder="Try any request"
              disabled={busy}
              className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-400 disabled:opacity-50"
            />
            <button onClick={submitFreeform} disabled={busy || !instr.trim()} aria-label="Send" className="shrink-0 text-violet-600 disabled:opacity-40">
              {rewriting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </button>
          </div>
        </>
      ) : (
        <p className="text-sm text-blue-900/60 dark:text-blue-200/60">
          This section isn&apos;t rewritten by the model. Regenerate it to pick up changes.
        </p>
      )}
    </div>
  );
}

export function ReportEditor({ groupId }: { groupId: string }) {
  const [report, setReport] = useState<{ title?: string } | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<string | null>(null); // "all" | section_key
  const [tool, setTool] = useState<{ key: string; kind: "review" | "rewrite" } | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateKey, setTemplateKey] = useState("general_report");
  const [docVersion, setDocVersion] = useState(0);
  // Per-section remount counters. Regenerating or rewriting ONE section used to
  // bump the shared docVersion, which keyed the whole container and therefore
  // tore down and rebuilt every section's editor.
  const [sectionVersions, setSectionVersions] = useState<Record<string, number>>({});
  // Sections whose live editor has been mounted. Empty on open: nothing is a
  // ProseMirror instance until the user clicks into it.
  const [liveKeys, setLiveKeys] = useState<Set<string>>(() => new Set());
  // Focus mode: the document full-screen, outline and tools hidden.
  const [focus, setFocus] = useState(false);
  const editors = useRef<Map<string, Editor>>(new Map());

  const bumpSection = useCallback((key: string) => {
    setSectionVersions((v) => ({ ...v, [key]: (v[key] ?? 0) + 1 }));
  }, []);
  const goLive = useCallback((key: string) => {
    setLiveKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  const register = useCallback((key: string, e: Editor | null) => {
    if (e) editors.current.set(key, e);
    else editors.current.delete(key);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setActiveEditor(null);
    try {
      const res = await fetch(`/api/report/${groupId}`, { cache: "no-store" });
      const data = await res.json();
      setReport(data.report ?? null);
      setSections(data.sections ?? []);
      if (Array.isArray(data.templates)) setTemplates(data.templates);
      setLiveKeys(new Set());
      setDocVersion((v) => v + 1);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { load(); }, [load]);

  const generateAll = async () => {
    setGenerating("all");
    setActiveEditor(null);
    try {
      const res = await fetch(`/api/report/${groupId}/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateKey }) });
      const data = await res.json();
      if (res.ok) {
        setReport(data.report ?? report);
        setSections(data.sections ?? []);
        setLiveKeys(new Set());
        setDocVersion((v) => v + 1);
      }
    } finally {
      setGenerating(null);
    }
  };

  const regenerate = async (key: string) => {
    setGenerating(key);
    setActiveEditor(null);
    try {
      const res = await fetch(`/api/report/${groupId}/section/${key}/generate`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setSections(data.sections ?? sections);
        bumpSection(key); // remount only this section's editor
      }
    } finally {
      setGenerating(null);
    }
  };

  // Mark reviewed changes only status — update in place without remounting editors.
  const markReviewed = async (key: string, reviewed: boolean) => {
    setTool({ key, kind: "review" });
    setToolError(null);
    try {
      const res = await fetch(`/api/report/${groupId}/section/${key}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewed }) });
      const data = await res.json();
      if (res.ok) setSections(data.sections ?? sections);
      else setToolError(data.error ?? "Couldn't update review status.");
    } finally {
      setTool(null);
    }
  };

  // Rewrite replaces content — remount editors so the new text shows.
  const rewrite = async (key: string, payload: { preset?: string; instruction?: string }) => {
    setTool({ key, kind: "rewrite" });
    setToolError(null);
    setActiveEditor(null);
    try {
      const res = await fetch(`/api/report/${groupId}/section/${key}/rewrite`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (res.ok) {
        setSections(data.sections ?? sections);
        bumpSection(key); // remount only this section's editor
      } else {
        setToolError(data.error ?? "The rewrite didn't go through.");
      }
    } finally {
      setTool(null);
    }
  };

  const save = useCallback(async (key: string, json: object) => {
    // Mirror the edit into local state as well as persisting it. Sections that
    // aren't mounted render (and export) from content_json, so it has to reflect
    // what the user just typed.
    setSections((prev) => prev.map((s) => (s.section_key === key ? { ...s, content_json: json as Section["content_json"] } : s)));
    await fetch(`/api/report/${groupId}/section/${key}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contentJson: json }) }).catch(() => {});
  }, [groupId]);

  const jumpTo = (key: string) => {
    document.getElementById(`section-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    goLive(key); // jumping to a section is an intent to edit it
    const ed = editors.current.get(key);
    if (ed) { ed.commands.focus(); setActiveEditor(ed); }
    setActiveKey(key);
  };

  const exportReport = () => {
    // Serialize from stored JSON, not from mounted editors — with lazy mounting
    // most sections have no editor instance, and `save` keeps content_json in
    // sync with anything the user has typed.
    const parts: string[] = [];
    for (const s of sections) {
      const html = tiptapToHtml(s.content_json as PMDoc | null);
      parts.push(`<h2>${s.heading}</h2>${html}`);
    }
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${report?.title ?? "Report"}</title>
      <style>body{font-family:Georgia,serif;max-width:800px;margin:2rem auto;padding:0 1rem;color:#111} h1{text-align:center} h2{margin-top:1.5rem;border-bottom:1px solid #ddd;padding-bottom:.25rem} table{border-collapse:collapse;width:100%} td,th{border:1px solid #999;padding:4px 8px} th{background:#f4f4f5;text-align:left} img{max-width:100%;height:auto}</style>
      </head><body><h1>${report?.title ?? "Report"}</h1>${parts.join("\n")}</body></html>`;
    const w = window.open("", "_blank");
    if (w) { w.document.write(doc); w.document.close(); w.focus(); w.print(); }
  };

  const hasContent = sections.some((s) => s.content_json && s.content_json.type === "doc");
  const activeSection = sections.find((s) => s.section_key === activeKey) ?? null;

  // Esc leaves focus mode. Registered in the CAPTURE phase and stopped there:
  // the document modal has its own document-level Esc handler that navigates back,
  // so without this the first Esc would close the entire modal rather than the
  // overlay on top of it.
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setFocus(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [focus]);

  if (loading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading report…</div>;
  }

  return (
    <div
      className={
        focus
          ? "fixed inset-0 z-[80] flex flex-col gap-3 bg-zinc-100 p-3 dark:bg-zinc-900"
          : "flex h-full min-h-0 flex-col gap-3 lg:flex-row"
      }
    >
      {/* The page */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-white shadow-sm dark:bg-zinc-950">
        {/* The bar carries the focus toggle at all times; formatting appears
            only once a section has focus, so the resting state stays the
            document itself. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-100 px-4 py-1.5 dark:border-zinc-800">
          {activeEditor ? <Toolbar editor={activeEditor} /> : <span className="text-sm text-zinc-400">Click a section to edit it</span>}
          <button
            type="button"
            onClick={() => setFocus((v) => !v)}
            aria-pressed={focus}
            title={focus ? "Exit focus mode (Esc)" : "Focus mode — the document, full screen"}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            {focus ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            <span className="hidden sm:inline">{focus ? "Exit focus" : "Focus"}</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-12">
          {toolError && (
            <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300">{toolError}</p>
          )}

          <div className="mb-8 text-center">
            <h1 className="mt-2 text-[38px] font-bold leading-tight text-zinc-900 dark:text-zinc-100">
              {report?.title ?? "Report"}
            </h1>
          </div>

          {!hasContent ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
              {generating === "all" ? (
                <>
                  <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
                  <p className="text-sm text-zinc-600 dark:text-zinc-300">Generating your report…</p>
                  <p className="text-xs text-zinc-400">Drafting each section from the sources. This can take a moment.</p>
                </>
              ) : (
                <>
                  <FileText className="h-8 w-8 text-zinc-300" />
                  <p className="text-sm text-zinc-600 dark:text-zinc-300">
                    {report ? "This report has no content yet." : "Choose an outline and draft the report from the sources."}
                  </p>
                  {!report && templates.length > 1 && (
                    <select
                      value={templateKey}
                      onChange={(e) => setTemplateKey(e.target.value)}
                      aria-label="Report outline"
                      className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      {templates.map((t) => (
                        <option key={t.key} value={t.key}>{t.title}</option>
                      ))}
                    </select>
                  )}
                  <button onClick={generateAll} className="flex items-center gap-2 rounded-full bg-teal-600 px-4 py-2 text-sm font-medium text-white">
                    <Sparkles className="h-4 w-4" /> Generate
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-7">
              {sections.map((s) => (
                <SectionEditor
                  // docVersion changes only on a full reload/regenerate-all;
                  // sectionVersions[key] on a single-section regenerate or rewrite.
                  key={`${docVersion}:${s.section_key}:${sectionVersions[s.section_key] ?? 0}`}
                  section={s}
                  live={liveKeys.has(s.section_key)}
                  busy={generating === s.section_key || (tool?.kind === "rewrite" && tool.key === s.section_key)}
                  onMount={() => goLive(s.section_key)}
                  onActive={setActiveEditor}
                  onActivate={setActiveKey}
                  onSave={save}
                  register={register}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Outline above, tools below — the outline scrolls, the tools stay put.
          Focus mode hides the whole column: the point is the document alone. */}
      <aside className={`min-h-0 w-full shrink-0 flex-col gap-3 lg:w-[23rem] ${focus ? "hidden" : "flex"}`}>
        <div className="flex min-h-0 flex-[2] flex-col">
          <SectionsPanel sections={sections} activeKey={activeKey} onJump={jumpTo} />
        </div>
        <div className="flex min-h-0 flex-[3] flex-col">
          <SectionTools
            section={activeSection}
            canRewrite={!!activeSection?.rewritable}
            reviewing={tool?.kind === "review" && tool.key === activeKey}
            rewriting={tool?.kind === "rewrite" && tool.key === activeKey}
            regenerating={!!activeKey && generating === activeKey}
            onMarkReviewed={(reviewed) => activeKey && markReviewed(activeKey, reviewed)}
            onRewrite={(payload) => activeKey && rewrite(activeKey, payload)}
            onRegenerate={() => activeKey && regenerate(activeKey)}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={generateAll} disabled={!!generating} className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-teal-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
            {generating === "all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Regenerate all
          </button>
          <button onClick={exportReport} disabled={!hasContent} className="flex items-center gap-1.5 rounded-full border border-zinc-300 px-3 py-2 text-sm text-zinc-600 hover:border-teal-400 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300">
            <Download className="h-4 w-4" /> Export
          </button>
        </div>
      </aside>
    </div>
  );
}
