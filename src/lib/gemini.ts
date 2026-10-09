import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri,
} from "@google/genai";
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { processDocumentsServerless } from './gemini-serverless';
import { processDocumentsFromUrls } from './gemini-url-upload';
import { GEMINI_MODEL } from './gemini-model';
import { checkExtraction } from './extracted-text';
import { e2eStubModels } from './e2e/mode';
import { stubGeminiExtraction } from './e2e/stub-models';
import { auditGemini, auditedGenerate, stubGeminiUsage } from './llm/gemini-audit';

// Initialize the Gemini API client
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.warn('GEMINI_API_KEY is not set. Gemini features will be disabled.');
}

const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

export interface GeminiFileUploadResult {
  file: {
    uri: string;
    mimeType: string;
    name: string;
  };
}

export interface GeminiProcessedContent {
  extractedContent: string;
  processedAt: string;
  fileCount: number;
  status: 'success' | 'error' | 'partial';
  error?: string;
}

/**
 * Upload a file to Gemini Files API using the new SDK
 */
export async function uploadFileToGemini(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<GeminiFileUploadResult | null> {
  if (!ai) {
    console.error('[Gemini] API client not initialized');
    return null;
  }

  // Validate buffer
  if (!buffer || buffer.length === 0) {
    console.error(`[Gemini] ERROR: Empty buffer received for file ${filename}`);
    return null;
  }
  
  // Log buffer details
  console.log(`[Gemini] Received buffer for ${filename}:`, {
    size: buffer.length,
    isBuffer: Buffer.isBuffer(buffer),
    firstBytes: buffer.slice(0, 10).toString('hex')
  });

  // If we're in Vercel, use the serverless approach
  if (process.env.VERCEL) {
    console.log('[Gemini] Running in Vercel, using serverless buffer upload');
    const { uploadBufferToGemini } = await import('./gemini-serverless');
    const result = await uploadBufferToGemini(buffer, filename, mimeType);
    if (result) {
      return {
        file: {
          uri: result.uri,
          mimeType: result.mimeType,
          name: result.name,
        },
      };
    }
    return null;
  }

  // For local development, use temp file approach
  let tempFilePath: string | null = null;
  
  try {
    // Write buffer to a temporary file since the SDK expects a file path
    const tempDir = os.tmpdir();
    tempFilePath = path.join(tempDir, `gemini-upload-${Date.now()}-${filename}`);
    await fs.writeFile(tempFilePath, buffer);
    
    // Verify the temp file was written correctly
    const stats = await fs.stat(tempFilePath);
    console.log(`[Gemini] Temp file written:`, {
      path: tempFilePath,
      size: stats.size,
      expectedSize: buffer.length,
      sizeMatch: stats.size === buffer.length
    });
    
    console.log(`[Gemini] Starting upload to Gemini API...`);
    console.log(`[Gemini] Uploading file ${filename} to Gemini API...`);
    console.log(`[Gemini] MIME type: ${mimeType}`);
    console.log(`[Gemini] File size: ${buffer.length} bytes`);
    
    const uploadStart = Date.now();
    
    // Upload file using the new SDK method
    const uploadedFile = await ai.files.upload({
      file: tempFilePath,
      config: { 
        mimeType,
        displayName: filename 
      },
    });
    
    const uploadTime = Date.now() - uploadStart;
    console.log(`[Gemini] File uploaded successfully in ${uploadTime}ms`);
    console.log(`[Gemini] File URI: ${uploadedFile.uri}`);
    console.log(`[Gemini] File name: ${uploadedFile.name}`);
    console.log(`[Gemini] File state: ${uploadedFile.state}`);

    // Wait for file to be processed if needed
    if (uploadedFile.state === "PROCESSING") {
      console.log(`[Gemini] Waiting for file processing...`);
      const processingStart = Date.now();
      
      let file = uploadedFile;
      const maxAttempts = 30;
      let attempts = 0;
      
      while (file.state === "PROCESSING" && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        file = await ai.files.get({ name: uploadedFile.name || '' });
        attempts++;
      }
      
      const processingTime = Date.now() - processingStart;
      
      if (file.state !== "ACTIVE") {
        console.error(`[Gemini] File ${filename} failed to process after ${processingTime}ms. State: ${file.state}`);
        if (file.error) {
          console.error(`[Gemini] Error details:`, file.error);
        }
        return null;
      }
      
      console.log(`[Gemini] File processed successfully in ${processingTime}ms`);
    }

    return {
      file: {
        uri: uploadedFile.uri || '',
        mimeType: uploadedFile.mimeType || mimeType,
        name: uploadedFile.name || '',
      }
    };
    
  } catch (error) {
    console.error(`[Gemini] Error uploading file:`, error);
    console.error(`[Gemini] Error stack:`, error instanceof Error ? error.stack : 'No stack');
    return null;
  } finally {
    // Clean up temporary file
    if (tempFilePath) {
      try {
        await fs.unlink(tempFilePath);
      } catch (err) {
        console.warn(`[Gemini] Could not delete temp file ${tempFilePath}:`, err);
      }
    }
  }
}

/**
 * Process multiple documents through Gemini to extract text and describe images
 */
// New overload for URL-based processing (most efficient)
export async function processDocumentsWithGemini(
  files: Array<{ url: string; name: string; type: string }>
): Promise<GeminiProcessedContent>;

// Original overload for buffer-based processing (fallback)
export async function processDocumentsWithGemini(
  files: Array<{ buffer: Buffer; name: string; type: string }>
): Promise<GeminiProcessedContent>;

// Implementation
export async function processDocumentsWithGemini(
  files: Array<{ buffer?: Buffer; url?: string; name: string; type: string }>
): Promise<GeminiProcessedContent> {
  // e2e runs (never production): a fixture instead of Gemini (src/lib/e2e).
  if (e2eStubModels()) {
    const stub = stubGeminiExtraction(files);
    // Audited like a real read, so the usage dashboard shows Gemini in e2e runs.
    await auditGemini({ kind: 'extract', model: GEMINI_MODEL, usage: stubGeminiUsage(files.map((f) => f.name).join('\n'), stub.extractedContent), latencyMs: 0 });
    return checkExtraction(stub, files);
  }
  // Every backend below can return a "success" whose documents are empty; this
  // turns that into an error (or partial) that names the documents.
  return checkExtraction(await extractWithGemini(files), files);
}

async function extractWithGemini(
  files: Array<{ buffer?: Buffer; url?: string; name: string; type: string }>
): Promise<GeminiProcessedContent> {
  const startTime = Date.now();
  console.log(`[Gemini] Starting document processing for ${files.length} files`);
  console.log(`[Gemini] Environment: ${process.env.NODE_ENV}`);
  console.log(`[Gemini] Is Vercel: ${!!process.env.VERCEL}`);
  console.log(`[Gemini] Function region: ${process.env.VERCEL_REGION || 'local'}`);
  
  // Log details about received files
  console.log('[Gemini] Files to process:');
  files.forEach((file, index) => {
    console.log(`[Gemini] File ${index + 1}:`, {
      name: file.name,
      type: file.type,
      bufferSize: file.buffer ? file.buffer.length : 'NO BUFFER',
      isBuffer: Buffer.isBuffer(file.buffer),
      hasContent: file.buffer && file.buffer.length > 0
    });
  });

  // Check if we have URLs (most efficient approach)
  if (files.length > 0 && files[0].url) {
    const urlFiles = files as Array<{ url: string; name: string; type: string }>;
    // Parallel per-document extraction is the default: uploads and generation run
    // concurrently, file readiness is polled instead of slept through, each
    // document gets its own output budget (so a big packet can't silently
    // truncate against one shared cap), and the "=== Document: ===" markers are
    // emitted deterministically in code rather than requested from the model —
    // which matters because the exclusion evidence splitter keys off them.
    // Set GEMINI_PARALLEL_EXTRACTION=0 to fall back to the single-prompt path.
    if (process.env.GEMINI_PARALLEL_EXTRACTION !== '0') {
      console.log('[Gemini] Using URL-based PARALLEL per-document extraction');
      const { processDocumentsFromUrlsParallel } = await import('./gemini-parallel');
      return processDocumentsFromUrlsParallel(urlFiles);
    }
    console.log('[Gemini] Using URL-based single-prompt extraction (legacy)');
    return processDocumentsFromUrls(urlFiles);
  }
  
  // Use serverless version when running in Vercel with buffers
  if (process.env.VERCEL && files[0].buffer) {
    console.log('[Gemini] Using serverless implementation for Vercel deployment');
    return processDocumentsServerless(files as Array<{ buffer: Buffer; name: string; type: string }>);
  }

  if (!ai) {
    console.error('[Gemini] API not configured - missing API key or initialization failed');
    return {
      extractedContent: '',
      processedAt: new Date().toISOString(),
      fileCount: 0,
      status: 'error',
      error: 'Gemini API not configured'
    };
  }

  try {
    const uploadedFiles: GeminiFileUploadResult[] = [];

    // Upload all files to Gemini
    console.log(`[Gemini] Starting file uploads...`);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`[Gemini] Processing file ${i + 1}/${files.length}: ${file.name}`);
      
      // Determine MIME type
      const mimeType = file.type === 'pdf' || file.type === 'application/pdf' 
        ? 'application/pdf' 
        : file.type === 'docx' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : file.type || 'application/octet-stream';

      const uploadResult = file.buffer ? await uploadFileToGemini(file.buffer, file.name, mimeType) : null;

      if (uploadResult) {
        uploadedFiles.push(uploadResult);
        console.log(`[Gemini] File ${i + 1} uploaded successfully`);
      } else {
        console.error(`[Gemini] Failed to upload file ${i + 1}: ${file.name}`);
      }
    }

    console.log(`[Gemini] Upload phase complete. ${uploadedFiles.length}/${files.length} files uploaded`);

    if (uploadedFiles.length === 0) {
      return {
        extractedContent: '',
        processedAt: new Date().toISOString(),
        fileCount: 0,
        status: 'error',
        error: 'Failed to upload any files to Gemini'
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
      createPartFromUri(upload.file.uri, upload.file.mimeType)
    );

    // Generate content with all uploaded files using the new SDK
    console.log(`[Gemini] Starting content generation with ${uploadedFiles.length} files...`);
    const generationStart = Date.now();

    try {
      const response = await auditedGenerate('extract', GEMINI_MODEL, () => ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: createUserContent([
          prompt,
          ...fileParts
        ]),
      }));
      
      const extractedContent = response.text || '';
      const generationTime = Date.now() - generationStart;

      console.log(`[Gemini] Content generated successfully in ${generationTime}ms`);
      console.log(`[Gemini] Extracted content length: ${extractedContent.length} characters`);

      // Clean up uploaded files (they expire after 48 hours anyway)
      for (const upload of uploadedFiles) {
        try {
          await ai.files.delete({ name: upload.file.name });
          console.log(`[Gemini] Deleted file ${upload.file.name}`);
        } catch (error) {
          // Ignore deletion errors as files auto-expire
          console.log(`[Gemini] Could not delete file ${upload.file.name}:`, error);
        }
      }

      const totalTime = Date.now() - startTime;
      console.log(`[Gemini] Total processing time: ${totalTime}ms`);

      return {
        extractedContent,
        processedAt: new Date().toISOString(),
        fileCount: uploadedFiles.length,
        status: 'success'
      };
    } catch (generationError) {
      console.error(`[Gemini] Content generation failed:`, generationError);
      
      // Try to clean up files even on error
      for (const upload of uploadedFiles) {
        try {
          await ai.files.delete({ name: upload.file.name });
        } catch {
          // Ignore deletion errors
        }
      }
      
      throw generationError;
    }
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[Gemini] Document processing failed after ${totalTime}ms:`, error);
    console.error(`[Gemini] Error type:`, error instanceof Error ? error.name : typeof error);
    console.error(`[Gemini] Error stack:`, error instanceof Error ? error.stack : 'No stack');
    return {
      extractedContent: '',
      processedAt: new Date().toISOString(),
      fileCount: 0,
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
}