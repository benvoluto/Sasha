import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";
import { GEMINI_MODEL } from './gemini-model';
import { auditedGenerate } from './llm/gemini-audit';

/**
 * Upload file to Gemini using direct API calls (serverless compatible)
 * This bypasses the SDK's filesystem requirement
 */
export async function uploadBufferToGemini(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<{ uri: string; mimeType: string; name: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error('[GeminiServerless] No API key configured');
    return null;
  }

  try {
    console.log(`[GeminiServerless] Starting resumable upload for ${filename}`);
    console.log(`[GeminiServerless] Buffer size: ${buffer.length} bytes`);
    console.log(`[GeminiServerless] MIME type: ${mimeType}`);

    // Step 1: Initialize resumable upload session
    const initResponse = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': buffer.length.toString(),
          'X-Goog-Upload-Header-Content-Type': mimeType,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file: {
            displayName: filename,
          },
        }),
      }
    );

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      console.error('[GeminiServerless] Failed to initialize upload:', errorText);
      throw new Error(`Failed to initialize upload: ${initResponse.status}`);
    }

    // Get the upload URL from the response header
    const uploadUrl = initResponse.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      throw new Error('No upload URL received from Gemini');
    }

    console.log('[GeminiServerless] Got upload URL, uploading buffer...');

    // Step 2: Upload the actual file content
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset': '0',
        'Content-Type': mimeType,
      },
      body: buffer as BodyInit,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('[GeminiServerless] Failed to upload content:', errorText);
      throw new Error(`Failed to upload content: ${uploadResponse.status}`);
    }

    const result = await uploadResponse.json();
    console.log('[GeminiServerless] Upload successful:', result);

    // The response should contain the file details
    if (result.file) {
      return {
        uri: result.file.uri,
        mimeType: result.file.mimeType || mimeType,
        name: result.file.name || filename,
      };
    }

    return null;
  } catch (error) {
    console.error('[GeminiServerless] Error uploading buffer:', error);
    return null;
  }
}

/**
 * Process documents with Gemini using direct buffer upload (serverless compatible)
 */
export async function processDocumentsServerless(
  files: Array<{ buffer: Buffer; name: string; type: string }>
): Promise<{
  extractedContent: string;
  processedAt: string;
  fileCount: number;
  status: 'success' | 'error' | 'partial';
  error?: string;
}> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.error('[GeminiServerless] API key not configured');
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
  
  console.log(`[GeminiServerless] Starting processing for ${files.length} files`);
  console.log(`[GeminiServerless] Environment: ${process.env.NODE_ENV}`);
  console.log(`[GeminiServerless] Is Vercel: ${!!process.env.VERCEL}`);

  try {
    const uploadedFiles: Array<{ uri: string; mimeType: string }> = [];

    // Upload all files using direct API
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`[GeminiServerless] Processing file ${i + 1}/${files.length}: ${file.name}`);

      // Validate buffer
      if (!file.buffer || file.buffer.length === 0) {
        console.error(`[GeminiServerless] Empty buffer for ${file.name}`);
        continue;
      }

      // Determine MIME type
      const mimeType = 
        file.type === 'pdf' || file.type === 'application/pdf'
          ? 'application/pdf'
          : file.type === 'docx' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : file.type || 'application/octet-stream';

      const uploadResult = await uploadBufferToGemini(file.buffer, file.name, mimeType);

      if (uploadResult) {
        uploadedFiles.push({
          uri: uploadResult.uri,
          mimeType: uploadResult.mimeType,
        });
        console.log(`[GeminiServerless] File ${i + 1} uploaded successfully`);
      } else {
        console.error(`[GeminiServerless] Failed to upload file ${i + 1}: ${file.name}`);
      }
    }

    console.log(`[GeminiServerless] Upload phase complete. ${uploadedFiles.length}/${files.length} files uploaded`);

    if (uploadedFiles.length === 0) {
      return {
        extractedContent: '',
        processedAt: new Date().toISOString(),
        fileCount: 0,
        status: 'error',
        error: 'Failed to upload any files to Gemini',
      };
    }

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
    console.log(`[GeminiServerless] Starting content generation with ${uploadedFiles.length} files...`);
    const generationStart = Date.now();

    const response = await auditedGenerate('extract', GEMINI_MODEL, () => ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: createUserContent([prompt, ...fileParts]),
      config: {
        temperature: 0.2,
        topK: 20,
        topP: 0.8,
        maxOutputTokens: 32000,
      },
    }));

    const generationTime = Date.now() - generationStart;
    console.log(`[GeminiServerless] Content generation completed in ${generationTime}ms`);

    const result = response.text || '';
    const totalTime = Date.now() - startTime;

    console.log(`[GeminiServerless] Total processing time: ${totalTime}ms`);
    console.log(`[GeminiServerless] Extracted content length: ${result.length} characters`);

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
    console.error('[GeminiServerless] Processing error:', error);
    return {
      extractedContent: '',
      processedAt: new Date().toISOString(),
      fileCount: 0,
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}