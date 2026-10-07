import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { getUserIdentifier } from '@/lib/auth';
import { processDocumentsWithGemini } from '@/lib/gemini';
import { fetchBlobBuffer } from '@/lib/blob-utils';
import { downloadBlobContent } from '@/lib/blob-download';
import { after } from 'next/server';
import { hasReadableText } from '@/lib/extracted-text';
import { fetchGroupMetadata } from '@/lib/ontology/group-metadata';
import { friendlyProcessingError, writeProcessingError } from '@/lib/processing-status';
import { runChosenWorkflow, workflowChoiceFor, type AutoWorkflowChoice } from '@/lib/workflow/auto-run';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface CompletionRequest {
  groupId: string;
  uploadedFiles: Array<{
    name: string;
    url: string;
    size: number;
    type: string;
  }>;
  /** The workflow to run once the documents are read; "none" to run none. */
  workflowId?: string;
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
}

export async function POST(request: NextRequest) {
  // The background work below shares this invocation's time limit; a workflow
  // run started after extraction needs to know how much of it is left.
  const functionStart = Date.now();
  try {
    console.log('[UploadComplete] Processing upload completion...');
    
    // Get user identity
    const userEmail = await getUserIdentifier();
    console.log('[UploadComplete] User:', userEmail || 'anonymous');

    const { groupId, uploadedFiles, workflowId }: CompletionRequest = await request.json();
    
    if (!groupId || !uploadedFiles || uploadedFiles.length === 0) {
      return NextResponse.json({ error: 'Invalid completion request' }, { status: 400 });
    }

    console.log('[UploadComplete] Processing group:', groupId);
    console.log('[UploadComplete] Files:', uploadedFiles.length);
    
    // First, verify that the uploaded files actually exist in blob storage
    console.log('[UploadComplete] Verifying uploaded files exist in blob storage...');
    for (const file of uploadedFiles) {
      try {
        const response = await fetch(file.url, { method: 'HEAD' });
        console.log(`[UploadComplete] File ${file.name} HEAD response:`, {
          status: response.status,
          ok: response.ok,
          contentLength: response.headers.get('content-length'),
          contentType: response.headers.get('content-type')
        });
        
        if (!response.ok) {
          console.error(`[UploadComplete] WARNING: File ${file.name} not accessible at ${file.url}`);
        }
      } catch (error) {
        console.error(`[UploadComplete] Error checking file ${file.name}:`, error);
      }
    }

    // Download files for content processing
    console.log('[UploadComplete] Downloading files for processing...');
    console.log('[UploadComplete] Files to download:', uploadedFiles.map(f => ({ name: f.name, url: f.url, size: f.size })));
    
    const fileBuffers = await Promise.all(
      uploadedFiles.map(async (file, index) => {
        console.log(`[UploadComplete] Downloading file ${index + 1}/${uploadedFiles.length}: ${file.name} from ${file.url}`);
        console.log(`[UploadComplete] File details:`, { 
          name: file.name, 
          url: file.url, 
          size: file.size, 
          type: file.type 
        });
        
        let buffer: Buffer;
        try {
          // Try fetchBlobBuffer first
          buffer = await fetchBlobBuffer(file.url);
          console.log(`[UploadComplete] Downloaded ${file.name}: ${buffer.length} bytes (via fetchBlobBuffer)`);
        } catch (fetchError) {
          console.log(`[UploadComplete] fetchBlobBuffer failed, trying downloadBlobContent:`, fetchError);
          
          // Fallback to download API
          try {
            // Extract pathname from URL
            const url = new URL(file.url);
            let pathname = url.pathname;
            if (pathname.startsWith('/')) {
              pathname = pathname.substring(1);
            }
            
            buffer = await downloadBlobContent(pathname);
            console.log(`[UploadComplete] Downloaded ${file.name}: ${buffer.length} bytes (via downloadBlobContent)`);
          } catch (downloadError) {
            console.error(`[UploadComplete] Both download methods failed for ${file.name}`);
            console.error(`[UploadComplete] Original error:`, fetchError);
            console.error(`[UploadComplete] Fallback error:`, downloadError);
            throw new Error(`Failed to download file: ${file.name} - ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`);
          }
        }
          
        // Verify buffer content
        if (buffer.length === 0) {
          console.error(`[UploadComplete] WARNING: Downloaded empty buffer for ${file.name}`);
        } else if (buffer.length !== file.size) {
          console.warn(`[UploadComplete] Size mismatch for ${file.name}: expected ${file.size}, got ${buffer.length}`);
        }
        
        const extension = file.name.split('.').pop()?.toLowerCase();
        const fileType = extension as 'pdf' | 'docx';
        
        console.log(`[UploadComplete] File ${file.name} prepared for processing:`, {
          bufferSize: buffer.length,
          extension,
          type: fileType
        });
        
        return {
          buffer,
          name: file.name,
          type: fileType
        };
      })
    );

    // Create metadata
    const totalSize = uploadedFiles.reduce((sum, file) => sum + file.size, 0);
    const metadata: UploadGroupMetadata = {
      id: groupId,
      uploadDate: new Date().toISOString(),
      userId: userEmail || undefined,
      userEmail: userEmail || undefined,
      files: uploadedFiles.map((file) => ({
        name: file.name,
        url: file.url,
        size: file.size,
        type: file.type,
      })),
      totalSize,
      geminiProcessing: {
        status: 'processing'
      },
      autoWorkflow: await workflowChoiceFor(workflowId),
    };

    // Save metadata to blob storage
    const metadataPath = `upload-groups/${groupId}/metadata.json`;
    console.log('[UploadComplete] Saving metadata to:', metadataPath);
    
    const metadataBlob = await put(metadataPath, JSON.stringify(metadata), {
      access: 'public',
      contentType: 'application/json',
      allowOverwrite: true,
    });

    console.log('[UploadComplete] Metadata saved:', metadataBlob.url);

    // Start async processing (Gemini extraction)
    console.log('[UploadComplete] Starting async processing for group:', groupId);
    
    // Run extraction after the response via `after` so Vercel keeps the function
    // alive (a bare fire-and-forget promise can be killed once we respond),
    // leaving the upload stuck on "processing").
    if (process.env.VERCEL) {
      console.log('[UploadComplete] Using URL-based processing for Vercel');
      const fileUrls = uploadedFiles.map(file => ({
        url: file.url,
        name: file.name,
        type: file.name.split('.').pop()?.toLowerCase() || file.type
      }));

      after(async () => {
        try {
          await processDocumentsAsyncFromUrls(groupId, fileUrls, metadata, functionStart);
        } catch (error) {
          console.error('[UploadComplete] Async URL processing failed:', error);
          await writeProcessingError(groupId, metadata, friendlyProcessingError(error));
        }
      });
    } else {
      console.log('[UploadComplete] Using buffer-based processing for local dev');
      after(async () => {
        try {
          await processDocumentsAsync(groupId, fileBuffers, metadata, functionStart);
        } catch (error) {
          console.error('[UploadComplete] Async processing failed:', error);
          await writeProcessingError(groupId, metadata, friendlyProcessingError(error));
        }
      });
    }

    return NextResponse.json({
      success: true,
      groupId,
      metadataUrl: metadataBlob.url,
      filesUploaded: uploadedFiles.length
    });

  } catch (error) {
    console.error('[UploadComplete] Error processing completion:', error);
    return NextResponse.json(
      { error: 'Failed to complete upload processing' },
      { status: 500 }
    );
  }
}

