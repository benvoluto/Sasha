import { NextRequest, NextResponse } from 'next/server';
import { getUserIdentifier } from '@/lib/auth';
import { v4 as uuidv4 } from 'uuid';
import { DIRECT_UPLOAD_CONFIG } from '@/lib/upload-strategy';

export const runtime = 'nodejs';

interface PresignRequest {
  files: Array<{
    name: string;
    size: number;
    type: string;
  }>;
}

interface PresignedUrl {
  fileId: string;
  fileName: string;
  uploadUrl: string;
  fields: Record<string, string>;
}

interface PresignResponse {
  groupId: string;
  uploads: PresignedUrl[];
  expiresAt: string;
}

export async function POST(request: NextRequest) {
  try {
    console.log('[Presign] Processing presign request...');
    
    // Get user identity for security
    const userIdentifier = await getUserIdentifier();
    console.log('[Presign] User:', userIdentifier || 'anonymous');

    // Parse request body
    const { files }: PresignRequest = await request.json();
    
    if (!files || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    console.log('[Presign] Files to presign:', files.length);

    // Validate files
    for (const file of files) {
      // Check file size
      if (file.size > DIRECT_UPLOAD_CONFIG.maxFileSize) {
        return NextResponse.json(
          { error: `File ${file.name} exceeds maximum size of ${DIRECT_UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB` },
          { status: 400 }
        );
      }

      // Check file type
      if (!DIRECT_UPLOAD_CONFIG.allowedTypes.includes(file.type)) {
        return NextResponse.json(
          { error: `File ${file.name} has unsupported type: ${file.type}` },
          { status: 400 }
        );
      }
    }

    // Generate group ID and presigned URLs
    const groupId = uuidv4();
    const uploads: PresignedUrl[] = [];
    const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now

    console.log('[Presign] Generated group ID:', groupId);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileId = `${i}-${file.name}`;
      const blobPath = `${DIRECT_UPLOAD_CONFIG.uploadPath}/${groupId}/files/${fileId}`;

      // For Vercel Blob, we'll use the handleUploadUrl approach
      // The actual upload will use @vercel/blob/client with our completion handler
      uploads.push({
        fileId,
        fileName: file.name,
        uploadUrl: '/api/upload/direct', // Our handler endpoint
        fields: {
          groupId,
          fileIndex: i.toString(),
          fileName: file.name,
          fileSize: file.size.toString(),
          fileType: file.type,
          blobPath
        }
      });
    }

    console.log('[Presign] Generated', uploads.length, 'presigned URLs');

    const response: PresignResponse = {
      groupId,
      uploads,
      expiresAt
    };

    return NextResponse.json(response);

  } catch (error) {
    console.error('[Presign] Error generating presigned URLs:', error);
    return NextResponse.json(
      { error: 'Failed to generate upload URLs' },
      { status: 500 }
    );
  }
}