import { blobAuthHeaders } from './blob-host';

/**
 * Download blob content. The store token is attached only when the URL is on
 * this app's own Blob store, so a caller-supplied URL never receives it.
 */
export async function downloadBlobContent(blobUrl: string): Promise<Buffer> {
  console.log('[BlobDownload] Downloading blob from URL:', blobUrl);
  
  try {
    const response = await fetch(blobUrl, { headers: blobAuthHeaders(blobUrl) });
    
    if (!response.ok) {
      throw new Error(`Failed to download blob: ${response.status} ${response.statusText}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    console.log('[BlobDownload] Downloaded successfully, size:', buffer.length);
    
    return buffer;
  } catch (error) {
    console.error('[BlobDownload] Error downloading blob:', error);
    throw error;
  }
}

/**
 * Download and parse JSON from a blob
 */
export async function downloadBlobJson<T = unknown>(blobUrlOrPathname: string): Promise<T> {
  const buffer = await downloadBlobContent(blobUrlOrPathname);
  const text = buffer.toString('utf-8');
  return JSON.parse(text) as T;
}
