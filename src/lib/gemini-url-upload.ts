import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";
import { resumableUpload, getMimeTypeFromExtension } from './resumable-upload';
import { downloadBlobContent } from './blob-download';
import { GEMINI_MODEL } from './gemini-model';

export interface GeminiProcessedContent {
  extractedContent: string;
  processedAt: string;
  fileCount: number;
  status: 'success' | 'error' | 'partial';
  error?: string;
}

export type GeminiUpload = { uri: string; mimeType: string; name: string };

/**
 * Why an upload didn't happen. Previously every one of these paths collapsed
 * into a bare `null`, which surfaced to the user as "Failed to upload any files
 * to Gemini" with no way — for them or for us — to tell an unreadable blob from
 * a rejected file type from a bad API key.
 */
export type GeminiUploadOutcome =
  | { ok: true; file: GeminiUpload }
  | { ok: false; reason: string };

/** Refuse rather than exhaust the function's memory on a pathological file. */
const MAX_UPLOAD_BYTES = Number(process.env.GEMINI_MAX_UPLOAD_BYTES) || 150 * 1024 * 1024;

/**
 * Upload one blob-stored file to the Gemini Files API.
 *
 * The bytes are fetched first (through the blob helper, which carries the store
 * token) and the upload length is measured from that buffer. The previous
 * version declared a length taken from a separate unauthenticated HEAD request
 * and streamed the body separately — so a private blob, a missing
 * Content-Length header, or any disagreement between the two failed the upload.
 */
export async function uploadFileFromUrlToGemini(
  fileUrl: string,
  filename: string,
  mimeType?: string
): Promise<GeminiUploadOutcome> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error('[GeminiUrlUpload] No API key configured');
    return { ok: false, reason: 'the model API key is not configured' };
  }

  let bytes: Buffer;
  try {
    bytes = await downloadBlobContent(fileUrl);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[GeminiUrlUpload] Could not read ${filename} from storage:`, error);
    return { ok: false, reason: `could not read "${filename}" from storage (${detail})` };
  }
  return uploadBytesToGemini(bytes, filename, mimeType);
}

/** Upload bytes already in memory (a downloaded file, or a slice of one) to the Gemini Files API. */
export async function uploadBytesToGemini(bytes: Buffer, filename: string, mimeType?: string): Promise<GeminiUploadOutcome> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[GeminiUrlUpload] No API key configured');
    return { ok: false, reason: 'the model API key is not configured' };
  }
  const detectedMimeType = mimeType || getMimeTypeFromExtension(filename);

  if (bytes.byteLength === 0) {
    return { ok: false, reason: `"${filename}" is empty (0 bytes) in storage` };
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `"${filename}" is ${Math.round(bytes.byteLength / 1024 / 1024)}MB, larger than this app will send for reading`,
    };
  }

  console.log(`[GeminiUrlUpload] ${filename}: ${bytes.byteLength} bytes, ${detectedMimeType}`);

  try {
    const result = await resumableUpload({
      data: bytes,
      resumableUrl: `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${apiKey}`,
      metadata: { file: { displayName: filename, mimeType: detectedMimeType } },
    });
    console.log(`[GeminiUrlUpload] Upload successful:`, {
      name: result.file.name,
      uri: result.file.uri,
      state: result.file.state,
    });
    return {
      ok: true,
      file: { uri: result.file.uri, mimeType: result.file.mimeType, name: result.file.name },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[GeminiUrlUpload] Upload of ${filename} failed:`, error);
    return { ok: false, reason: `"${filename}" could not be sent for reading (${detail})` };
  }
}

/**
 * Process documents with Gemini using direct URL upload (most efficient for blob storage)
 */