// URL-based async processing function (most efficient for Vercel)
async function processDocumentsAsyncFromUrls(
  groupId: string,
  fileUrls: Array<{ url: string; name: string; type: string }>,
  initialMetadata: UploadGroupMetadata,
  functionStart: number,
) {
  try {
    console.log('[AsyncProcess] Starting URL-based async processing for group:', groupId);

    // Process documents with Gemini using URLs
    let extractedContent: string;
    let updatedMetadata: UploadGroupMetadata;
    
    try {
      console.log('[AsyncProcess] Processing with Gemini using URLs...');
      console.log('[AsyncProcess] File URLs count:', fileUrls.length);
      console.log('[AsyncProcess] File URLs info:', fileUrls.map(f => ({ name: f.name, type: f.type, url: f.url.substring(0, 100) + '...' })));
      
      const geminiTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('Gemini processing timeout after 240s'));
        }, 240000);
      });
      
      const heavyExtraction = processDocumentsWithGemini(fileUrls);
      const geminiResult = await Promise.race([
        heavyExtraction,
        geminiTimeout
      ]);
      extractedContent = geminiResult.extractedContent;
      console.log('[AsyncProcess] Gemini URL processing completed successfully');
      
      // Record the REAL outcome. processDocumentsFromUrls returns 'error' when
      // every file failed and 'partial' when only some did; writing 'completed'
      // regardless made a failed extraction present as a finished, empty upload.
      const geminiProcessing = {
        status: geminiResult.status === 'success' ? ('completed' as const) : geminiResult.status,
        extractedContent,
        ...(geminiResult.error ? { error: geminiResult.error } : {}),
        processedAt: new Date().toISOString(),
        fileCount: fileUrls.length
      };
      updatedMetadata = {
        ...initialMetadata,
        geminiProcessing
      };

      // Authoritative completion write: re-read the freshest blob and merge the
      // terminal fields on top, so completion is the final writer and wins.
      await finalizeMetadata(groupId, updatedMetadata, geminiProcessing);
      // Then the workflow chosen at upload, if the documents were read.
      if (geminiProcessing.status !== 'error' && hasReadableText(extractedContent)) {
        await runChosenWorkflow(groupId, initialMetadata.autoWorkflow, functionStart, maxDuration);
      }

    } catch (geminiError) {
      console.error('[AsyncProcess] Gemini URL processing error:', geminiError);
      
      const errorMetadata = {
        ...initialMetadata,
        geminiProcessing: {
          status: 'error' as const,
          error: geminiError instanceof Error ? geminiError.message : 'Unknown error',
          processedAt: new Date().toISOString(),
          fileCount: fileUrls.length
        }
      };
      
      await updateMetadata(groupId, errorMetadata);
      return;
    }


  } catch (error) {
    console.error('[AsyncProcess] Unexpected error in URL-based async processing:', error);
  }
}

