// Uploading source files from the browser: presign creates a source row per
// file, each file goes straight to Blob through /api/upload/direct, and
// complete starts reading them. A file that fails to upload, or whose upload
// can't be completed, has its source row removed (which also deletes anything
// it stored) so it doesn't sit at "Uploading" forever.

import { upload } from "@vercel/blob/client";
import type { BlobAccess } from "@/lib/blob-access";
import type { SourceSummary } from "@/lib/sources/store";

type Presigned = { sourceId: string; fileName: string; fields: { blobPath: string; contentType: string; access?: BlobAccess } };

export type UploadResult = { sources: SourceSummary[]; failed: Array<{ name: string; error: string }> };

/**
 * What to tell the person after an upload: the files that couldn't be added
 * (rejected by the picker, or failed on the way), or null when every file made
 * it. Only an upload with no message is complete, so the host can close the
 * upload area without hiding a failure.
 */
export function uploadProblems(failed: UploadResult["failed"], rejected: string | null): string | null {
  const parts = [rejected, failed.length ? `Couldn't upload ${failed.map((f) => f.name).join(", ")}: ${failed[0].error}` : null];
  return parts.filter(Boolean).join(" ") || null;
}

/** Remove a source row that will never finish uploading; best effort. */
function discard(sourceId: string) {
  void fetch(`/api/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
}

async function json<T>(res: Response, fallback: string): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? fallback);
  return body as T;
}

export async function uploadSourceFiles(
  files: File[],
  where: { documentId?: string | null; folderId?: string | null },
  onProgress?: (percent: number) => void,
): Promise<UploadResult> {
  const presign = await fetch("/api/upload/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
      ...(where.documentId ? { document_id: where.documentId } : where.folderId ? { folder_id: where.folderId } : {}),
    }),
  });
  const { uploads } = await json<{ uploads: Presigned[] }>(presign, "The upload couldn't start.");

  const loaded = new Array<number>(files.length).fill(0);
  const total = files.reduce((n, f) => n + f.size, 0) || 1;
  const report = () => onProgress?.(Math.min(99, Math.round((loaded.reduce((a, b) => a + b, 0) / total) * 100)));

  const failed: UploadResult["failed"] = [];
  const done: Array<{ sourceId: string; url: string; pathname: string }> = [];
  await Promise.all(
    uploads.map(async (u, i) => {
      const file = files[i];
      try {
        const blob = await upload(u.fields.blobPath, file, {
          // The store's access level, from presign (a private store refuses public uploads).
          access: u.fields.access ?? "private",
          handleUploadUrl: "/api/upload/direct",
          clientPayload: JSON.stringify({ sourceId: u.sourceId }),
          contentType: u.fields.contentType,
          onUploadProgress: ({ loaded: n }) => {
            loaded[i] = n;
            report();
          },
        });
        done.push({ sourceId: u.sourceId, url: blob.url, pathname: blob.pathname });
      } catch (e) {
        failed.push({ name: file.name, error: e instanceof Error ? e.message : "Upload failed." });
        discard(u.sourceId);
      }
    }),
  );

  if (done.length === 0) return { sources: [], failed };
  let result: { sources: SourceSummary[]; failed?: Array<{ sourceId: string; error: string }> };
  try {
    const complete = await fetch("/api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploads: done }),
    });
    result = await json(complete, "The upload couldn't be finished.");
  } catch (e) {
    // None of these will be completed now; don't leave them stuck at "Uploading".
    done.forEach((d) => discard(d.sourceId));
    throw e;
  }
  const names = new Map(uploads.map((u, i) => [u.sourceId, files[i].name]));
  for (const f of result.failed ?? []) {
    failed.push({ name: names.get(f.sourceId) ?? "A file", error: f.error });
    discard(f.sourceId);
  }
  onProgress?.(100);
  return { sources: result.sources, failed };
}
