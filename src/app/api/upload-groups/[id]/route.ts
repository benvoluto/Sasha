import { NextRequest, NextResponse } from 'next/server';
import { del, list } from '@vercel/blob';
import { fetchGroupMetadata } from '@/lib/ontology/group-metadata';
// import { getUserIdentifier } from '@/lib/auth'; // Uncomment if you need per-user validation

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/upload-groups/[id] — one document's full upload-group record.
 * Reads exactly one blob (the list endpoint projects the heavy fields away).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'Group ID is required' }, { status: 400 });

  try {
    const metadata = (await fetchGroupMetadata(id)) as (Record<string, unknown> & { id?: string }) | null;
    if (!metadata) return NextResponse.json({ error: 'document not found', id }, { status: 404 });

    // fetchGroupMetadata already reconciled the processing status from the blob's
    // extracted content.
    const group = { ...metadata, id: metadata.id ?? id };

    return NextResponse.json(
      { success: true, group },
      { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  } catch (error) {
    console.error(`[UploadGroups] GET failed for ${id}:`, error);
    return NextResponse.json(
      { error: 'Failed to fetch document', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // const userIdentifier = await getUserIdentifier(); // Uncomment if you need per-user validation
    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { error: 'Group ID is required' },
        { status: 400 }
      );
    }

    console.log(`Deleting upload group: ${id}`);

    // List all blobs related to this upload group
    const { blobs } = await list({
      prefix: 'upload-groups/',
    });

    // Find blobs to delete (compressed file and metadata)
    const blobsToDelete: string[] = [];
    
    for (const blob of blobs) {
      // Check if this blob belongs to the group we're deleting
      if (blob.pathname.includes(id)) {
        blobsToDelete.push(blob.url);
      }
    }

    // Delete all related blobs
    if (blobsToDelete.length > 0) {
      console.log(`Deleting ${blobsToDelete.length} blobs for group ${id}`);
      await Promise.all(blobsToDelete.map(url => del(url)));
    }

    return NextResponse.json({
      success: true,
      message: `Upload group ${id} deleted successfully`,
      deletedBlobs: blobsToDelete.length,
    });
  } catch (error) {
    console.error('Error deleting upload group:', error);
    return NextResponse.json(
      { 
        error: 'Failed to delete upload group', 
        details: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}