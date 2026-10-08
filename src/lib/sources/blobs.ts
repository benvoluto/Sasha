// A source's files in Blob, as a set. On a public store a blob is readable by
// anyone with its URL (the URLs only can't be guessed), so deleting a source must remove every file it ever stored, not
// just the one its row points at: an earlier copy from a retried PDF link, or a
// file whose upload finished in Blob but was never reported to the app. Every
// file a source stores lives under its prefix, so the prefix is the set.

import { del, list, type ListBlobResultBlob } from "@vercel/blob";
import { isOwnBlobUrl } from "@/lib/blob-host";
import { matchesPresignedPath, sourceBlobPrefix } from "./blob-paths";

/** Every blob stored under the source's prefix. */
export async function listSourceBlobs(teamId: string, sourceId: string): Promise<ListBlobResultBlob[]> {
  const blobs: ListBlobResultBlob[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: sourceBlobPrefix(teamId, sourceId), cursor });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

/**
 * Delete every file the source stored, plus any `known` URLs on our own store
 * (the row's blob_url, in case a listing lags a fresh write). Never throws: the
 * caller has already removed the row, so a failure is logged for follow-up.
 */
export async function deleteSourceBlobs(teamId: string, sourceId: string, known: Array<string | null | undefined> = []): Promise<void> {
  const urls = new Set(known.filter((u): u is string => !!u && isOwnBlobUrl(u)));
  try {
    for (const b of await listSourceBlobs(teamId, sourceId)) urls.add(b.url);
  } catch (error) {
    console.error(`[Sources] could not list the files of source ${sourceId}:`, error);
  }
  if (!urls.size) return;
  try {
    await del([...urls]);
  } catch (error) {
    console.error(`[Sources] could not delete the files of source ${sourceId}:`, error);
  }
}

/** Delete one blob we stored, logging a failure instead of throwing. */
export async function deleteBlobQuietly(url: string, why: string): Promise<void> {
  if (!isOwnBlobUrl(url)) return;
  try {
    await del(url);
  } catch (error) {
    console.error(`[Sources] could not delete ${why}:`, error);
  }
}

/**
 * The file an upload left in Blob at the path presign chose (with the store's
 * random suffix), for a source whose completion was never reported.
 */
export async function findPresignedUpload(teamId: string, sourceId: string, presignedPath: string): Promise<ListBlobResultBlob | null> {
  const blobs = (await listSourceBlobs(teamId, sourceId)).filter((b) => isOwnBlobUrl(b.url) && matchesPresignedPath(b.pathname, presignedPath));
  // A repeated upload of the same file: take the newest.
  blobs.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  return blobs[0] ?? null;
}
