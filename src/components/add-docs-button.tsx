"use client";

// Upload additional source files to an existing document. Shared by the list
// strip and the detail rail. Posts to the add-documents route, which re-extracts
// the new files in the background.

import React, { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, UploadCloud } from "@/components/icons";

/**
 * `className`/`icon`/`label` let a caller render this as something other than a
 * button — the detail rail wants a plain magenta text action, the list wants the
 * default ghost button.
 */
export function AddDocsButton({
  groupId, onDone, className, icon, label, disabled,
}: {
  groupId: string;
  documentName?: string;
  onDone: () => void;
  className?: string;
  icon?: React.ReactNode;
  label?: string;
  /** Caller-driven disable, on top of the internal uploading state. */
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append("files", f));
      const res = await fetch(`/api/cases/${groupId}/documents`, { method: "POST", body: fd });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(`Upload failed: ${d.error || res.status}`);
      } else {
        // The request returns once the files are stored; reading them continues
        // in the background (legacy upload groups aren't tracked by the
        // processing tracker, which follows sources).
        onDone();
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const text = busy ? "Uploading…" : label ?? "Upload files";

  return (
    <>
      <input ref={inputRef} type="file" accept=".pdf,.docx" multiple className="hidden" onChange={handleFiles} />
      {className ? (
        <button type="button" className={className} disabled={busy || disabled} onClick={() => inputRef.current?.click()}>
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : icon ?? <UploadCloud className="h-5 w-5" />}
          {text}
        </button>
      ) : (
        <Button variant="ghost" size="sm" className="gap-1.5" disabled={busy || disabled} onClick={() => inputRef.current?.click()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
          {text}
        </Button>
      )}
    </>
  );
}
