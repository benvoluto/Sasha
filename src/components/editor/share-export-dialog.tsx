"use client";

// The header's Share & Export dialog (redesign2-spec.md §3.3). Share: who can
// see the document, the team it belongs to, and its link to copy. Export:
// Markdown, Word and PDF downloads (use-export.ts); the dialog stays open
// after a download and says what was saved.
//
// Teams: Clerk's OrganizationSwitcher opens its popover and its Create / Manage
// modals in portals outside this dialog, where Radix's modal focus trap and
// pointer-events lock leave them unusable. So the switch is a plain select
// here (useOrganizationList's setActive), and "Manage teams" / "Create a team"
// close the dialog before opening Clerk's own modal.

import { useClerk, useOrganization, useOrganizationList } from "@clerk/nextjs";
import { useEffect, useId, useState, type RefObject } from "react";
import { Check, Copy, Download, Loader2 } from "@/components/icons";
import { useDevAuthBypass } from "@/components/dev-auth-context";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MENU_FORMATS, MENU_ITEM_LABEL } from "./export-menu-model";
import type { Notify } from "./notice";
import { useReturnFocus } from "./type-picker";
import { useExport } from "./use-export";

const PERSONAL = "personal";

const quietButton =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--doc-field-line)] px-3 text-sm font-medium hover:bg-[var(--go-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-transparent sm:min-h-9";

/**
 * Who can see the document, the team switch, and Clerk's team management.
 * Uses Clerk's organization hooks, so it is never mounted under the dev auth bypass.
 */
function TeamSharing({ onLeave }: { onLeave: () => void }) {
  const { organization } = useOrganization();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({ userMemberships: { infinite: true } });
  const clerk = useClerk();
  const selectId = useId();
  const [switching, setSwitching] = useState(false);
  const memberships = userMemberships?.data ?? [];
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {organization
          ? `Everyone in ${organization.name} can open and edit this document.`
          : "Only you can see this document. Create or join a team to share it with others."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {isLoaded && memberships.length > 0 && (
          <>
            <label htmlFor={selectId} className="text-sm font-medium">
              Team
            </label>
            <select
              id={selectId}
              value={organization?.id ?? PERSONAL}
              disabled={switching}
              onChange={async (e) => {
                const next = e.target.value === PERSONAL ? null : e.target.value;
                setSwitching(true);
                try {
                  await setActive?.({ organization: next });
                  // The open document belongs to the team it was made in: start over at home.
                  window.location.assign("/");
                } catch {
                  setSwitching(false);
                }
              }}
              className="min-h-11 rounded-lg border border-[var(--doc-field-line)] bg-transparent px-2 text-sm outline-none focus-visible:border-[var(--doc-accent)] focus-visible:ring-2 focus-visible:ring-[var(--doc-accent)] sm:min-h-9"
            >
              <option value={PERSONAL}>Personal workspace</option>
              {memberships.map((m) => (
                <option key={m.organization.id} value={m.organization.id}>
                  {m.organization.name}
                </option>
              ))}
            </select>
          </>
        )}
        <button
          type="button"
          onClick={() => {
            // Clerk's modal can't take focus while this dialog holds it.
            onLeave();
            if (organization) clerk.openOrganizationProfile();
            else clerk.openCreateOrganization({ afterCreateOrganizationUrl: "/" });
          }}
          className={quietButton}
        >
          {organization ? "Manage teams" : "Create a team"}
        </button>
      </div>
    </div>
  );
}

function CopyLink({ documentId }: { documentId: string | null }) {
  const [copied, setCopied] = useState(false);
  const url = documentId && typeof window !== "undefined" ? `${window.location.origin}/d/${documentId}` : "";
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);
  if (!documentId) return <p className="text-sm text-[var(--doc-muted)]">The link appears once the document has been saved.</p>;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={url}
          aria-label="Document link"
          onFocus={(e) => e.currentTarget.select()}
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-[var(--doc-field-line)] bg-transparent px-2.5 text-sm outline-none focus-visible:border-[var(--doc-accent)] focus-visible:ring-2 focus-visible:ring-[var(--doc-accent)] sm:min-h-9"
        />
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            } catch {
              /* the link stays visible for manual copying */
            }
          }}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--doc-accent)] px-3 text-sm font-semibold text-[var(--doc-on-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--doc-accent)] sm:min-h-9"
        >
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />} {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "Link copied." : ""}
      </span>
    </div>
  );
}

export function ShareExportDialog({
  open,
  onOpenChange,
  documentId,
  title,
  ensureSaved,
  notify,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  documentId: string | null;
  title: string;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  notify: Notify;
  /** The header's Share & Export button: focus goes back to it on close. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  // Under the dev auth bypass there is no Clerk user, and the organization
  // hooks would open Clerk's "Organizations feature required" modal.
  const bypass = useDevAuthBypass();
  const focusProps = useReturnFocus(returnFocusRef);
  const exporter = useExport({ documentId, title, ensureSaved, notify });
  const { reset } = exporter;
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);
  const status = exporter.lastFile ? `Downloaded ${exporter.lastFile}.` : exporter.printed ? "Opening your browser's print dialog. Choose 'Save as PDF'." : "";
  return (
    <Dialog open={open} onOpenChange={(o) => onOpenChange(o)}>
      <DialogContent {...focusProps} className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto rounded-2xl bg-[var(--doc-surface)] p-0 text-[var(--doc-ink)] sm:max-w-lg">
        <DialogHeader className="px-6 pb-2 pr-14 pt-6 text-left">
          <DialogTitle className="text-xl font-semibold tracking-tight">Share &amp; Export</DialogTitle>
          <DialogDescription className="text-[var(--doc-muted)]">Share this document with your team, or download a copy.</DialogDescription>
        </DialogHeader>
        <section aria-labelledby="share-heading" className="space-y-3 border-b border-[var(--doc-line)] px-6 py-4">
          <h3 id="share-heading" className="text-base font-semibold">
            Share
          </h3>
          {bypass ? <p className="text-sm">Local development: signed in as the developer user, so teams are unavailable.</p> : <TeamSharing onLeave={() => onOpenChange(false)} />}
          <CopyLink documentId={documentId} />
        </section>
        <section aria-labelledby="export-heading" className="space-y-3 px-6 pb-6 pt-4">
          <h3 id="export-heading" className="text-base font-semibold">
            Export
          </h3>
          <div className="flex flex-wrap gap-2">
            {MENU_FORMATS.map((format) => (
              <button
                key={format}
                type="button"
                // aria-disabled, not disabled: the pressed button keeps focus while its export runs (a disabled one would drop it to the dialog).
                aria-disabled={exporter.busy !== null || undefined}
                aria-busy={exporter.busy === format ? true : undefined}
                onClick={() => {
                  if (exporter.busy === null) void exporter.run(format);
                }}
                className={quietButton}
              >
                {exporter.busy === format ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
                {MENU_ITEM_LABEL[format]}
              </button>
            ))}
          </div>
          <p role="status" aria-live="polite" className="min-h-5 text-sm text-[var(--doc-muted)]">
            {exporter.busy ? "Exporting…" : status}
          </p>
          {exporter.error && (
            <p role="alert" className="text-sm text-[var(--alert-danger-ink)]">
              {exporter.error}
            </p>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
