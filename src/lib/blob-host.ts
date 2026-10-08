// Which URLs belong to this app's own Blob store. The store's read-write token
// must only ever be sent to that store: attaching it to a URL a caller supplied
// would hand the token to whoever controls that host.
//
// The token looks like `vercel_blob_rw_<storeId>_<secret>`, and the store serves
// blobs from `<storeId>.public.blob.vercel-storage.com` (or `.private.` for a
// private store). Without a token, any Vercel Blob host is accepted for reads
// that carry no credentials.

const BLOB_SUFFIX = ".blob.vercel-storage.com";

/** The store id from BLOB_READ_WRITE_TOKEN, lower-cased as it appears in hostnames. */
export function blobStoreId(token = process.env.BLOB_READ_WRITE_TOKEN): string | null {
  const m = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(token ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** True when `raw` is an https URL on this app's own Blob store. */
export function isOwnBlobUrl(raw: string, token = process.env.BLOB_READ_WRITE_TOKEN): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  const storeId = blobStoreId(token);
  if (storeId) return host === `${storeId}.public${BLOB_SUFFIX}` || host === `${storeId}.private${BLOB_SUFFIX}`;
  return host.endsWith(BLOB_SUFFIX);
}

/** Headers for a read from `url`: the store token only when the URL is on our own store. */
export function blobAuthHeaders(url: string): Record<string, string> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return token && blobStoreId(token) && isOwnBlobUrl(url, token) ? { Authorization: `Bearer ${token}` } : {};
}
