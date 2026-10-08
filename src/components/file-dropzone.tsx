"use client";

// Drop or choose files to add as sources. Files upload as soon as they're
// chosen, into a document's folder (and linked to it) or a library folder.
// Reading them continues in the background; the processing tracker keeps that
// visible wherever the person goes.

import { useCallback, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { Loader2, UploadCloud } from "@/components/icons";
import { uploadProblems, uploadSourceFiles } from "@/components/sources/upload";
import { addJob } from "@/lib/processing-jobs";
import type { SourceSummary } from "@/lib/sources/store";
import { DIRECT_UPLOAD_CONFIG } from "@/lib/upload-strategy";

interface FileDropzoneProps {
  /** Upload into this document's folder and link the files to it. */
  documentId?: string | null;
  /** Upload into this library folder (ignored when `documentId` is set). */
  folderId?: string | null;
  /**
   * Called before uploading to get the document id, e.g. saving a new
   * document first. Return null to stop.
   */
  resolveDocumentId?: () => Promise<string | null>;
  /** Shown on the processing tracker: where the files went. */
  label?: string;
  /**
   * Called when at least one file uploaded. `complete` is false when some
   * files were rejected or failed: the dropzone is showing why, so the host
   * should refresh but keep it open.
   */
  onUploaded?: (sources: SourceSummary[], complete: boolean) => void;
  compact?: boolean;
}

const MAX_MB = DIRECT_UPLOAD_CONFIG.maxFileSize / 1024 / 1024;

function rejectionText(rejections: FileRejection[]): string {
  const tooMany = rejections.some((r) => r.errors.some((e) => e.code === "too-many-files"));
  if (tooMany) return `Upload at most ${DIRECT_UPLOAD_CONFIG.maxFiles} files at a time.`;
  const names = rejections.slice(0, 3).map((r) => r.file.name).join(", ");
  const big = rejections.some((r) => r.errors.some((e) => e.code === "file-too-large"));
  return big ? `${names}: files can be up to ${MAX_MB} MB.` : `${names}: not a supported type. Use PDF, Word, an image, text, Markdown, CSV or Excel.`;
}

export function FileDropzone({ documentId, folderId, resolveDocumentId, label, onUploaded, compact }: FileDropzoneProps) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (files: File[], rejected: string | null) => {
      setUploading(true);
      setProgress(0);
      setError(rejected);
      try {
        const docId = resolveDocumentId ? await resolveDocumentId() : (documentId ?? null);
        if (resolveDocumentId && !docId) throw new Error("Save the document before adding sources.");
        const { sources, failed } = await uploadSourceFiles(files, { documentId: docId, folderId }, setProgress);
        if (sources.length) {
          addJob({
            id: crypto.randomUUID(),
            sourceIds: sources.map((s) => s.id),
            label: label || "the library",
            files: sources.map((s) => s.filename ?? s.title ?? "file"),
          });
        }
        const problems = uploadProblems(failed, rejected);
        setError(problems);
        if (sources.length) onUploaded?.(sources, !problems);
      } catch (e) {
        const message = e instanceof Error ? e.message : "The upload failed.";
        setError(rejected ? `${rejected} ${message}` : message);
      } finally {
        setUploading(false);
      }
    },
    [documentId, folderId, resolveDocumentId, label, onUploaded],
  );

  const onDrop = useCallback(
    (accepted: File[], rejected: FileRejection[]) => {
      const notice = rejected.length ? rejectionText(rejected) : null;
      if (accepted.length) void start(accepted, notice);
      else setError(notice);
    },
    [start],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: DIRECT_UPLOAD_CONFIG.accept,
    maxFiles: DIRECT_UPLOAD_CONFIG.maxFiles,
    maxSize: DIRECT_UPLOAD_CONFIG.maxFileSize,
    disabled: uploading,
  });

  return (
    <div className="space-y-1.5">
      <div
        {...getRootProps({ role: "button", "aria-label": "Upload source files" })}
        className={`flex cursor-pointer items-center justify-center gap-3 rounded-xl border-2 border-dashed text-center text-sm text-[var(--doc-muted)] outline-none transition-colors focus-visible:border-[var(--doc-accent)] ${
          compact ? "flex-col px-3 py-4" : "px-6 py-6"
        } ${isDragActive ? "border-[var(--doc-accent)] bg-[var(--doc-accent-soft)]" : "border-[var(--doc-line)] hover:border-[var(--doc-accent-line)]"} ${
          uploading ? "cursor-progress opacity-80" : ""
        }`}
      >
        <input {...getInputProps()} />
        {uploading ? (
          <Loader2 className="h-6 w-6 shrink-0 animate-spin text-[var(--doc-accent)]" aria-hidden />
        ) : (
          <UploadCloud className="h-6 w-6 shrink-0 text-[var(--doc-accent)]" aria-hidden />
        )}
        <span role="status" aria-live="polite">
          {uploading
            ? `Uploading… ${progress}%`
            : isDragActive
              ? "Drop the files here"
              : compact
                ? "Drop files or click to choose"
                : "Drop files here, or click to choose (PDF, Word, images, text, CSV, Excel)"}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
