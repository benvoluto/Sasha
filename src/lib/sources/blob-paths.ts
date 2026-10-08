// Where a source's file lives in Blob: sources/<teamSlug>/<sourceId>/<name>.
// The team slug is a short hash because team ids ("org:…", "user:…") contain
// characters that don't belong in a path and shouldn't be readable from a URL.
// The source id is a random uuid and uploads add a random suffix, so a blob URL
// can't be guessed; even so, the app only hands out files through the
// team-checked /api/sources/[id]/file route.

import { createHash } from "node:crypto";

export function teamSlug(teamId: string): string {
  return createHash("sha256").update(teamId).digest("hex").slice(0, 16);
}

/** A filename safe for a blob path: no slashes or control characters, bounded length, extension kept. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\?#%*:|"<>]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!cleaned) return "file";
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 120 - ext.length) + ext;
}

export function sourceBlobPrefix(teamId: string, sourceId: string): string {
  return `sources/${teamSlug(teamId)}/${sourceId}/`;
}

export function sourceBlobPath(teamId: string, sourceId: string, name: string): string {
  return sourceBlobPrefix(teamId, sourceId) + safeFileName(name);
}

/** The shape every source blob path has: sources/<16 hex>/<uuid>/<name>. */
export const SOURCE_BLOB_PATH_RE = /^sources\/[0-9a-f]{16}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]+$/;

/** The blob pathname of a blob URL (decoded), or null for a malformed URL. */
export function blobPathnameOf(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
}

/** The stored name is presign's path with the store's random suffix before the extension. */
export function matchesPresignedPath(actual: string, presigned: string): boolean {
  if (actual === presigned) return true;
  const dir = presigned.slice(0, presigned.lastIndexOf("/") + 1);
  const name = presigned.slice(dir.length);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  if (!actual.startsWith(dir + stem + "-") || !actual.endsWith(ext)) return false;
  const suffix = actual.slice((dir + stem + "-").length, actual.length - ext.length);
  return /^[A-Za-z0-9]{1,64}$/.test(suffix);
}
