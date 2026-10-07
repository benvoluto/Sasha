"use client";

// The document workspace. Two modes:
//
//   Info    a persistent left rail (title, the sticky-note summary, the
//           assistant) beside a right column that shows either the section
//           overview or one section drilled into.
//   Report  the document itself, with its outline and section tools.
//
// The rail is the point: the summary and the assistant sit beside every
// section, so consulting either never means leaving what you were reading.

import { useSearchParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, XCircle, Archive, Loader2, CloudUpload, Boxes, ListChecks, Workflow } from "@/components/icons";
import { AddDocsButton } from "@/components/add-docs-button";
import { useSetAtom } from "jotai";
import { archiveUploadGroupAtom, type UploadGroup } from "@/lib/atoms";
import { addJob } from "@/lib/processing-jobs";
import { documentTitle } from "@/lib/case-state";
import { CaseAssistant } from "@/components/case-assistant";
import { ReportEditor } from "@/components/report-editor";
import { SummaryNote } from "@/components/summary-note";
import { ModeSwitch, type CaseMode } from "@/components/case-shell";
import { SectionCard, SectionPanel, type SectionKey } from "@/components/case-sections";
import { SuggestionList, saveSuggestionEdit, useCatalog, visibleSuggestions } from "@/components/suggestion-list";
import { applyAction, editsOf, emptyEdits, type SuggestionAction, type SuggestionEdits, type SuggestionKind } from "@/lib/case-suggestions";

const RAIL_ACTION = "flex items-center gap-2.5 text-[15px] font-medium text-fuchsia-600 hover:text-fuchsia-700 dark:text-fuchsia-400 disabled:opacity-50";

// Suggested sources and data come from document types in a later phase; for
// now only the items people add by hand show up.
const NO_SUGGESTIONS: string[] = [];

