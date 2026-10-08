"use client";

// Choosing a document type: the header's type picker (grouped by family), the
// gallery dialog for browsing every type, "Save outline as type…", the quiet
// "Start from a type" strip under a new empty document, and creating a new
// document of a type. Types come from GET /api/document-types (the team's
// enabled types: catalog files, team edits and team-made types).

import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Check, CaretUpDown, Loader2, Search, TypesIcon } from "@/components/icons";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FAMILIES, type DocumentTypeSummary, type Family } from "@/catalog/schema";
import { ensureTypes, getTypesState, loadTypes, REVALIDATE_MS, SERVER_STATE, subscribeTypes } from "./document-types-store";

export const FAMILY_LABELS: Record<Family, string> = {
  grant: "Grants",
  business: "Business",
  academic: "Academic",
  technical: "Technical",
  policy: "Policy",
  clinical: "Clinical",
  career: "Career",
  legal: "Legal",
  general: "General",
  other: "Other",
};

// --- The team's types, cached and shared (document-types-store) ------------

/**
 * The team's enabled document types. The list is kept per team and refetched
 * when the team changes, when this mounts with a list older than a few
 * seconds, when the window regains focus, and after any catalog edit;
 * `reload()` refetches now (a type was just saved).
 */
export function useDocumentTypes() {
  const state = useSyncExternalStore(subscribeTypes, getTypesState, () => SERVER_STATE);
  const { isLoaded, orgId, userId } = useAuth();
  // The personal workspace is the user's own team.
  const team = isLoaded ? (orgId ?? userId ?? "anonymous") : null;
  useEffect(() => {
    if (team === null) return;
    void ensureTypes(team, REVALIDATE_MS);
    const revalidate = () => {
      if (document.visibilityState !== "hidden") void ensureTypes(team, REVALIDATE_MS);
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [team]);
  const reload = useCallback(() => (team === null ? Promise.resolve() : loadTypes(team)), [team]);
  return { ...state, reload };
}

/**
 * Keys stored before the catalog (Phase 1 picker, legacy report templates).
 * Mirrors LEGACY_TYPE_ALIASES in src/catalog/files.ts, which isn't imported here
 * because it would ship the whole bundled catalog to the browser.
 */
const LEGACY_KEYS: Record<string, string> = { fie_basic: "fie", general_report: "general-report", memo: "policy-decision-memo" };

/** The type a stored type_key names, following the types' aliases and the legacy keys (as the server's getType does). */
export function findType(types: DocumentTypeSummary[], key: string | null): DocumentTypeSummary | null {
  if (!key) return null;
  return (
    types.find((t) => t.key === key) ??
    types.find((t) => t.aliases.includes(key)) ??
    types.find((t) => t.key === LEGACY_KEYS[key]) ??
    null
  );
}

/** Types grouped by family in catalog order, each group sorted by title. */
export function groupByFamily(types: DocumentTypeSummary[]): Array<{ family: Family; label: string; types: DocumentTypeSummary[] }> {
  return FAMILIES.map((family) => ({
    family,
    label: FAMILY_LABELS[family],
    types: types.filter((t) => t.family === family).sort((a, b) => a.title.localeCompare(b.title)),
  })).filter((g) => g.types.length > 0);
}

/** Creates a document of the type (the server builds its outline) and returns its id. */
export async function createDocumentOfType(typeKey: string): Promise<string> {
  const res = await fetch("/api/documents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type_key: typeKey }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.document?.id) throw new Error(body.error ?? `Couldn't create the document (${res.status}).`);
  return String(body.document.id);
}

// --- Header picker -------------------------------------------------------------

export function TypePicker({
  types,
  value,
  onChange,
  onBrowse,
  onSaveOutline,
}: {
  types: DocumentTypeSummary[];
  value: string | null;
  onChange: (t: DocumentTypeSummary | null) => void;
  onBrowse: () => void;
  /** Omitted when the document has no headings to save. */
  onSaveOutline?: () => void;
}) {
  const current = findType(types, value);
  const groups = groupByFamily(types);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex items-center gap-1 rounded-md px-2 py-1 text-[17px] hover:bg-[var(--doc-accent-soft)]">
          <span className={current || value ? "" : "text-[var(--doc-muted)]"}>{current?.title ?? (value ? "Custom type" : "Choose type")}</span>
          <CaretUpDown className="h-4 w-4 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] min-w-64 overflow-y-auto" onCloseAutoFocus={(e) => e.preventDefault()}>
        {groups.map((g, i) => (
          <div key={g.family}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wider text-[var(--doc-muted)]">{g.label}</DropdownMenuLabel>
            {g.types.map((t) => (
              <DropdownMenuItem key={t.key} onSelect={() => onChange(t)}>
                <Check className={`h-4 w-4 ${t.key === current?.key ? "opacity-100" : "opacity-0"}`} /> {t.title}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
        {groups.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <Check className={`h-4 w-4 ${value ? "opacity-0" : "opacity-100"}`} /> No type (freeform)
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onBrowse}>
          <Search className="h-4 w-4" /> Browse all types…
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!onSaveOutline} onSelect={() => onSaveOutline?.()}>
          <TypesIcon className="h-4 w-4" /> Save outline as type…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Gallery -------------------------------------------------------------------

export function TypeGallery({
  open,
  onOpenChange,
  types,
  loading,
  error,
  current,
  title = "Document types",
  description = "Each type gives the document an outline and tells Claude how to write each section.",
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  types: DocumentTypeSummary[];
  loading?: boolean;
  error?: string | null;
  current?: string | null;
  title?: string;
  description?: string;
  /** Resolves to an error message to show, or nothing when done (the caller closes the dialog). */
  onChoose: (t: DocumentTypeSummary) => Promise<string | void> | string | void;
}) {
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState<Family | "all">("all");
  const [working, setWorking] = useState<string | null>(null);
  const [chooseError, setChooseError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFamily("all");
    setChooseError(null);
    setWorking(null);
  }, [open]);

  const families = useMemo(() => groupByFamily(types).map((g) => g.family), [types]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groupByFamily(types.filter((t) => family === "all" || t.family === family)).map((g) => ({
      ...g,
      types: g.types.filter((t) => !q || [t.title, t.summary, t.key, ...t.sections.map((s) => s.heading)].some((x) => x.toLowerCase().includes(q))),
    })).filter((g) => g.types.length > 0);
  }, [types, family, query]);

  const choose = async (t: DocumentTypeSummary) => {
    setWorking(t.key);
    setChooseError(null);
    try {
      const err = await onChoose(t);
      if (err) setChooseError(err);
    } catch (e) {
      setChooseError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setWorking(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(44rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden rounded-2xl bg-[var(--doc-surface)] p-0 text-[var(--doc-ink)] sm:max-w-3xl">
        <DialogHeader className="space-y-1 border-b border-[var(--doc-line)] px-6 pb-4 pt-6 text-left">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-[var(--doc-muted)]">{description}</DialogDescription>
          <div className="flex flex-wrap items-center gap-2 pt-3">
            <label htmlFor="type-search" className="sr-only">
              Search types
            </label>
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--doc-line)] px-2.5 py-1.5">
              <Search className="h-4 w-4 shrink-0 text-[var(--doc-muted)]" />
              <input id="type-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search types and sections" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            </div>
            <label htmlFor="type-family" className="sr-only">
              Family
            </label>
            <select
              id="type-family"
              value={family}
              onChange={(e) => setFamily(e.target.value as Family | "all")}
              className="rounded-lg border border-[var(--doc-line)] bg-transparent px-2 py-1.5 text-sm"
            >
              <option value="all">All families</option>
              {families.map((f) => (
                <option key={f} value={f}>
                  {FAMILY_LABELS[f]}
                </option>
              ))}
            </select>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {(error || chooseError) && <p className="mb-3 text-sm text-red-600 dark:text-red-400">{chooseError ?? error}</p>}
          {loading && types.length === 0 && (
            <p className="flex items-center gap-2 text-sm text-[var(--doc-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading types…
            </p>
          )}
          {!loading && shown.length === 0 && <p className="text-sm text-[var(--doc-muted)]">{types.length ? "No types match." : "No document types are available."}</p>}
          {shown.map((g) => (
            <section key={g.family} className="mb-5">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--doc-muted)]">{g.label}</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {g.types.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    disabled={!!working}
                    onClick={() => void choose(t)}
                    aria-current={t.key === current ? "true" : undefined}
                    className={`flex flex-col gap-1.5 rounded-xl border p-3 text-left transition hover:border-[var(--doc-accent)] disabled:opacity-60 ${
                      t.key === current ? "border-[var(--doc-accent)] bg-[var(--doc-accent-soft)]" : "border-[var(--doc-line)]"
                    }`}
                  >
                    <span className="flex items-center gap-2 font-medium">
                      {working === t.key && <Loader2 className="h-4 w-4 animate-spin" />}
                      {t.title}
                      {t.origin === "team" && <span className="rounded-full bg-[var(--doc-accent-soft)] px-1.5 text-[11px] font-semibold text-[var(--doc-accent)]">Team</span>}
                    </span>
                    <span className="line-clamp-2 text-xs text-[var(--doc-muted)]">{t.summary}</span>
                    <span className="line-clamp-2 text-xs text-[var(--doc-ink)] opacity-80">
                      {t.sections
                        .filter((s) => s.level <= Math.min(...t.sections.map((x) => x.level)))
                        .map((s) => s.heading)
                        .join(" · ")}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- Save outline as type ------------------------------------------------------

export function SaveOutlineDialog({
  open,
  onOpenChange,
  defaultTitle,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTitle: string;
  /** Resolves to an error message, or null when saved. */
  onSave: (title: string) => Promise<string | null>;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle);
    setError(null);
    setSaving(false);
  }, [open, defaultTitle]);

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="rounded-2xl bg-[var(--doc-surface)] text-[var(--doc-ink)]">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            setSaving(true);
            setError(null);
            const err = await onSave(title.trim());
            setSaving(false);
            if (err) setError(err);
            else onOpenChange(false);
          }}
          className="space-y-4"
        >
          <DialogHeader className="text-left">
            <DialogTitle>Save outline as a type</DialogTitle>
            <DialogDescription className="text-[var(--doc-muted)]">
              Your team can then start documents from this outline. Its sections are this document&apos;s headings.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor="type-title" className="text-sm font-medium">
              Type name
            </label>
            <input
              id="type-title"
              autoFocus
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Quarterly board update"
              className="w-full rounded-lg border border-[var(--doc-line)] bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--doc-accent)]"
            />
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" disabled={saving} onClick={() => onOpenChange(false)} className="rounded-md px-3 py-1.5 text-sm text-[var(--doc-muted)] hover:text-[var(--doc-ink)]">
              Cancel
            </button>
            <button type="submit" disabled={saving || !title.trim()} className="flex items-center gap-1.5 rounded-md bg-[var(--doc-accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save type
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Start from a type ---------------------------------------------------------

/** Shown first in the strip when the team has them; the rest of the slots fill from the list. */
const POPULAR = ["general-report", "proposal", "policy-decision-memo", "design-doc-rfc", "business-plan", "research-report-imrad", "product-requirements"];

export function popularTypes(types: DocumentTypeSummary[], count = 6): DocumentTypeSummary[] {
  const rank = (t: DocumentTypeSummary) => {
    const i = POPULAR.indexOf(t.key);
    return i < 0 ? POPULAR.length : i;
  };
  return [...types].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title)).slice(0, count);
}

export function StartFromTypeStrip({ types, onChoose, onBrowse }: { types: DocumentTypeSummary[]; onChoose: (t: DocumentTypeSummary) => Promise<string | null>; onBrowse: () => void }) {
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (types.length === 0) return null;
  return (
    <div className="mx-auto mt-10 max-w-[44rem] border-t border-[var(--doc-line)] pt-5" aria-label="Start from a type" role="group">
      <p className="mb-2.5 text-sm text-[var(--doc-muted)]">Start from a type</p>
      <div className="flex flex-wrap gap-2">
        {popularTypes(types).map((t) => (
          <button
            key={t.key}
            type="button"
            disabled={!!working}
            onClick={async () => {
              setWorking(t.key);
              setError(null);
              const err = await onChoose(t);
              if (err) {
                setError(err);
                setWorking(null);
              }
            }}
            className="flex items-center gap-1.5 rounded-full border border-[var(--doc-line)] px-3 py-1.5 text-sm hover:border-[var(--doc-accent)] hover:text-[var(--doc-accent)] disabled:opacity-60"
          >
            {working === t.key && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t.title}
          </button>
        ))}
        <button type="button" onClick={onBrowse} disabled={!!working} className="rounded-full px-3 py-1.5 text-sm font-medium text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)] disabled:opacity-60">
          Browse all…
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
