import { NextRequest } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { getUserIdentifier } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    console.log('[DirectUpload] Processing direct upload...');
    
    // Get user identity for security
    const userIdentifier = await getUserIdentifier();
    console.log('[DirectUpload] User:', userIdentifier || 'anonymous');

    // Handle the upload using Vercel Blob's client handler
    const body = await request.json();
    
    console.log('[DirectUpload] Upload body:', {
      pathname: body.pathname,
      contentType: body.contentType,
      contentLength: body.contentLength
    });

    const jsonResponse = await handleUpload({
      body: body as HandleUploadBody,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        console.log('[DirectUpload] Generating token for:', pathname);
        console.log('[DirectUpload] Client payload:', clientPayload);
        
        // Validate the upload request
        const payload = typeof clientPayload === 'string' ? JSON.parse(clientPayload) : clientPayload || {};
        const { groupId, fileName, fileSize, fileType } = payload;
        
        if (!groupId || !fileName) {
          throw new Error('Missing required upload parameters');
        }

        // Validate the blob path follows the expected group structure
        const expectedPathPattern = /^upload-groups\/[^\/]+\/files\/\d+-[^\/]+$/;
        const blobPath = payload.blobPath;
        
        if (!blobPath || !expectedPathPattern.test(blobPath)) {
          throw new Error(`Invalid blob path structure: ${blobPath}`);
        }
        
        console.log('[DirectUpload] Validation passed for:', { groupId, fileName, fileSize, fileType, blobPath });
        
        return {
          allowedContentTypes: [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          ],
          tokenPayload: JSON.stringify({
            groupId,
            fileName,
            uploadedBy: userIdentifier || 'anonymous',
            uploadedAt: new Date().toISOString()
          })
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log('[DirectUpload] Upload completed:', blob.url);
        console.log('[DirectUpload] Blob details:', blob);
        
        try {
          const payload = JSON.parse(tokenPayload || '{}');
          console.log('[DirectUpload] Token payload:', payload);
          
          // Store the upload completion info for later processing
          // We'll trigger processing in the completion endpoint
          console.log('[DirectUpload] Upload success for group:', payload.groupId);
          
        } catch (error) {
          console.error('[DirectUpload] Error in upload completion:', error);
          // Don't throw here as it would fail the upload
        }
      },
    });

    return Response.json(jsonResponse);

  } catch (error) {
    console.error('[DirectUpload] Error handling direct upload:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 400 }
    );
  }
}