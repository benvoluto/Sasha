/**
 * Resumable upload utility for Google APIs (especially Gemini).
 *
 * This used to stream straight from a blob URL, declaring the length it got
 * from a separate unauthenticated HEAD request. That coupled two things that
 * can disagree — what HEAD says the file is and what the body actually
 * delivers — and Google rejects the session when the finalized byte count
 * doesn't match the length declared up front. It also failed outright whenever
 * HEAD didn't return a Content-Length at all.
 *
 * Uploading from bytes the caller already holds removes that whole class of
 * failure: the declared length is measured from the same buffer that gets sent.
 */

interface ResumableUploadOptions {
  /** The file content. Its byteLength is authoritative — nothing else is trusted. */
  data: Uint8Array;
  resumableUrl: string;
  metadata: {
    file: {
      displayName: string;
      mimeType: string;
    };
  };
  chunkSize?: number;
}

export interface UploadResult {
  file: {
    name: string;
    uri: string;
    mimeType: string;
    createTime?: string;
    updateTime?: string;
    expirationTime?: string;
    displayName?: string;
    sha256Hash?: string;
    sizeBytes?: string;
    state?: string;
    error?: unknown;
  };
}

/** Upload bytes to a Google resumable-upload endpoint, chunking as needed. */
export async function resumableUpload(options: ResumableUploadOptions): Promise<UploadResult> {
  const { data, resumableUrl, metadata, chunkSize = 16 * 1024 * 1024 } = options;
  const dataSize = data.byteLength;

  if (dataSize === 0) {
    throw new Error('Refusing to upload an empty file (0 bytes)');
  }

  console.log(`[ResumableUpload] Uploading ${metadata.file.displayName}: ${dataSize} bytes as ${metadata.file.mimeType}`);

  // Step 1: open the session, declaring the exact length we are about to send.
  const initResponse = await fetch(resumableUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': dataSize.toString(),
      'X-Goog-Upload-Header-Content-Type': metadata.file.mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });

  if (!initResponse.ok) {
    const errorText = await initResponse.text().catch(() => '');
    throw new Error(`Failed to initialize upload: ${initResponse.status} ${trim(errorText)}`);
  }

  const uploadUrl = initResponse.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Google did not return an upload URL for the session');
  }

  // Step 2: send the bytes. Offsets come from the buffer, so the finalize
  // always lands on exactly the length declared above.
  for (let offset = 0; offset < dataSize; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, dataSize);
    const chunk = data.subarray(offset, end);
    const isLastChunk = end >= dataSize;

    const chunkResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'X-Goog-Upload-Offset': offset.toString(),
        'X-Goog-Upload-Command': isLastChunk ? 'upload, finalize' : 'upload',
      },
      // undici accepts a typed array body directly (no copy); the DOM lib's
      // BodyInit union just doesn't list it.
      body: chunk as unknown as BodyInit,
    });

    if (!chunkResponse.ok) {
      const errorText = await chunkResponse.text().catch(() => '');
      throw new Error(`Chunk upload failed at byte ${offset}: ${chunkResponse.status} ${trim(errorText)}`);
    }

    if (isLastChunk) {
      const result = (await chunkResponse.json()) as UploadResult;
      if (!result?.file?.uri) {
        throw new Error('Upload finalized but Google returned no file reference');
      }
      return result;
    }
  }

  // Unreachable while dataSize > 0, but a loop that silently produces nothing
  // is exactly how the old version turned a real problem into a bare `null`.
  throw new Error(`Upload loop ended without finalizing ${dataSize} bytes`);
}

function trim(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

/**
 * Determine MIME type from file extension
 */
export function getMimeTypeFromExtension(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'doc':
      return 'application/msword';
    case 'txt':
      return 'text/plain';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'mp4':
      return 'video/mp4';
    case 'mp3':
      return 'audio/mpeg';
    default:
      return 'application/octet-stream';
  }
}
