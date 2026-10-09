"use client";

// Exporting the document (PLAN §6.10, phase7-spec.md §4.6; redesign2-spec.md
// §3.3): Markdown, Word and PDF of the saved document, named from the title.
// It saves first, fetches the file and hands it to the browser as a download.
// When the server can't render a PDF it says so and falls back, visibly, to
// the browser's print dialog on the print HTML, loaded in a hidden same-origin
// iframe that may not run scripts. Used by the Share & Export dialog.

import { useCallback, useEffect, useRef, useState } from "react";
import { exportUrl, fetchExport, PRINT_CLEANUP_MS, PRINT_FALLBACK_NOTICE, type MenuFormat } from "./export-menu-model";
import type { Notify } from "./notice";

export type UseExportOptions = {
  documentId: string | null;
  title: string;
  /** Saves pending changes (creating the document if needed) and returns its id. */
  ensureSaved: () => Promise<string | null>;
  notify: Notify;
};

export type ExportState = {
  /** The format being made, or null. */
  busy: MenuFormat | null;
  /** Why the last export failed, or null. */
  error: string | null;
  /** The last file handed to the browser, or null. */
  lastFile: string | null;
  /** Set when the last PDF went to the print dialog instead (PRINT_FALLBACK_NOTICE). */
  printed: boolean;
  run: (format: MenuFormat) => Promise<void>;
  /** Clears the last result (the dialog reopened). */
  reset: () => void;
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

export function useExport({ documentId, title, ensureSaved, notify }: UseExportOptions): ExportState {
  const [busy, setBusy] = useState<MenuFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<string | null>(null);
  const [printed, setPrinted] = useState(false);
  const busyRef = useRef(false);
  const cleanupPrint = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupPrint.current?.(), []);

  const run = useCallback(
    async (format: MenuFormat) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(format);
      setError(null);
      setLastFile(null);
      setPrinted(false);
      try {
        // Save first, so the export is what is on screen.
        const id = (await ensureSaved()) ?? null;
        if (!id) {
          setError(documentId ? "Save the document first. Your latest changes aren't saved yet." : "Save the document first.");
          return;
        }
        const out = await fetchExport(id, format, title);
        if (out.kind === "error") setError(out.message);
        else if (out.kind === "print") {
          notify({ text: PRINT_FALLBACK_NOTICE });
          setPrinted(true);
          cleanupPrint.current?.();
          cleanupPrint.current = printFallback(id, () => setError("The print dialog couldn't be opened. Try Word instead."));
        } else {
          download(out.blob, out.filename);
          setLastFile(out.filename);
        }
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [documentId, title, ensureSaved, notify],
  );

  const reset = useCallback(() => {
    setError(null);
    setLastFile(null);
    setPrinted(false);
  }, []);

  return { busy, error, lastFile, printed, run, reset };
}
