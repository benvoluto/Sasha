import { NextRequest, NextResponse } from 'next/server';
import { put, del } from '@vercel/blob';
import { v4 as uuidv4 } from 'uuid';
import { after } from 'next/server';
import { getUserIdentifier } from '@/lib/auth';
import { processDocumentsWithGemini } from '@/lib/gemini';
import { hasReadableText } from '@/lib/extracted-text';
import { withTimeout, friendlyProcessingError, writeProcessingError } from '@/lib/processing-status';
import { runChosenWorkflow, workflowChoiceFor, type AutoWorkflowChoice } from '@/lib/workflow/auto-run';

// Overall budget for the background extraction chain. Kept under the function's
// maxDuration so a terminal error is written before the platform kills us.
const EXTRACTION_TIMEOUT_MS = 240000; // 4 min, under the 300s function budget

export const runtime = 'nodejs';
export const maxDuration = 300; // Vercel Pro ceiling

// Log configuration at module load time
console.log('[Upload] API Route Configuration:');
console.log('[Upload] - Runtime:', runtime);
console.log('[Upload] - Max Duration:', maxDuration, 'seconds');
console.log('[Upload] - Environment:', process.env.NODE_ENV);
console.log('[Upload] - Vercel Region:', process.env.VERCEL_REGION || 'local');

interface FileData {
  name: string;
  buffer: Buffer;
  type: 'pdf' | 'docx';
  size: number;
}

interface UploadGroupMetadata {
  id: string;
  autoWorkflow?: AutoWorkflowChoice | null;
  uploadDate: string;
  userId?: string;
  userEmail?: string;
  files: Array<{
    name: string;
    url: string;
    size: number;
    type: string;
  }>;
  totalSize: number;
  geminiProcessing?: {
    status: 'processing' | 'completed' | 'error' | 'partial';
    extractedContent?: string;
    processedAt?: string;
    error?: string;
    fileCount?: number;
  };
  foundDocuments?: Array<{
    type: string;
    found: boolean;
    startPage?: number;
  }>;
}