// Async processing function (same logic as original upload route)
async function processDocumentsAsync(
  groupId: string, 
  fileBuffers: Array<{ buffer: Buffer; name: string; type: 'pdf' | 'docx' }>,
  initialMetadata: UploadGroupMetadata,
  functionStart: number,
) {
  try {
    console.log('[AsyncProcess] Starting async processing for group:', groupId);

    // Process documents with Gemini
    let extractedContent: string;
    let updatedMetadata: UploadGroupMetadata;
    
    try {
      console.log('[AsyncProcess] Processing with Gemini...');
      console.log('[AsyncProcess] File buffers count:', fileBuffers.length);
      console.log('[AsyncProcess] File buffers info:', fileBuffers.map(f => ({ name: f.name, type: f.type, size: f.buffer.length })));
      
      // Add timeout to Gemini processing to prevent hanging
      const geminiTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('Gemini processing timeout after 240s'));
        }, 240000);
      });
      
      const heavyExtraction = processDocumentsWithGemini(fileBuffers);
      const geminiResult = await Promise.race([
        heavyExtraction,
        geminiTimeout
      ]);
      extractedContent = geminiResult.extractedContent;
      console.log('[AsyncProcess] Gemini processing completed successfully');
      
      // Record the real outcome, as the URL path does: an empty or failed read is
      // an error the card shows, not a finished upload.
      const geminiProcessing = {
        status: geminiResult.status === 'success' ? ('completed' as const) : geminiResult.status,
        extractedContent,
        ...(geminiResult.error ? { error: geminiResult.error } : {}),
        processedAt: new Date().toISOString(),
        fileCount: fileBuffers.length
      };
      updatedMetadata = {
        ...initialMetadata,
        geminiProcessing
      };

      await finalizeMetadata(groupId, updatedMetadata, geminiProcessing);
      if (geminiProcessing.status !== 'error' && hasReadableText(extractedContent)) {
        await runChosenWorkflow(groupId, initialMetadata.autoWorkflow, functionStart, maxDuration);
      }

    } catch (geminiError) {
      console.error('[AsyncProcess] Gemini processing error:', geminiError);
      
      const errorMetadata = {
        ...initialMetadata,
        geminiProcessing: {
          status: 'error' as const,
          error: geminiError instanceof Error ? geminiError.message : 'Unknown error',
          processedAt: new Date().toISOString(),
          fileCount: fileBuffers.length
        }
      };
      
      await updateMetadata(groupId, errorMetadata);
      return; // Don't proceed if Gemini failed
    }


  } catch (error) {
    console.error('[AsyncProcess] Unexpected error in async processing:', error);
  }
}

async function updateMetadata(groupId: string, metadata: UploadGroupMetadata) {
  try {
    const metadataPath = `upload-groups/${groupId}/metadata.json`;
    await put(metadataPath, JSON.stringify(metadata), {
      access: 'public',
      contentType: 'application/json',
      allowOverwrite: true,
    });
    console.log('[AsyncProcess] Metadata updated for group:', groupId);
  } catch (error) {
    console.error('[AsyncProcess] Error updating metadata:', error);
  }
}

/**
 * The authoritative completion write. Re-reads the freshest metadata (so it keeps
 * whatever else was written meanwhile, e.g. a summary note) and merges the
 * terminal fields (status / extractedContent) on top.
 * Runs LAST in the async flow so it is the final writer and can't be clobbered by
 * an earlier stale-read write. Falls back to the in-memory copy if the re-read
 * fails.
 */
async function finalizeMetadata(
  groupId: string,
  fallback: UploadGroupMetadata,
  geminiProcessing: UploadGroupMetadata['geminiProcessing'],
) {
  const current = (await fetchGroupMetadata(groupId)) as unknown as UploadGroupMetadata | null;
  const base = current ?? fallback;
  const merged: UploadGroupMetadata = {
    ...base,
    geminiProcessing,
  };
  await updateMetadata(groupId, merged);
}
