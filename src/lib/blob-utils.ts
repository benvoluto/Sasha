import { head } from '@vercel/blob';

/**
 * Safely fetch blob content using Vercel's blob SDK
 * This handles the authentication and uses the proper download URL
 */
export async function fetchBlobContent(blobUrl: string, opts: { skipHead?: boolean } = {}): Promise<Response> {
  try {
    let downloadUrl: string = blobUrl;

    // head() resolves a canonical download URL, but it costs an extra round trip.
    // Callers that already hold a downloadUrl from list() pass skipHead — that
    // halves the request count when loading many blobs.
    if (!opts.skipHead) {
      try {
        const blobDetails = await head(blobUrl);
        // Use downloadUrl for forced download, or url for inline display
        downloadUrl = blobDetails.downloadUrl || blobDetails.url;
      } catch {
        // head() may fail for various reasons (wrong URL format, no access, etc)
        // In that case, try to use the URL directly
        console.log('[BlobUtils] head() failed (expected in some cases), using URL directly');
      }
    }

    // Try fetching with different auth methods
    let response: Response;
    
    // Method 1: Try without auth first (works for public blobs)
    response = await fetch(downloadUrl);
    
    if (!response.ok && process.env.BLOB_READ_WRITE_TOKEN) {
      console.log('[BlobUtils] Public access returned:', response.status);
      
      // Method 2: Try with Authorization header
      response = await fetch(downloadUrl, {
        headers: {
          'Authorization': `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`
        }
      });
      
      if (!response.ok) {
        console.log('[BlobUtils] Bearer auth returned:', response.status);
        
        // Method 3: Try with token as query parameter
        const url = new URL(downloadUrl);
        url.searchParams.set('token', process.env.BLOB_READ_WRITE_TOKEN);
        response = await fetch(url.toString());
        
        if (!response.ok) {
          console.log('[BlobUtils] Token in URL returned:', response.status);
        }
      }
    }
    
    console.log('[BlobUtils] Final response status:', response.status, response.statusText);
    
    return response;
  } catch (error) {
    console.error('[BlobUtils] Error fetching blob content:', error);
    throw error;
  }
}

/**
 * Fetch and parse JSON from a blob
 */
export async function fetchBlobJson<T = unknown>(blobUrl: string, opts: { skipHead?: boolean } = {}): Promise<T> {
  const response = await fetchBlobContent(blobUrl, opts);

  if (!response.ok) {
    throw new Error(`Failed to fetch blob: ${response.status} ${response.statusText}`);
  }

  return response.json() as T;
}

/**
 * Fetch blob as buffer
 */
export async function fetchBlobBuffer(blobUrl: string): Promise<Buffer> {
  console.log('[BlobUtils] fetchBlobBuffer called with URL:', blobUrl);
  
  const response = await fetchBlobContent(blobUrl);
  
  if (!response.ok) {
    console.error('[BlobUtils] Failed to fetch blob:', response.status, response.statusText);
    console.error('[BlobUtils] Response headers:', response.headers);
    throw new Error(`Failed to fetch blob: ${response.status} ${response.statusText}`);
  }
  
  const contentType = response.headers.get('content-type');
  const contentLength = response.headers.get('content-length');
  console.log('[BlobUtils] Response content-type:', contentType);
  console.log('[BlobUtils] Response content-length:', contentLength);
  
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  console.log('[BlobUtils] Successfully fetched buffer, size:', buffer.length, 'bytes');
  
  // Log first few bytes to verify it's a valid file
  if (buffer.length > 0) {
    const fileSignature = buffer.slice(0, 4).toString('hex');
    console.log('[BlobUtils] File signature (first 4 bytes):', fileSignature);
    
    // Check for common file signatures
    if (fileSignature.startsWith('25504446')) {
      console.log('[BlobUtils] Detected PDF file signature');
    } else if (fileSignature.startsWith('504b0304')) {
      console.log('[BlobUtils] Detected DOCX/ZIP file signature');
    } else {
      console.log('[BlobUtils] Unknown file signature');
    }
  }
  
  return buffer;
}