export async function POST(request: NextRequest) {
  // The background work below shares this invocation's time limit (see runChosenWorkflow).
  const functionStart = Date.now();
  console.log('[Upload] Starting upload process');
  console.log('[Upload] Environment:', process.env.NODE_ENV);
  console.log('[Upload] Has VERCEL_BLOB_BASE_URL:', !!process.env.VERCEL_BLOB_BASE_URL);
  
  try {
    // Get user identity
    console.log('[Upload] Getting user identity...');
    const userIdentifier = await getUserIdentifier();

    // Parse form data
    console.log('[Upload] Parsing form data...');
    const formData = await request.formData();
    const fileCount = parseInt(formData.get('fileCount') as string);
    console.log('[Upload] File count:', fileCount);

    if (!fileCount || fileCount === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    // Extract files from form data
    const files: FileData[] = [];
    for (let i = 0; i < fileCount; i++) {
      const file = formData.get(`file_${i}`) as File;
      if (file) {
        const buffer = Buffer.from(await file.arrayBuffer());
        const extension = file.name.split('.').pop()?.toLowerCase();

        if (extension !== 'pdf' && extension !== 'docx') {
          return NextResponse.json(
            { error: `Invalid file type: ${extension}` },
            { status: 400 }
          );
        }

        files.push({
          name: file.name,
          buffer,
          type: extension as 'pdf' | 'docx',
          size: buffer.length,
        });
      }
    }

    if (files.length === 0) {
      return NextResponse.json({ error: 'No valid files found' }, { status: 400 });
    }

    // Create metadata for the upload group
    const groupId = uuidv4();
    const uploadDate = new Date().toISOString();

    // Upload each file individually to Vercel Blob
    console.log('[Upload] Starting file uploads...');
    const uploadedFiles = [];
    let totalSize = 0;
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const blobName = `upload-groups/${groupId}/files/${i}-${file.name}`;
      
      console.log(`[Upload] Uploading file ${i + 1}/${files.length}: ${file.name}`);
      console.log('[Upload] File size:', file.size, 'bytes');
      
      try {
        const fileUploadStart = Date.now();
        
        // Add timeout wrapper for each file upload
        const uploadPromise = put(blobName, file.buffer, {
          access: 'public',
          contentType: file.type || 'application/octet-stream',
        });
        
        // Create a timeout promise
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('File upload timeout after 30 seconds')), 30000);
        });
        
        // Race between upload and timeout
        const fileBlob = await Promise.race([uploadPromise, timeoutPromise]) as Awaited<ReturnType<typeof put>>;
        
        const fileUploadTime = Date.now() - fileUploadStart;
        console.log(`[Upload] Successfully uploaded ${file.name} in ${fileUploadTime}ms`);
        
        uploadedFiles.push({
          name: file.name,
          url: fileBlob.url,
          size: file.size,
          type: file.type,
        });
        
        totalSize += file.size;
      } catch (fileUploadError) {
        console.error(`[Upload] Failed to upload file ${file.name}:`, fileUploadError);
        throw new Error(`Failed to upload file ${file.name}: ${fileUploadError instanceof Error ? fileUploadError.message : String(fileUploadError)}`);
      }
    }
    
    // Create and upload metadata
    const metadata: UploadGroupMetadata = {
      id: groupId,
      uploadDate,
      files: uploadedFiles,
      userId: userIdentifier || undefined,
      userEmail: userIdentifier || undefined,
      totalSize,
      geminiProcessing: {
        status: 'processing',
      },
      autoWorkflow: await workflowChoiceFor(formData.get('workflowId')),
    };
    
    console.log('[Upload] Uploading metadata...');
    const metadataBlob = await put(
      `upload-groups/${groupId}/metadata.json`,
      JSON.stringify(metadata, null, 2),
      {
        access: 'public',
        contentType: 'application/json',
      }
    );
    
    console.log('[Upload] Metadata uploaded:', metadataBlob.url);

    // Metadata has already been created and uploaded above
    // Use the existing metadata and metadataBlob variables
    
    console.log('[Upload] Upload successful:', groupId);
    console.log('[Upload] Files uploaded:', files.length);
    console.log('[Upload] Total size:', totalSize, 'bytes');

    // Start Gemini processing in the background (non-blocking)
    console.log(`[Upload] Starting background Gemini processing for group ${groupId}`);
    console.log(`[Upload] Using async processing - response will be sent immediately`);
    
    // Run the extraction after the response is sent. `after` keeps the function
    // alive on Vercel (setImmediate work could be killed once we responded),
    // and the timeout guarantees a terminal status even if extraction hangs.
    after(async () => {
     try {
      const heavyExtraction = processDocumentsWithGemini(files);
      await withTimeout(heavyExtraction, EXTRACTION_TIMEOUT_MS, 'Gemini extraction').then(async (geminiResult) => {
        try {
          console.log(`[Upload] Gemini processing completed for group ${groupId}`);
          console.log(`[Upload] Gemini status: ${geminiResult.status}`);
          console.log(`[Upload] Files processed: ${geminiResult.fileCount}`);
          console.log(`[Upload] Has extracted content: ${!!geminiResult.extractedContent}`);
        
        // Update metadata with Gemini results
        // eslint-disable-next-line prefer-const
        let updatedMetadata: UploadGroupMetadata = {
          ...metadata,
          geminiProcessing: {
            status: geminiResult.status === 'success' ? 'completed' : geminiResult.status,
            extractedContent: geminiResult.extractedContent,
            processedAt: geminiResult.processedAt,
            error: geminiResult.error,
            fileCount: geminiResult.fileCount,
          }
        };

        // Delete the old metadata blob first
        try {
          await del(metadataBlob.url);
        } catch (deleteError) {
          console.log(`Could not delete old metadata blob: ${deleteError}`);
        }

        // Update the metadata blob with Gemini results using NEW path structure
        await put(
          `upload-groups/${groupId}/metadata.json`,
          JSON.stringify(updatedMetadata),
          {
            access: 'public',
            contentType: 'application/json',
            allowOverwrite: true,
          }
        );

        console.log(`Metadata updated with Gemini results for group ${groupId}`);

        // Run the workflow chosen at upload once the documents are read.
        if (updatedMetadata.geminiProcessing?.status === 'completed' && hasReadableText(geminiResult.extractedContent)) {
          await runChosenWorkflow(groupId, metadata.autoWorkflow, functionStart, maxDuration);
        }

        } catch (error) {
          console.error(`[Upload] Failed to update metadata with Gemini results for group ${groupId}:`, error);
          console.error(`[Upload] Error type:`, error instanceof Error ? error.name : typeof error);
          console.error(`[Upload] Error stack:`, error instanceof Error ? error.stack : 'No stack');
        }
      });
     } catch (error) {
        console.error(`[Upload] Gemini processing failed for group ${groupId}:`, error);
        await writeProcessingError(groupId, metadata, friendlyProcessingError(error));
     }
    });


    return NextResponse.json({
      success: true,
      groupId,
      uploadDate,
      filesCount: files.length,
      totalSize,
      blobUrl: metadataBlob.url,
      metadataUrl: metadataBlob.url,
      geminiProcessing: {
        status: 'processing',
        message: 'Document content extraction started with Gemini AI'
      }
    });
  } catch (error) {
    console.error('[Upload] Upload error:', error);
    console.error('[Upload] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    console.error('[Upload] Full error object:', JSON.stringify(error, null, 2));
    
    // Log environment variables status for debugging
    console.log('[Upload] Debug - Environment variables check:');
    console.log('[Upload] - NODE_ENV:', process.env.NODE_ENV);
    console.log('[Upload] - Has VERCEL_BLOB_BASE_URL:', !!process.env.VERCEL_BLOB_BASE_URL);
    console.log('[Upload] - Has BLOB_READ_WRITE_TOKEN:', !!process.env.BLOB_READ_WRITE_TOKEN);
    
    return NextResponse.json(
      { error: 'Upload failed', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}