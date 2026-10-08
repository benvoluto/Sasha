"use client";

// The document-type catalog at /catalog. Everyone on the team can browse the
// types; team admins (settings:write) can also enable or disable them, edit
// them (an edit of a catalog type is the team's override, revertible), create
// team types and delete them. Confirmations are in-page AlertDialogs.

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileText, Loader2, Pencil, Plus, RefreshCw, Search, Trash2 } from "@/components/icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { FAMILIES, type DocumentTypeSummary, type Family } from "@/catalog/schema";
import type { DocumentTypeResponse, DocumentTypesResponse } from "@/lib/sections/contract";
import { catalogApi, CatalogApiError, errorIssues, errorText, FAMILY_LABELS, newTypeTemplate } from "./catalog-api";
import { TypeDetail } from "./type-detail";
import { NewTypeEditor, TypeEditor } from "./type-editor";

const quiet = "inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] disabled:opacity-40";
const primary = "inline-flex items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40";

type Panel = { kind: "view"; key: string } | { kind: "new" } | null;
type Confirm = { kind: "revert" | "delete"; key: string; title: string } | null;

function matches(t: DocumentTypeSummary, q: string): boolean {
  if (!q) return true;
  const hay = `${t.title} ${t.summary} ${t.key} ${t.sections.map((s) => s.heading).join(" ")}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

export function CatalogAdmin() {
  const [types, setTypes] = useState<DocumentTypeSummary[] | null>(null);
  const [admin, setAdmin] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [detail, setDetail] = useState<DocumentTypeResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // Admins get every type, disabled ones included; anyone else gets a 403 and the enabled list.
      const all = await catalogApi<DocumentTypesResponse>("/api/document-types?all=1").catch((e: unknown) => {
        if (e instanceof CatalogApiError && e.status === 403) return null;
        throw e;
      });
      setAdmin(!!all);
      setTypes((all ?? (await catalogApi<DocumentTypesResponse>("/api/document-types"))).types);
    } catch (e) {
      setLoadError(errorText(e, "Couldn't load the document types."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openKey = panel?.kind === "view" ? panel.key : null;
  const loadDetail = useCallback(async (key: string) => {
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await catalogApi<DocumentTypeResponse>(`/api/document-types/${encodeURIComponent(key)}`));
    } catch (e) {
      setDetailError(errorText(e, "Couldn't load this type."));
    }
  }, []);

  useEffect(() => {
    if (openKey) void loadDetail(openKey);
  }, [openKey, loadDetail]);

  const resetForm = () => {
    setEditing(false);
    setSaveError(null);
    setIssues([]);
  };

  const close = () => {
    setPanel(null);
    setDetail(null);
    resetForm();
  };

  const groups = useMemo(() => {
    const visible = (types ?? []).filter((t) => matches(t, query.trim()));
    return FAMILIES.map((f) => ({ family: f as Family, items: visible.filter((t) => t.family === f) })).filter((g) => g.items.length);
  }, [types, query]);

  const toggle = async (t: DocumentTypeSummary, enabled: boolean) => {
    setToggling(t.key);
    setTypes((ts) => ts?.map((x) => (x.key === t.key ? { ...x, enabled } : x)) ?? ts);
    try {
      await catalogApi(`/api/document-types/${encodeURIComponent(t.key)}`, { method: "PATCH", json: { enabled } });
      setNotice(`${t.title} ${enabled ? "enabled" : "disabled"}.`);
    } catch (e) {
      setTypes((ts) => ts?.map((x) => (x.key === t.key ? { ...x, enabled: !enabled } : x)) ?? ts);
      setNotice(errorText(e, "Couldn't change that type."));
    } finally {
      setToggling(null);
    }
  };

  const save = async (definition: unknown) => {
    if (!openKey) return;
    setBusy(true);
    setSaveError(null);
    setIssues([]);
    try {
      await catalogApi(`/api/document-types/${encodeURIComponent(openKey)}`, { method: "PUT", json: { definition } });
      resetForm();
      setNotice("Saved.");
      await Promise.all([load(), loadDetail(openKey)]);
    } catch (e) {
      setSaveError(errorText(e, "Couldn't save the type."));
      setIssues(errorIssues(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async (definition: unknown) => {
    setBusy(true);
    setSaveError(null);
    setIssues([]);
    try {
      const { type } = await catalogApi<{ type: DocumentTypeSummary }>("/api/document-types", { method: "POST", json: { definition } });
      resetForm();
      setNotice(`Created ${type.title}.`);
      await load();
      setPanel({ kind: "view", key: type.key });
    } catch (e) {
      setSaveError(errorText(e, "Couldn't create the type."));
      setIssues(errorIssues(e));
    } finally {
      setBusy(false);
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    const { kind, key, title } = confirm;
    setConfirm(null);
    setBusy(true);
    try {
      await catalogApi(`/api/document-types/${encodeURIComponent(key)}`, { method: "DELETE" });
      setNotice(kind === "delete" ? `Deleted ${title}.` : `${title} reverted to the catalog version.`);
      if (kind === "delete") close();
      else {
        resetForm();
        await loadDetail(key);
      }
      await load();
    } catch (e) {
      setNotice(errorText(e, "That didn't work."));
    } finally {
      setBusy(false);
    }
  };

  const meta = detail?.meta;
  return (
    <div className="doc-screen min-h-screen bg-[var(--doc-bg)] text-[var(--doc-ink)]">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 pb-6 pt-6 sm:px-10 sm:pt-8">
        <div className="flex min-w-0 items-center gap-5">
          <Link href="/" className="text-[22px] font-semibold tracking-tight">
            Sasha
          </Link>
          <nav aria-label="Sections" className="flex items-center gap-1 text-[15px] font-medium">
            <Link href="/" className="rounded-full px-3 py-1.5 text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] hover:text-[var(--doc-ink)]">
              Write
            </Link>
            <Link href="/library" className="rounded-full px-3 py-1.5 text-[var(--doc-muted)] hover:bg-[var(--doc-accent-soft)] hover:text-[var(--doc-ink)]">
              Sources
            </Link>
            <span aria-current="page" className="rounded-full bg-[var(--doc-surface)] px-3 py-1.5 text-[var(--doc-accent)] shadow-sm">
              Document types
            </span>
          </nav>
        </div>
        <div className="grid h-11 w-11 place-items-center">
          <UserButton />
        </div>
      </header>

      <main className="mx-2 mb-10 min-h-[75vh] overflow-hidden rounded-2xl bg-[var(--doc-surface)] shadow-[0_1px_3px_rgba(16,24,40,0.06),0_8px_24px_rgba(16,24,40,0.05)] sm:mx-10">
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--doc-line)] px-4 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">Document types</h1>
            <p className="text-sm text-[var(--doc-muted)]">
              {admin ? "Choose which types your team can pick, and edit them to fit how you write." : "Ask a team admin to change document types."}
            </p>
          </div>
          <label className="relative block w-full sm:w-64">
            <span className="sr-only">Search document types</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--doc-muted)]" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search types"
              className="w-full rounded-md border border-[var(--doc-line)] bg-transparent py-1.5 pl-8 pr-2.5 text-sm outline-none focus:border-[var(--doc-accent)]"
            />
          </label>
          {admin && (
            <button
              type="button"
              className={primary}
              onClick={() => {
                resetForm();
                setPanel({ kind: "new" });
              }}
            >
              <Plus className="h-4 w-4" /> New type
            </button>
          )}
        </div>

        {notice && (
          <div role="status" className="flex items-center justify-between gap-2 border-b border-[var(--doc-line)] bg-[var(--doc-accent-soft)] px-4 py-2 text-sm sm:px-6">
            <span>{notice}</span>
            <button type="button" className={quiet} onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}

        <div className="px-4 py-4 sm:px-6">
          {loadError ? (
            <div role="alert" className="flex items-center gap-3 text-sm text-red-600 dark:text-red-400">
              {loadError}
              <button type="button" className={quiet} onClick={() => void load()}>
                <RefreshCw className="h-4 w-4" /> Retry
              </button>
            </div>
          ) : !types ? (
            <div className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading document types…
            </div>
          ) : !groups.length ? (
            <p className="text-sm text-[var(--doc-muted)]">{query ? "No types match that search." : "No document types yet."}</p>
          ) : (
            <div className="space-y-8">
              {groups.map((g) => (
                <section key={g.family} aria-label={FAMILY_LABELS[g.family]}>
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--doc-muted)]">{FAMILY_LABELS[g.family]}</h2>
                  <ul className="divide-y divide-[var(--doc-line)] rounded-xl border border-[var(--doc-line)]">
                    {g.items.map((t) => (
                      <li key={t.key} className={`flex items-start gap-3 px-3 py-3 ${t.enabled ? "" : "opacity-60"}`}>
                        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--doc-muted)]" />
                        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setPanel({ kind: "view", key: t.key })}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium hover:underline">{t.title}</span>
                            <Badge variant="outline">{t.origin === "team" ? "Team" : "Catalog"}</Badge>
                            {t.overridden && <Badge variant="secondary">Edited</Badge>}
                            {!t.enabled && <Badge variant="secondary">Disabled</Badge>}
                            <span className="text-xs text-[var(--doc-muted)]">
                              {t.sections.length} section{t.sections.length === 1 ? "" : "s"}
                            </span>
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-sm text-[var(--doc-muted)]">{t.summary}</p>
                        </button>
                        <Switch
                          checked={t.enabled}
                          disabled={!admin || toggling === t.key}
                          onCheckedChange={(v) => void toggle(t, v)}
                          aria-label={`${t.enabled ? "Disable" : "Enable"} ${t.title}`}
                          className="mt-1"
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </main>

      <Sheet open={!!panel} onOpenChange={(open) => !open && close()}>
        <SheetContent side="right" className="w-full overflow-y-auto bg-[var(--doc-surface)] text-[var(--doc-ink)] sm:max-w-2xl">
          {panel?.kind === "new" ? (
            <>
              <SheetHeader>
                <SheetTitle>New team type</SheetTitle>
                <SheetDescription>A document type only your team sees.</SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-6">
                <NewTypeEditor template={newTypeTemplate()} busy={busy} error={saveError} issues={issues} onCreate={(d) => void create(d)} onCancel={close} />
              </div>
            </>
          ) : (
            <>
              <SheetHeader>
                <SheetTitle>{detail?.type.title ?? "Document type"}</SheetTitle>
                <SheetDescription>
                  {meta ? `${meta.origin === "team" ? "Team type" : meta.overridden ? "Catalog type, edited by your team" : "Catalog type"} · version ${detail?.type.version}${meta.enabled ? "" : " · disabled"}` : "Loading…"}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-6">
                {detailError && (
                  <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                    {detailError}
                  </p>
                )}
                {!detail && !detailError && (
                  <div className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                  </div>
                )}
                {detail && meta?.editable && !editing && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className={primary} onClick={() => setEditing(true)} disabled={busy}>
                      <Pencil className="h-4 w-4" /> Edit
                    </button>
                    {meta.origin === "file" && meta.overridden && (
                      <button type="button" className={quiet} disabled={busy} onClick={() => setConfirm({ kind: "revert", key: detail.type.key, title: detail.type.title })}>
                        <RefreshCw className="h-4 w-4" /> Revert to catalog
                      </button>
                    )}
                    {meta.origin === "team" && (
                      <button type="button" className={quiet} disabled={busy} onClick={() => setConfirm({ kind: "delete", key: detail.type.key, title: detail.type.title })}>
                        <Trash2 className="h-4 w-4" /> Delete type
                      </button>
                    )}
                  </div>
                )}
                {detail && editing ? (
                  <TypeEditor key={`${detail.type.key}@${detail.type.version}`} initial={detail.type} busy={busy} error={saveError} issues={issues} onSave={(d) => void save(d)} onCancel={resetForm} />
                ) : (
                  detail && <TypeDetail type={detail.type} />
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={!!confirm} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.kind === "delete" ? `Delete ${confirm.title}?` : `Revert ${confirm?.title} to the catalog?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "delete"
                ? "Your team can no longer pick this type. Documents already using it keep their text but lose its guidance."
                : "Your team's edits to this type are discarded and the catalog version is used again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runConfirm()}>{confirm?.kind === "delete" ? "Delete" : "Revert"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