export function CaseDetailView({ groupId, variant = "page" }: { groupId: string; variant?: "page" | "modal" }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const archiveGroup = useSetAtom(archiveUploadGroupAtom);
  // Close returns to the list: back out of the modal, or navigate for the full page.
  const close = () => (variant === "modal" ? router.back() : router.push("/"));

  const [group, setGroup] = useState<UploadGroup | null>(null);
  const [mode, setMode] = useState<CaseMode>(() => (searchParams.get("mode") === "report" || searchParams.get("tab") === "report" ? "report" : "case"));
  const [section, setSection] = useState<SectionKey | null>(() => {
    const s = searchParams.get("section") ?? searchParams.get("tab");
    return s === "documents" || s === "suggestions" ? s : null;
  });
  const [loading, setLoading] = useState(true);
  // Distinct from `loading`: a post-mutation refresh keeps the section rendered.
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const catalog = useCatalog();
  // The team's dismissed and added suggestions. Changed here first, then saved in order.
  const [edits, setEdits] = useState<SuggestionEdits>(emptyEdits);
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  // `quiet` refreshes in place after a mutation without blanking the body.
  const load = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    try {
      const [groupRes, editsRes] = await Promise.all([
        fetch(`/api/upload-groups/${groupId}`, { cache: "no-store" }),
        fetch(`/api/cases/${groupId}/suggestions`, { cache: "no-store" }),
      ]);
      if (editsRes.ok) setEdits(editsOf(await editsRes.json()));
      const groupData = await groupRes.json().catch(() => ({}));
      setGroup((groupData.group as UploadGroup | undefined) ?? null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [groupId]);

  useEffect(() => {
    load();
  }, [load]);

  // While the files are being read, refresh quietly so the view reflects
  // progress and settles on its own when the background work finishes.
  const isProcessing = group?.geminiProcessing?.status === "processing";
  useEffect(() => {
    if (!isProcessing) return;
    const id = setInterval(() => load(true), 4000);
    return () => clearInterval(id);
  }, [isProcessing, load]);

  // The document's latest workflow run, for the link to watch it on the canvas.
  const [workflowRun, setWorkflowRun] = useState<WorkflowRunBrief | null>(null);
  const loadRun = useCallback(async () => {
    const res = await fetch(`/api/workflow-runs/runs?groupId=${encodeURIComponent(groupId)}&brief=1`, { cache: "no-store" }).catch(() => null);
    if (res?.ok) setWorkflowRun((await res.json()).run ?? null);
  }, [groupId]);
  // A workflow chosen at upload starts once the files are read; keep checking until it has.
  const workflowPending = isProcessing && !!group?.autoWorkflow?.workflowId;
  useEffect(() => {
    loadRun();
    if (!workflowPending && workflowRun?.status !== "running") return;
    const id = setInterval(loadRun, 5000);
    return () => clearInterval(id);
  }, [loadRun, workflowPending, workflowRun?.status]);

  const title = documentTitle(group) || (loading ? "Loading…" : "Untitled document");

  /** Remove one uploaded file (a duplicate, or one added by mistake). */
  const deleteFile = async (file: { name: string; url?: string }) => {
    if (!file.url) return;
    if (!confirm(`Remove "${file.name}" from this document?\n\nThe remaining files will be re-read.`)) return;
    setMsg(null);
    setBusy(`doc:${file.url}`);
    try {
      const res = await fetch(`/api/cases/${groupId}/documents`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: file.url }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        addJob({ groupId, label: title, kind: "remove", files: [] });
        setMsg(`Removed ${file.name}. Re-reading the remaining files…`);
        await load(true);
      } else {
        setMsg(`Error: ${data.error ?? res.status}`);
      }
    } finally {
      setBusy(null);
    }
  };

  /** Archive, not delete: the document moves to the Archived view intact and can be restored. */
  const archiveDocument = () => {
    if (!confirm("Archive this document?\n\nIt leaves your list but is not deleted — you can restore it from Archived at any time.")) return;
    // Optimistic: hide it and return to the list immediately. The PATCH runs in
    // the background and rolls the document back into the list if it fails.
    void archiveGroup(groupId);
    // Close the way the modal's own Close does: from the intercepted modal route a
    // push to "/" is a soft navigation that leaves the modal slot showing.
    close();
  };

  // Keep the whole file record: deleting a duplicate needs its URL, since two
  // uploads of the same file share a name and differ only by URL.
  const files = (group?.files ?? []).filter((f) => f.name);
  const nameCounts = files.reduce<Record<string, number>>((acc, f) => {
    acc[f.name] = (acc[f.name] ?? 0) + 1;
    return acc;
  }, {});
  const shownSources = visibleSuggestions(NO_SUGGESTIONS, edits, "sources");
  const shownData = visibleSuggestions(NO_SUGGESTIONS, edits, "data");
  const onSuggestion = (kind: SuggestionKind) => async (action: SuggestionAction, name: string) => {
    setEdits((e) => applyAction(e, kind, action, name));
    // One save at a time, in the order they were made, so a quick second edit can't race the first.
    const save = saving.current.then(() => saveSuggestionEdit(groupId, kind, action, name));
    saving.current = save.catch(() => undefined);
    try {
      setEdits(await save);
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
      setEdits((x) => applyAction(x, kind, action === "dismiss" ? "restore" : action === "restore" ? "dismiss" : action === "add" ? "remove" : "add", name));
    }
  };

  // The generated summary is stale while the files are being (re)read.
  const summarizing = isProcessing || (!!busy && busy !== "archive");

  // Both variants need a DEFINITE height, not a minimum: the rail's assistant
  // sizes itself from the space left over, and `flex-1 min-h-0` resolves to
  // nothing useful inside a container that is only min-height constrained.
  // The page variant subtracts its wrapper's py-8.
  const rootClass =
    "rounded-3xl bg-zinc-100 dark:bg-zinc-900 shadow-sm border border-zinc-200/70 dark:border-zinc-800 overflow-hidden flex flex-col min-h-0 w-full" +
    (variant === "modal" ? " max-h-full" : " h-[calc(100vh-4rem)]");

  // ---- Report mode ------------------------------------------------------
  if (mode === "report") {
    return (
      <div className={rootClass}>
        <div className="shrink-0 px-5 py-4">
          <ModeSwitch
            mode={mode}
            onMode={setMode}
            onClose={close}
            trailing={<span className="truncate text-xl font-semibold text-zinc-600 dark:text-zinc-300">{title}</span>}
          />
        </div>
        <div className="min-h-0 flex-1 px-4 pb-4 sm:px-5 sm:pb-5">
          <ReportEditor groupId={groupId} />
        </div>
      </div>
    );
  }

  // ---- Info mode --------------------------------------------------------
  const documentsBody = (
    <div className="flex flex-col gap-2">
      {msg && <p className={`text-sm ${msg.startsWith("Error") ? "text-red-600" : "text-green-700 dark:text-green-400"}`}>{msg}</p>}
      {files.length === 0 ? <p className="text-sm text-zinc-500">No files uploaded yet.</p> : files.map((f, i) => {
        const duplicate = nameCounts[f.name] > 1;
        return (
          <div key={f.url ?? i} className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${duplicate ? "border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/10" : "border-zinc-200 dark:border-zinc-800"}`}>
            <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
            <span className="truncate text-zinc-700 dark:text-zinc-200">{f.name}</span>
            {duplicate ? (
              <span className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300" title="This filename appears more than once on the document">
                duplicate
              </span>
            ) : null}
            <button
              onClick={() => deleteFile(f)}
              disabled={busy === `doc:${f.url}`}
              aria-label={`Remove ${f.name}`}
              title="Remove this file from the document"
              className="ml-auto shrink-0 rounded-md p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 disabled:opacity-50"
            >
              {busy === `doc:${f.url}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
            </button>
          </div>
        );
      })}
    </div>
  );

  const suggestionsBody = (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-wide text-zinc-400">Sources to find</p>
        <SuggestionList
          kind="sources"
          suggested={NO_SUGGESTIONS}
          edits={edits}
          onAction={onSuggestion("sources")}
          options={catalog.sources}
          empty="No sources suggested yet."
        />
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-wide text-zinc-400">Data to gather</p>
        <SuggestionList
          kind="data"
          suggested={NO_SUGGESTIONS}
          edits={edits}
          onAction={onSuggestion("data")}
          options={catalog.data}
          empty="No data suggested yet."
        />
      </div>
    </div>
  );

  const SECTIONS = {
    documents: { tone: "documents" as const, title: "Sources", Icon: Boxes, badge: String(files.length), body: documentsBody },
    suggestions: { tone: "suggestions" as const, title: "Suggestions", Icon: ListChecks, badge: String(shownSources.length + shownData.length), body: suggestionsBody },
  };

  const open = section ? SECTIONS[section] : null;

  return (
    <div className={rootClass}>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Left rail — present in every section, which is the point. */}
        {/* A flex column, not a scroll container: the rail itself never
            scrolls, so the assistant's composer stays pinned to the bottom
            margin however long the conversation gets. */}
        <aside className="flex min-h-0 w-full shrink-0 flex-col gap-5 px-5 py-4 lg:w-[21rem]">
          <ModeSwitch mode={mode} onMode={setMode} onClose={close} />

          <div>
            <h1 className="text-[28px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100">{title}</h1>
            {group?.uploadDate ? (
              <p className="mt-2 text-[15px] text-zinc-600 dark:text-zinc-400">
                Created {new Date(group.uploadDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2.5">
            <AddDocsButton groupId={groupId} documentName={title} onDone={() => load(true)} className={RAIL_ACTION} icon={<CloudUpload className="h-5 w-5" />} label="Upload sources" />
            <WorkflowRunLink groupId={groupId} run={workflowRun} pending={workflowPending} />
            <button onClick={archiveDocument} disabled={busy === "archive"} className={RAIL_ACTION}>
              {busy === "archive" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Archive className="h-5 w-5" />}
              Archive document
            </button>
            {refreshing ? (
              <span className="flex items-center gap-2 text-xs text-zinc-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Refreshing…</span>
            ) : null}
          </div>

          {/* Capped so a long summary can't starve the assistant of the space
              it needs; it scrolls inside its own note instead. */}
          <SummaryNote
            groupId={groupId}
            note={group?.summaryNote}
            generated={undefined}
            summarizing={summarizing}
            onSaved={() => load(true)}
            className="max-h-[40%] shrink-0 overflow-y-auto"
          />

          {/* The assistant takes whatever height is left, down to the rail's
              bottom padding. */}
          <div className="flex min-h-[16rem] flex-1 flex-col gap-2.5">
            <h2 className="flex shrink-0 items-center gap-2 text-[17px] font-semibold text-zinc-700 dark:text-zinc-200">
              <MessageIcon /> Assistant
            </h2>
            <CaseAssistant groupId={groupId} variant="rail" />
          </div>
        </aside>

        {/* Right column — overview cards, or one section drilled into. */}
        <main className={`flex min-h-0 flex-1 flex-col ${open ? "rounded-l-3xl bg-white dark:bg-zinc-950" : "overflow-y-auto px-4 py-4 sm:px-5"}`}>
          {isProcessing && !loading ? (
            <div className={`flex items-start gap-2.5 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900/40 dark:bg-blue-900/20 ${open ? "mx-6 mt-5" : "mb-4"}`}>
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
              <div className="text-sm text-blue-800 dark:text-blue-300">
                <p className="font-medium">Reading {files.length} file{files.length === 1 ? "" : "s"}…</p>
                <p className="text-blue-700/80 dark:text-blue-300/80">
                  Extracting the text of the uploaded files. This updates on its own — no need to upload again.
                </p>
              </div>
            </div>
          ) : null}

          {loading ? (
            <p className="flex items-center gap-2 p-6 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading document…</p>
          ) : open ? (
            <SectionPanel tone={open.tone} badge={open.badge} title={open.title} Icon={open.Icon} onBack={() => setSection(null)}>
              {open.body}
            </SectionPanel>
          ) : (
            <div className="flex flex-col gap-4">
              <SectionCard tone="documents" badge={SECTIONS.documents.badge} title="Sources" Icon={Boxes} onOpen={() => setSection("documents")}>
                <p className="font-semibold text-zinc-800 dark:text-zinc-100">
                  {files.length} uploaded{isProcessing ? " (reading)" : ""}
                </p>
                {files.length > 0 ? <p className="truncate">{files.slice(0, 4).map((f) => f.name).join(", ")}</p> : <p className="text-zinc-500">No files yet</p>}
              </SectionCard>

              <SectionCard tone="suggestions" badge={SECTIONS.suggestions.badge} title="Suggestions" Icon={ListChecks} onOpen={() => setSection("suggestions")}>
                {shownSources.length + shownData.length > 0 ? (
                  <p className="line-clamp-2">{[...shownSources, ...shownData].join(", ")}</p>
                ) : (
                  <p className="text-zinc-500">Sources and data to gather for this document</p>
                )}
              </SectionCard>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/** The speech-bubble mark beside "Assistant". */
function MessageIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-5 w-5 text-zinc-500" aria-hidden>
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.8L3 21l1.9-4.6A8.4 8.4 0 0 1 3.6 11.5a8.4 8.4 0 0 1 8.4-8.4 8.4 8.4 0 0 1 9 8.4Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 10.5h6M9 13.5h4" strokeLinecap="round" />
    </svg>
  );
}

type WorkflowRunBrief = { id: string; status: string; workflow_name: string; workflow_version: number; created_at: string };

const RUN_LINK_LABEL: Record<string, string> = {
  running: "Watch workflow run",
  awaiting_review: "Workflow needs review",
  paused: "Workflow paused",
  draft: "View workflow run",
  failed: "Workflow run failed",
  superseded: "View workflow run",
};

/**
 * Opens the workflow canvas on this document, where its run shows step by
 * step. Shown once the document has a run, and while a workflow chosen at
 * upload is waiting for the files to be read.
 */
function WorkflowRunLink({ groupId, run, pending }: { groupId: string; run: WorkflowRunBrief | null; pending: boolean }) {
  if (!run && !pending) return null;
  const label = run ? (RUN_LINK_LABEL[run.status] ?? "View workflow run") : "Workflow starts after reading";
  return (
    <Link
      href={`/workflows?source=${encodeURIComponent(groupId)}`}
      className={RAIL_ACTION}
      title={run ? `${run.workflow_name} v${run.workflow_version}, started ${new Date(run.created_at).toLocaleString()}` : "The workflow chosen at upload runs once the files are read"}
    >
      <span className="relative">
        <Workflow className="h-5 w-5" />
        {run?.status === "running" || (!run && pending) ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fuchsia-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-fuchsia-500" />
          </span>
        ) : null}
      </span>
      {label}
    </Link>
  );
}
