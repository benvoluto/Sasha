/**
 * Download blob content using direct fetch with proper authentication
 * According to Vercel docs, blobs should be accessed via their URLs
 */
export async function downloadBlobContent(blobUrl: string): Promise<Buffer> {
  console.log('[BlobDownload] Downloading blob from URL:', blobUrl);
  
  try {
    // First try with Bearer token in header (for private blobs in local dev)
    let response: Response;
    
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      console.log('[BlobDownload] Trying with Bearer token authentication');
      response = await fetch(blobUrl, {
        headers: {
          'Authorization': `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`
        }
      });
      
      if (!response.ok) {
        console.log('[BlobDownload] Bearer auth failed, trying token in URL');
        // Try with token as query parameter
        const url = new URL(blobUrl);
        url.searchParams.set('token', process.env.BLOB_READ_WRITE_TOKEN);
        response = await fetch(url.toString());
      }
    } else {
      console.log('[BlobDownload] No token available, trying public access');
      response = await fetch(blobUrl);
    }
    
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