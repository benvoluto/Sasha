// Fetches an upload group's metadata.json from Vercel Blob. Locates the blob via
// list() and fetches its ACTUAL url — the same reliable pattern the list
// endpoint uses. (The old approach constructed a URL from VERCEL_BLOB_BASE_URL,
// which returned null whenever that env var was unset/wrong — surfacing as
// "not found" 404s on add-documents and the assistant reads.)

import { list } from "@vercel/blob";
import { reconcileGeminiStatus } from "../processing-status";
import type { GroupMetadata } from "@/lib/sources/split";

export async function fetchGroupMetadata(groupId: string): Promise<GroupMetadata | null> {
  try {
    const { blobs } = await list({ prefix: `upload-groups/${groupId}/` });
    const meta = blobs.find((b) => b.pathname.endsWith("/metadata.json"));
    if (!meta) return null;
    const res = await fetch(meta.downloadUrl || meta.url, { cache: "no-store" });
    if (!res.ok) return null;
    return reconcileGeminiStatus((await res.json()) as GroupMetadata);
  } catch (error) {
    console.error(`[groupMetadata] failed to load ${groupId}:`, error);
    return null;
  }
}