export async function processDocumentsFromUrls(
  files: Array<{ url: string; name: string; type: string }>
): Promise<GeminiProcessedContent> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error('[GeminiUrlUpload] API key not configured');
    return {
      extractedContent: '',
      processedAt: new Date().toISOString(),
      fileCount: 0,
      status: 'error',
      error: 'Gemini API not configured',
    };
  }

  const ai = new GoogleGenAI({ apiKey });
  const startTime = Date.now();
  
  console.log(`[GeminiUrlUpload] Starting URL-based processing for ${files.length} files`);
  console.log(`[GeminiUrlUpload] Environment: ${process.env.NODE_ENV}`);
  console.log(`[GeminiUrlUpload] Is Vercel: ${!!process.env.VERCEL}`);

  try {
    const uploadedFiles: Array<{ uri: string; mimeType: string }> = [];
    const uploadFailures: string[] = [];

    // Upload all files using direct URL upload (most efficient)
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`[GeminiUrlUpload] Processing file ${i + 1}/${files.length}: ${file.name}`);

      // Determine MIME type
      const mimeType = 
        file.type === 'pdf' || file.type === 'application/pdf'
          ? 'application/pdf'
          : file.type === 'docx' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : getMimeTypeFromExtension(file.name);

      const uploadResult = await uploadFileFromUrlToGemini(file.url, file.name, mimeType);

      if (uploadResult.ok) {
        uploadedFiles.push({
          uri: uploadResult.file.uri,
          mimeType: uploadResult.file.mimeType,
        });
        console.log(`[GeminiUrlUpload] File ${i + 1} uploaded successfully`);
      } else {
        uploadFailures.push(uploadResult.reason);
        console.error(`[GeminiUrlUpload] Failed to upload file ${i + 1}: ${uploadResult.reason}`);
      }
    }

    console.log(`[GeminiUrlUpload] Upload phase complete. ${uploadedFiles.length}/${files.length} files uploaded`);

    if (uploadedFiles.length === 0) {
      return {
        extractedContent: '',
        processedAt: new Date().toISOString(),
        fileCount: 0,
        status: 'error',
        // Name the actual cause. "Failed to upload any files to Gemini" was
        // true and useless — it never said which file or why.
        error: `Could not send the documents for reading: ${uploadFailures.join('; ')}`,
      };
    }

    // Wait for file processing (Gemini needs time to process uploaded files)
    console.log('[GeminiUrlUpload] Waiting for file processing...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Prepare the prompt
    const prompt = `Please analyze the following documents and:
1. Extract all text content from each document
2. Describe any images, charts, or visual elements found
3. Organize the content by page, marking each section with "Page X" where X is the page number
4. If there are multiple documents, clearly separate them with document names

Format the output as follows:
- Start each document with "=== Document: [filename] ==="
- Mark each page with "--- Page X ---"
- Include all text content from that page
- Describe any images or visual elements found on that page with "[Image Description: ...]"

Please be thorough and capture all content, maintaining the original structure and formatting where possible.`;

    // Create parts from uploaded files
    const fileParts = uploadedFiles.map(upload => 
      createPartFromUri(upload.uri, upload.mimeType)
    );

    // Generate content with all uploaded files
    console.log(`[GeminiUrlUpload] Starting content generation with ${uploadedFiles.length} files...`);
    const generationStart = Date.now();

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: createUserContent([prompt, ...fileParts]),
      config: {
        temperature: 0.2,
        topK: 20,
        topP: 0.8,
        maxOutputTokens: 32000,
      },
    });

    const generationTime = Date.now() - generationStart;
    console.log(`[GeminiUrlUpload] Content generation completed in ${generationTime}ms`);

    const result = response.text || '';
    const totalTime = Date.now() - startTime;

    console.log(`[GeminiUrlUpload] Total processing time: ${totalTime}ms`);
    console.log(`[GeminiUrlUpload] Extracted content length: ${result.length} characters`);

    return {
      extractedContent: result,
      processedAt: new Date().toISOString(),
      fileCount: uploadedFiles.length,
      status: uploadedFiles.length === files.length ? 'success' : 'partial',
      error: uploadedFiles.length < files.length
        ? `Only ${uploadedFiles.length} of ${files.length} files processed`
        : undefined,
    };
  } catch (error) {
    console.error('[GeminiUrlUpload] Processing error:', error);
    return {
      extractedContent: '',
      processedAt: new Date().toISOString(),
      fileCount: 0,
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}