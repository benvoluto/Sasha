import { NextRequest, NextResponse } from 'next/server';
import { fetchGroupMetadata } from '@/lib/ontology/group-metadata';
import { getUserIdentifier } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/upload-groups/[id] — one document's full upload-group record.
 * Reads exactly one blob (the list endpoint projects the heavy fields away).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getUserIdentifier())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
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

/**
 * DELETE /api/upload-groups/[id] — retired. Legacy upload groups carry no team,
 * so there is nothing to check a caller against, and any signed-in user could
 * otherwise wipe another team's group. The upload pipeline no longer creates
 * groups; the rest go when workflows move to sources (Phase 6).
 */
export async function DELETE() {
  return NextResponse.json({ error: 'Deleting legacy documents is no longer supported.' }, { status: 410 });
}
