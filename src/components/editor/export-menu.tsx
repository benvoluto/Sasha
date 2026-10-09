"use client";

// The header's Export menu (PLAN §6.10, phase7-spec.md §4.6): Markdown, Word
// and PDF of the saved document, named from the title. It saves first, fetches
// the file and hands it to the browser as a download. When the server can't
// render a PDF it says so and falls back, visibly, to the browser's print
// dialog on the print HTML, loaded in a hidden same-origin iframe that may not
// run scripts.

import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "@/components/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  MENU_FORMATS,
  MENU_ITEM_LABEL,
  PRINT_CLEANUP_MS,
  PRINT_FALLBACK_NOTICE,
  exportErrorMessage,
  exportUrl,
  filenameFromDisposition,
  isPrintFallback,
  type ExportErrorBody,
  type MenuFormat,
} from "./export-menu-model";
import type { Notify } from "./notice";

export type ExportMenuProps = {
  documentId: string | null;
  title: string;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  notify: Notify;
};

/** Hands `blob` to the browser as a download named `filename`. */
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Some browsers start the download after click returns; revoke a moment later.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Prints the document's print HTML from a hidden iframe. The iframe is
 * same-origin (print needs access to its window) and sandboxed without
 * allow-scripts; the HTML itself carries a no-script CSP. Returns the cleanup.
 */
function printFallback(documentId: string, onError: () => void): () => void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-same-origin allow-modals");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.title = "Print preview";
  Object.assign(iframe.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0", opacity: "0", pointerEvents: "none" });
  let done = false;
  let timer = 0;
  const cleanup = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    iframe.remove();
  };
  iframe.addEventListener("load", () => {
    const win = iframe.contentWindow;
    if (!win) {
      cleanup();
      onError();
      return;
    }
    win.addEventListener("afterprint", () => window.setTimeout(cleanup, 0));
    try {
      win.focus();
      win.print();
    } catch {
      cleanup();
      onError();
    }
  });
  timer = window.setTimeout(cleanup, PRINT_CLEANUP_MS);
  iframe.src = exportUrl(documentId, "html");
  document.body.appendChild(iframe);
  return cleanup;
}

export function ExportMenu({ documentId, title, ensureSaved, notify }: ExportMenuProps) {
  const [busy, setBusy] = useState<MenuFormat | null>(null);
  const [open, setOpen] = useState(false);
  const cleanupPrint = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupPrint.current?.(), []);

  const run = async (format: MenuFormat) => {
    if (busy) return;
    setBusy(format);
    try {
      // Save first, so the export is what is on screen.
      const id = (await ensureSaved()) ?? null;
      if (!id) {
        notify({ text: documentId ? "Save the document first. Your latest changes aren't saved yet." : "Save the document first.", tone: "error" });
        return;
      }
      const res = await fetch(exportUrl(id, format), { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ExportErrorBody;
        if (format === "pdf" && isPrintFallback(res.status, body)) {
          notify({ text: PRINT_FALLBACK_NOTICE });
          cleanupPrint.current?.();
          cleanupPrint.current = printFallback(id, () => notify({ text: "The print dialog couldn't be opened. Try Word instead.", tone: "error" }));
          return;
        }
        notify({ text: exportErrorMessage(res.status, format, body), tone: "error" });
        return;
      }
      const blob = await res.blob();
      download(blob, filenameFromDisposition(res.headers.get("Content-Disposition"), title, format));
    } catch {
      notify({ text: "The export couldn't reach the server. Check your connection and try again.", tone: "error" });
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={(next) => (busy ? setOpen(true) : setOpen(next))}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Export"
          title="Export"
          aria-busy={busy ? true : undefined}
          className="flex h-11 w-11 shrink-0 items-center justify-center gap-2.5 rounded-xl border border-[var(--go-line)] text-[18px] font-semibold text-[var(--go)] hover:bg-[var(--go-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--go)] data-[state=open]:bg-[var(--go-soft)] sm:h-12 sm:w-auto sm:px-5"
        >
          {busy ? <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" /> : <Download className="h-6 w-6" aria-hidden="true" />}{" "}
          <span className="hidden sm:inline">Export</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem] rounded-xl">
        {MENU_FORMATS.map((format) => (
          <DropdownMenuItem
            key={format}
            disabled={busy !== null && busy !== format}
            aria-busy={busy === format ? true : undefined}
            // Keep the menu open while the file is made, so the spinner is seen.
            onSelect={(e) => {
              e.preventDefault();
              void run(format);
            }}
            className="flex min-h-11 items-center gap-2 sm:min-h-9"
          >
            {busy === format ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
            <span>{MENU_ITEM_LABEL[format]}</span>
            {busy === format && <span className="sr-only">Exporting…</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
