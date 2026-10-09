// The in-memory Blob store for e2e runs (SASHA_E2E_STUB_BLOB=1, see mode.ts).
// The Playwright upload spec intercepts the browser's Blob upload and forwards
// the bytes to /api/e2e/blob, which stores them here under a URL on the fake
// store `e2estore` (the web server sets BLOB_READ_WRITE_TOKEN to a matching
// fake token, so isOwnBlobUrl accepts it). downloadBlobContent and the upload
// completion's head() read from here instead of the network.

import { randomBytes } from "node:crypto";
import { processMemory } from "@/lib/process-memory";

export const E2E_BLOB_STORE_ID = "e2estore";
export const E2E_BLOB_ORIGIN = `https://${E2E_BLOB_STORE_ID}.public.blob.vercel-storage.com`;

type StoredBlob = { bytes: Uint8Array; contentType: string; uploadedAt: string };
const blobs = processMemory("e2e.blobs", () => new Map<string, StoredBlob>());

/** The URL a pathname is stored under. */
export function e2eBlobUrl(pathname: string): string {
  return `${E2E_BLOB_ORIGIN}/${pathname.replace(/^\/+/, "")}`;
}

export function putE2eBlob(pathname: string, bytes: Uint8Array, contentType: string): { url: string; pathname: string; contentType: string; size: number } {
  const url = e2eBlobUrl(pathname);
  blobs.set(url, { bytes, contentType, uploadedAt: new Date().toISOString() });
  return { url, pathname: pathname.replace(/^\/+/, ""), contentType, size: bytes.byteLength };
}

export function getE2eBlob(url: string): StoredBlob | null {
  return blobs.get(url.split("?")[0]) ?? null;
}

/** What @vercel/blob's head() returns, for the fields the app reads. Throws like head() when missing. */
export function headE2eBlob(url: string): { url: string; size: number; contentType: string; uploadedAt: Date } {
  const b = getE2eBlob(url);
  if (!b) throw new Error("e2e blob not found");
  return { url, size: b.bytes.byteLength, contentType: b.contentType, uploadedAt: new Date(b.uploadedAt) };
}

/** Presign's path with a store-style random suffix before the extension (upload/complete expects one). */
export function withRandomSuffix(pathname: string, suffix = randomBytes(12).toString("hex")): string {
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  return dot > slash + 1 ? `${pathname.slice(0, dot)}-${suffix}${pathname.slice(dot)}` : `${pathname}-${suffix}`;
}

/** Clears the store (tests). */
export function resetE2eBlobs() {
  blobs.clear();
}
